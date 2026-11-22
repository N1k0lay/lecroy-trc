const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TrcFormatError, readTrcHeader, getSampleRangeForTime, getSampleByteRange, decodeSamples,
  getSegmentTimingByteRange, decodeSegmentTiming,
} = require('lecroy-trc');

function fixture({ littleEndian = true, bytesPerSample = 2, timings = [] } = {}) {
  const prefixLength = 11;
  const descriptorLength = 350;
  const userTextLength = 3;
  const raw = [90, 5, -7, 2, 2, 2, 1, -90];
  const timingOffset = prefixLength + descriptorLength + userTextLength;
  const dataOffset = timingOffset + 16 * timings.length;
  const dataLength = raw.length * bytesPerSample;
  const buffer = Buffer.alloc(dataOffset + dataLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset + prefixLength);
  const short = (offset, value) => view.setInt16(offset, value, littleEndian);
  const int = (offset, value) => view.setInt32(offset, value, littleEndian);
  buffer.write('WAVEDESC', prefixLength);
  buffer.write('LECROY_2_3', prefixLength + 16);
  short(32, bytesPerSample - 1);
  short(34, littleEndian ? 1 : 0);
  int(36, descriptorLength);
  int(40, userTextLength);
  int(48, 16 * timings.length);
  int(60, dataLength);
  buffer.write('TEST SCOPE', prefixLength + 76);
  view.setUint32(92, 0xf0000000, littleEndian);
  int(116, raw.length);
  int(124, 1);
  int(128, 6);
  int(136, 1);
  int(144, timings.length || 1);
  view.setFloat32(156, 0.5, littleEndian);
  view.setFloat32(160, 1, littleEndian);
  view.setFloat32(176, 0.25, littleEndian);
  view.setFloat64(180, -1, littleEndian);
  buffer.write('V', prefixLength + 196);
  buffer.write('s', prefixLength + 244);
  view.setFloat64(296, 12.5, littleEndian);
  view.setUint8(304, 30);
  view.setUint8(305, 14);
  view.setUint8(306, 16);
  view.setUint8(307, 5);
  short(308, 2024);
  short(344, 3);
  timings.forEach(([time, offset], index) => {
    const entry = timingOffset - prefixLength + index * 16;
    view.setFloat64(entry, time, littleEndian);
    view.setFloat64(entry + 8, offset, littleEndian);
  });
  raw.forEach((value, index) => {
    const offset = dataOffset - prefixLength + index * bytesPerSample;
    if (bytesPerSample === 1) view.setInt8(offset, value);
    else short(offset, value);
  });
  return { buffer, view, timingOffset, dataOffset };
}

for (const littleEndian of [true, false]) {
  for (const bytesPerSample of [1, 2]) {
    test(`reads ${bytesPerSample * 8}-bit ${littleEndian ? 'LE' : 'BE'} samples`, () => {
      const { buffer, dataOffset } = fixture({ littleEndian, bytesPerSample });
      const header = readTrcHeader(buffer.subarray(0, 357));
      assert.equal(header.instrumentName, 'TEST SCOPE');
      assert.equal(header.instrumentNumber, 0xf0000000);
      assert.equal(header.waveSource, 3);
      assert.equal(header.horizontalUnit, 's');
      assert.equal(header.verticalUnit, 'V');
      assert.deepEqual(header.trigger, {
        year: 2024, month: 5, day: 16, hour: 14, minute: 30, second: 12.5,
      });
      const range = { start: 2, endExclusive: 5 };
      const span = getSampleByteRange(header, range);
      assert.deepEqual(span, {
        start: dataOffset + 2 * bytesPerSample,
        endExclusive: dataOffset + 5 * bytesPerSample,
      });
      const { times, values } = decodeSamples(buffer.subarray(span.start, span.endExclusive), header, range);
      assert.deepEqual([...times], [-0.5, -0.25, 0]);
      assert.deepEqual([...values], [-4.5, 0, 0]);
    });
  }
}

