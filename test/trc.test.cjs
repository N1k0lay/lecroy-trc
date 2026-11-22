const assert = require('node:assert/strict');
const test = require('node:test');
const { TrcFormatError, readTrcHeader, getSampleByteRange, decodeSamples } = require('lecroy-trc');

function fixture({ littleEndian = true, bytesPerSample = 2 } = {}) {
  const prefixLength = 11;
  const descriptorLength = 350;
  const userTextLength = 3;
  const raw = [90, 5, -7, 2, 2, 2, 1, -90];
  const dataOffset = prefixLength + descriptorLength + userTextLength;
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
  int(60, dataLength);
  buffer.write('TEST SCOPE', prefixLength + 76);
  view.setUint32(92, 0xf0000000, littleEndian);
  int(116, raw.length);
  int(124, 1);
  int(128, 6);
  int(136, 1);
  int(144, 1);
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
  raw.forEach((value, index) => {
    const offset = dataOffset - prefixLength + index * bytesPerSample;
    if (bytesPerSample === 1) view.setInt8(offset, value);
    else short(offset, value);
  });
  return { buffer, view, dataOffset };
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
  assert.throws(() => getSampleByteRange(header), /single-sweep/);
  view.setInt32(40, -1, true);
  assert.throws(() => readTrcHeader(buffer), /block lengths/);
});
