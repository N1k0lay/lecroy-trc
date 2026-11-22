const assert = require('assert').strict;
const { createHash } = require('crypto');
const { readFileSync } = require('fs');
const {
  readTrcHeader, getSampleRangeForTime, getSampleByteRange, decodeSamples,
  getSegmentTimingByteRange, decodeSegmentTiming,
} = require('lecroy-trc');

const fixtureUrl = 'https://raw.githubusercontent.com/lobis/lecroy-scope/2f627b418100d979c5a9b9dc9312fc275c534ce7/tests/files/pulse_sequence.trc';

function digest(values) {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  const fixturePath = process.argv[2];
  let file;
  if (fixturePath) {
    file = readFileSync(fixturePath);
  } else {
    const response = await fetch(fixtureUrl);
    if (!response.ok) throw new Error('Could not download upstream fixture: HTTP ' + response.status);
    file = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(createHash('sha256').update(file).digest('hex'),
    'a674cfec031d433ca58c1f00a648893f1addb67ad0c1264a8def56194acb4b36', 'fixture hash');

  const header = readTrcHeader(file);
  assert.equal(header.segmentCount, 20);
  assert.equal(header.samplesPerSegment, 502);
  const slice = ({ start, endExclusive }) => file.subarray(start, endExclusive);
  const values = [];
  const times = [];
  const timings = [];
  for (let index = 0; index < header.segmentCount; index++) {
    const entry = getSegmentTimingByteRange(header, index);
    const timing = decodeSegmentTiming(slice(entry), header, index);
    timings.push(timing.triggerTime, timing.triggerOffset);
    const range = getSampleRangeForTime(header, {
      from: timing.triggerOffset,
      to: timing.triggerOffset + (header.samplesPerSegment - 1) * header.horizontalInterval,
    }, { timing });
    const span = getSampleByteRange(header, range, index);
    const segment = decodeSamples(slice(span), header, range, undefined, timing);
    assert.equal(segment.values.length, 502);
    values.push(...segment.values);
    times.push(...segment.times);
  }
  // SHA-256 of NumPy arrays serialized as little-endian float64 in row-major order.
  // Generated with lecroyscope 1.0.0 from Trace.voltage, Trace.trigger_times.T,
  // and np.arange(502) * Trace.header['horiz_interval'] + Trace.trigger_times[1, :, None].
  assert.equal(digest(values), '765e7956409e09087d52c26f87d186bd3e10037c3291610e5f41d1f125e22fa9', 'voltage');
  assert.equal(digest(timings), '69e362f93393fccbe3e60f2b82f040c74e304f0460a42defebf4f157bdd6b8b2', 'TRIGTIME');
  assert.equal(digest(times), '46975389663271ce9ad164869c04563831002af8c9a5d04c6c4942712f0cafd3', 'segment time axes');
  console.log(`${process.version}: 20 segments, 10,040 voltage readings and time values, 20 TRIGTIME pairs match`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