test('keeps temporal order, skips padding and emits a flat bucket once', () => {
  const { buffer } = fixture();
  const header = readTrcHeader(buffer);
  const span = getSampleByteRange(header);
  const samples = buffer.subarray(span.start, span.endExclusive);
  const { times, values } = decodeSamples(samples, header, undefined, 3);
  assert.deepEqual([...times], [-0.75, -0.5, -0.25, 0.25, 0.5]);
  assert.deepEqual([...values], [1.5, -4.5, 0, 0, -0.5]);
  assert.throws(() => decodeSamples(samples.subarray(1), header), TrcFormatError);
  assert.throws(() => decodeSamples(samples, header, undefined, 0), RangeError);
  assert.throws(() => getSampleByteRange(header, { start: 0, endExclusive: 4 }), RangeError);
  assert.throws(() => getSampleByteRange(header, { start: 2.5, endExclusive: 4 }), RangeError);
  const empty = decodeSamples(Buffer.alloc(0), header, { start: 2, endExclusive: 2 });
  assert.equal(empty.times.length, 0);
  assert.equal(empty.values.length, 0);
});

test('rejects invalid descriptors and keeps sequence metadata accessible', () => {
  const { buffer, view } = fixture();
  assert.throws(() => readTrcHeader(buffer.subarray(0, 356)), TrcFormatError);
  assert.throws(() => readTrcHeader(Buffer.alloc(500)), TrcFormatError);
  const wrongTemplate = Buffer.from(buffer);
  wrongTemplate.write('LECROY_9_9', 27);
  assert.throws(() => readTrcHeader(wrongTemplate), /Unsupported WAVEDESC template/);
  view.setInt32(144, 2, true);
  const header = readTrcHeader(buffer);
  assert.equal(header.segmentCount, 2);
  assert.throws(() => getSampleByteRange(header), /Unsupported waveform/);
  view.setInt32(40, -1, true);
  assert.throws(() => readTrcHeader(buffer), /block lengths/);
});

for (const littleEndian of [true, false]) {
  test(`reads individual Sequence segments and timestamps (${littleEndian ? 'LE' : 'BE'})`, () => {
    const { buffer, dataOffset, timingOffset } = fixture({
      littleEndian, bytesPerSample: littleEndian ? 2 : 1,
      timings: [[0, -2], [3, -0.5]],
    });
    const header = readTrcHeader(buffer.subarray(0, 357));
    const { bytesPerSample } = header;
    assert.equal(header.isSequence, true);
    assert.equal(header.supportsSampleReading, true);
    assert.equal(header.samplesPerSegment, 4);
    assert.throws(() => getSampleByteRange(header), /requires a segment index/);
    assert.throws(() => getSampleByteRange(header, undefined, -1), RangeError);
    assert.throws(() => getSegmentTimingByteRange(header, 2), RangeError);

    const firstSpan = getSampleByteRange(header, undefined, 0);
    assert.deepEqual(firstSpan, { start: dataOffset + bytesPerSample, endExclusive: dataOffset + 4 * bytesPerSample });
    const secondTiming = getSegmentTimingByteRange(header, 1);
    assert.deepEqual(secondTiming, { start: timingOffset + 16, endExclusive: dataOffset });
    const timingBytes = buffer.subarray(secondTiming.start, secondTiming.endExclusive);
    const timing = decodeSegmentTiming(timingBytes, header, 1);
    assert.deepEqual(timing, { segmentIndex: 1, triggerTime: 3, triggerOffset: -0.5 });
    assert.throws(() => decodeSegmentTiming(timingBytes.subarray(1), header, 1), TrcFormatError);

    const span = getSampleByteRange(header, undefined, 1);
    assert.deepEqual(span, { start: dataOffset + 4 * bytesPerSample, endExclusive: dataOffset + 7 * bytesPerSample });
    const samples = buffer.subarray(span.start, span.endExclusive);
    assert.throws(() => decodeSamples(samples, header), /requires valid segment timing/);
    const { times, values } = decodeSamples(samples, header, undefined, 1, timing);
    assert.deepEqual([...times], [-0.5, 0]);
    assert.deepEqual([...values], [0, -0.5]);

    const range = { start: 1, endExclusive: 3 };
    const partialSpan = getSampleByteRange(header, range, 1);
    const partial = decodeSamples(buffer.subarray(partialSpan.start, partialSpan.endExclusive), header, range, undefined, timing);
    assert.deepEqual([...partial.times], [-0.25, 0]);
    assert.deepEqual([...partial.values], [0, -0.5]);
    assert.throws(() => getSampleByteRange(header, { start: 0, endExclusive: 4 }, 1), RangeError);
  });
}

