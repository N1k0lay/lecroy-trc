# lecroy-trc

Unofficial TypeScript library for reading Teledyne LeCroy `.trc` waveforms in Node.js and browsers. It has no runtime dependencies. It accepts a `Uint8Array` or Node.js `Buffer`, so the caller can supply data from local files or object storage.

## Read a waveform

```js
import { readFile } from 'node:fs/promises';
import { readTrcHeader, getSampleRangeForTime, getSampleByteRange, decodeSamples } from 'lecroy-trc';

const file = await readFile('C1.trc');
const header = readTrcHeader(file.subarray(0, 512));
const range = getSampleRangeForTime(header, { from: -2, to: 10 }, { timeScale: 1e6 });
const span = getSampleByteRange(header, range);
const { times, values } = decodeSamples(file.subarray(span.start, span.endExclusive), header, range, 1_000);
```

- `readTrcHeader(bytes)` accepts a file prefix containing the WAVEDESC fields. It returns the instrument identifiers, raw waveform source code, trigger clock fields, scales, units and waveform layout. Trigger clock fields have no time zone.
- `getSampleRangeForTime(header, {from, to}, options?)` selects valid samples at or between the endpoints. It returns half-open indices and returns an empty range when there are no matching samples. Bounds default to the horizontal unit in the file. Set `timeScale: 1e6` to pass microseconds for a trace whose horizontal unit is seconds. For Sequence, pass the decoded segment `timing` in the same options object.
- `getSampleByteRange(header, range?)` maps valid sample indices to byte offsets in the original file. Both ranges use inclusive start and exclusive end. For an HTTP range request use `bytes=${span.start}-${span.endExclusive - 1}` for a nonempty span.
- `decodeSamples(bytes, header, range?, buckets?)` accepts the exact byte slice from that range. It returns two `Float64Array` columns in the units reported by the header. Pass a positive bucket limit for graph previews. Each bucket emits its extrema in acquisition order at their original timestamps. A flat bucket emits one point. Omit the bucket limit to decode every selected sample.

The default range covers the valid samples. When reading from storage, obtain the header and samples from the same immutable file or object version.

## Read Sequence segments

When `header.isSequence` is true, use a zero-based segment index. Each segment has its own entry in the TRIGTIME block. You can fetch that entry and the selected sample range independently.

```js
import { getSegmentTimingByteRange, decodeSegmentTiming } from 'lecroy-trc';

for (let index = 0; index < header.segmentCount; index++) {
  const entry = getSegmentTimingByteRange(header, index);
  const timing = decodeSegmentTiming(file.subarray(entry.start, entry.endExclusive), header, index);
  const span = getSampleByteRange(header, undefined, index);
  const { times, values } = decodeSamples(
    file.subarray(span.start, span.endExclusive), header, undefined, 1_000, timing,
  );
  // The elapsed time from the first trigger to sample i is timing.triggerTime + times[i].
}
```

`timing.triggerTime` is the time in seconds from the first trigger to this segment's trigger. `timing.triggerOffset` is the time from this segment's trigger to its first stored sample. `decodeSamples` returns sample times relative to the segment's own trigger using its offset. An explicit sample range is relative to the start of the chosen segment. If omitted, the range is the intersection of that segment and the valid samples reported by the descriptor.

## Format support

The library reads `LECROY_2_3` descriptors and decodes contiguous single-sweep and Sequence traces with signed 8-bit or 16-bit samples in either byte order. A Sequence needs one TRIGTIME entry per captured segment. Other layouts, such as RIS and dual-array traces, expose header metadata and report `supportsSampleReading: false`. A request to decode such a layout throws `TrcFormatError`. The library covers file reading. Instrument control requires a separate transport.

The descriptor layout and scale formulas follow the [Teledyne LeCroy WAVEDESC documentation](https://cdn.teledynelecroy.com/files/manuals/maui-remote-control-and-automation-manual.pdf#page=190).

## Development

Run `npm ci`, `npm test` and `npm pack --dry-run` from this directory. Automated tests use generated files with known headers and calibration values.

`npm run test:upstream` downloads a pinned public `pulse_sequence.trc` fixture and compares all 20 segments against reference values generated with `lecroyscope` 1.0.0. To use a local copy, run `npm run test:upstream -- /path/to/pulse_sequence.trc`.

## Node.js compatibility

The supported Node.js floor for the package and development tools is 22. Compatibility smoke tests on the built package passed on Node.js 14.0.0 for CommonJS and 14.13.0 for named ES module imports. For deployment, use a [maintained LTS release](https://nodejs.org/en/about/previous-releases).

`npm run build:browser` generates `dist/browser/index.js`, a native ES module. Serve it as JavaScript and import it by URL in a browser.

## License

[MIT](LICENSE).