test('uses TRIGTIME for a Sequence with one captured segment', () => {
  const { buffer, view } = fixture({ timings: [[0, -2]] });
  view.setInt16(316, 7, true);
  const header = readTrcHeader(buffer);
  const timingSpan = getSegmentTimingByteRange(header, 0);
  const timing = decodeSegmentTiming(buffer.subarray(timingSpan.start, timingSpan.endExclusive), header, 0);
  const span = getSampleByteRange(header, undefined, 0);
  const { times } = decodeSamples(buffer.subarray(span.start, span.endExclusive), header, undefined, undefined, timing);
  assert.equal(times[0], -1.75);

  view.setFloat64(timingSpan.start - 11, NaN, true);
  assert.throws(() => decodeSegmentTiming(buffer.subarray(timingSpan.start, timingSpan.endExclusive), header, 0), /Invalid Sequence/);
});

test('finds inclusive times and respects the valid sample window', () => {
  const {buffer} = fixture();
  const header = readTrcHeader(buffer);
  assert.deepEqual(getSampleRangeForTime(header, {from: -0.5, to: 0}), {start: 2, endExclusive: 5});
  assert.deepEqual(getSampleRangeForTime(header, {from: -2, to: 2}), {start: 1, endExclusive: 7});
  assert.deepEqual(getSampleRangeForTime(header, {from: 0.5, to: 0.5}), {start: 6, endExclusive: 7});
  assert.deepEqual(getSampleRangeForTime(header, {from: -0.4, to: -0.3}), {start: 3, endExclusive: 3});
  assert.deepEqual(getSampleRangeForTime(header, {from: 1, to: 2}), {start: 7, endExclusive: 7});
  assert.throws(() => getSampleRangeForTime(header, {from: 0, to: -1}), RangeError);
  assert.throws(() => getSampleRangeForTime(header, {from: 0, to: Infinity}), RangeError);
  assert.throws(() => getSampleRangeForTime(header, {from: 0, to: 1}, {timeScale: 0}), RangeError);
});

test('selects segment-local indices using its trigger offset and scaled boundary', () => {
  const {buffer, view} = fixture({timings: [[0, -1e-7], [2, -1.1e-7]]});
  view.setFloat32(176, 2.5e-8, true);
  const header = readTrcHeader(buffer);
  const span = getSegmentTimingByteRange(header, 1);
  const timing = decodeSegmentTiming(buffer.subarray(span.start, span.endExclusive), header, 1);
  const timeScale = 1e6;
  const secondSample = (timing.triggerOffset + header.horizontalInterval) * timeScale;
  const options = {timing, timeScale};
  assert.deepEqual(getSampleRangeForTime(header, {from: secondSample, to: secondSample}, options),
    {start: 1, endExclusive: 2});
  assert.deepEqual(getSampleRangeForTime(header, {from: -1, to: 1}, options), {start: 0, endExclusive: 3});
  assert.throws(() => getSampleRangeForTime(header, {from: -1, to: 1}), /requires valid segment timing/);
});
