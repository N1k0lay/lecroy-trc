# lecroy-trc

English · [Русский](README.ru.md)

Unofficial reader for Teledyne LeCroy `.trc` files in Node.js and browsers. Decode sweeps and Sequence segments, read a time window, or keep only the extrema needed for an overview plot.

**Node.js ≥ 18.12.0** · **Built-in TypeScript types** · **Zero runtime dependencies** · **[MIT](LICENSE)**

## Install

Use a checkout of this repository to build the local npm archive.

```sh
npm ci
npm pack
```

Install the archive printed by `npm pack` in your application.

```sh
npm install /path/to/lecroy-trc-0.2.0.tgz
```

## Quick start

Save this as `read-trace.mjs` and run `node read-trace.mjs` next to a single-sweep file named `C1.trc`.

```js
import { readFile } from 'node:fs/promises';
import { readTrcHeader, getSampleByteRange, decodeSamples } from 'lecroy-trc';

const file = await readFile('C1.trc');
const header = readTrcHeader(file);
const { start, endExclusive } = getSampleByteRange(header);
const { times, values } = decodeSamples(file.subarray(start, endExclusive), header);

console.log(header.instrumentName);
console.log({ samples: values.length, time: times[0], value: values[0] });
```

CommonJS uses `require('lecroy-trc')`. TypeScript picks up the bundled [types](#types-and-errors) from the same package.

## Read a time window

Use the header to locate a window before reading its sample bytes. This works with local file reads, HTTP Range requests, and object storage.

```js
import { getSampleRangeForTime, getSampleByteRange } from 'lecroy-trc';

// For a waveform whose horizontal unit is seconds, pass bounds in microseconds.
const range = getSampleRangeForTime(header, { from: -2, to: 10 }, { timeScale: 1e6 });
const span = getSampleByteRange(header, range);
```

1. Pass the file prefix containing the [WAVEDESC fields](#readtrcheader) to `readTrcHeader`.
2. Use the returned header to compute `range` and `span` as above.
3. For a nonempty span, request `bytes=${span.start}-${span.endExclusive - 1}`, or read the equivalent slice from a local file. Use the same file or object version for the header and samples.
4. Pass those exact bytes to `decodeSamples(bytes, header, range)`. For an overview, add a bucket limit such as `decodeSamples(bytes, header, range, 1_000)`.

## Read a Sequence segment

A Sequence contains consecutive segments. Each has a zero-based index and two timing values in seconds in the `TRIGTIME` block. To run this example, save a Sequence recording as `pulse_sequence.trc`.

```js
import { readFile } from 'node:fs/promises';
import {
  readTrcHeader, getSegmentTimingByteRange, decodeSegmentTiming,
  getSampleByteRange, decodeSamples,
} from 'lecroy-trc';

const file = await readFile('pulse_sequence.trc');
const header = readTrcHeader(file);
const slice = ({ start, endExclusive }) => file.subarray(start, endExclusive);

const index = 0;
const timing = decodeSegmentTiming(slice(getSegmentTimingByteRange(header, index)), header, index);
const span = getSampleByteRange(header, undefined, index);
const { times, values } = decodeSamples(slice(span), header, undefined, undefined, timing);

console.log({ triggerTime: timing.triggerTime, samples: values.length, firstTime: times[0] });
```

To read part of a segment, pass its `timing` to [getSampleRangeForTime](#getsamplerangefortime).

## Use in a browser

If your app uses a bundler, import from `lecroy-trc` as in the quick start.

For a page without a bundler, load your script with `<script type="module">`. Copy `dist/browser/index.js` next to that script as `lecroy-trc.js`.

```js
import { readTrcHeader } from './lecroy-trc.js';

const header = readTrcHeader(new Uint8Array(await file.slice(0, 512).arrayBuffer()));
console.log(header.instrumentName);
```

In this example, `file` is a browser `File`. Read more of the prefix if the descriptor extends past the first 512 bytes. From source, `npm run build:browser` generates the browser module.

## Format support

| Feature | Support |
| --- | --- |
| Descriptor template | `LECROY_2_3` |
| Stored samples | Signed 8-bit or 16-bit, little- or big-endian |
| Acquisition | Contiguous single sweep and Sequence with one `TRIGTIME` entry per captured segment |
| Other layouts | Metadata for recognized headers. RIS, sparse, and dual-array waveforms are outside sample decoding support. |

The descriptor and timing formulas follow the [Teledyne LeCroy WAVEDESC reference](https://cdn.teledynelecroy.com/files/manuals/maui-remote-control-and-automation-manual.pdf#page=190).

## API

### `readTrcHeader`

```ts
readTrcHeader(bytes: Uint8Array): TrcHeader
```

Reads a file or a prefix starting at byte 0. The prefix must contain at least 346 bytes from the start of `WAVEDESC`. A Node.js `Buffer` works as input. The parser checks the descriptor and reports whether it can decode the sample layout in `supportsSampleReading`. The sample bytes and timing block can be read later.

Throws `TrcFormatError` for a missing, incomplete, invalid, or unsupported descriptor.

### `getSampleRangeForTime`

```ts
getSampleRangeForTime(
  header: TrcHeader,
  range: TimeRange,
  options?: { timing?: SegmentTiming; timeScale?: number },
): SampleRange
```

Selects valid samples between `from` and `to`, including both endpoints. Equal bounds are allowed. If no sample matches, the returned range has `start === endExclusive`.

The bounds use the file's horizontal unit by default. With `timeScale`, the function compares each sample's time multiplied by that factor with the bounds. For example, use `1e6` to supply microseconds for a waveform stored in seconds. For Sequence, pass the decoded segment `timing`. The bounds are relative to that segment's trigger, and the indices are relative to the start of the segment.

Throws `RangeError` for nonfinite or reversed bounds, a nonpositive or nonfinite scale, or an invalid segment index. An unsupported sample layout or missing, unexpected, or invalid timing offset throws `TrcFormatError`.

### `getSampleByteRange`

```ts
getSampleByteRange(header: TrcHeader, range?: SampleRange, segmentIndex?: number): SampleRange
```

Maps sample indices to byte offsets from the start of the file. For Sequence, supply a zero-based `segmentIndex` and use indices relative to that segment. For a single sweep, omit the index or pass `0`. When `range` is omitted, the function selects all valid samples in the sweep or segment.

Throws `RangeError` for an invalid segment index or sample range. The range needs integer, ordered indices within the valid bounds. An unsupported layout or missing Sequence index throws `TrcFormatError`.

### `decodeSamples`

```ts
decodeSamples(
  bytes: Uint8Array,
  header: TrcHeader,
  range?: SampleRange,
  buckets?: number,
  timing?: SegmentTiming,
): SampleSeries
```

Takes the exact byte slice identified by `getSampleByteRange` for the same selection. When `range` is omitted, the selection covers all valid samples in the sweep or segment. Pass `timing` for Sequence and omit it for a single sweep. An empty range takes an empty buffer and returns empty columns.

The result contains two `Float64Array` columns. `values` uses `raw * verticalGain - verticalOffset` in `header.verticalUnit`. `times` uses `header.horizontalUnit` and, for Sequence, is relative to the segment's trigger. `timeScale` affects selection only.

Omit `buckets` to return every sample. Supply a positive safe integer for at most `2 * buckets` points. Each interval yields its minimum and maximum at their original times, in recording order. A flat interval yields one point.

Throws `RangeError` for an invalid range, segment index, or bucket count. An unsupported layout, wrong byte count, or missing, unexpected, or invalid timing offset throws `TrcFormatError`.

### `getSegmentTimingByteRange`

```ts
getSegmentTimingByteRange(header: TrcHeader, segmentIndex: number): SampleRange
```

Returns the absolute byte span of a zero-based segment's 16-byte `TRIGTIME` entry. The header must describe a Sequence with one entry per captured segment. This lookup can work even when `supportsSampleReading` is false.

Throws `TrcFormatError` if the timing block does not match that layout and `RangeError` for an invalid index.

### `decodeSegmentTiming`

```ts
decodeSegmentTiming(bytes: Uint8Array, header: TrcHeader, segmentIndex: number): SegmentTiming
```

Takes exactly the 16 bytes identified by `getSegmentTimingByteRange`. Reads two 64-bit floating-point values using the header's byte order. Both values are in seconds.

- `triggerTime` is the elapsed time from the first trigger in the Sequence to this segment's trigger.
- `triggerOffset` is the time from this segment's trigger to its first stored sample.

For an axis relative to the first trigger, add `triggerTime` to each decoded segment time in seconds. The function uses the same layout and index checks as `getSegmentTimingByteRange`. An incorrect byte count or a nonfinite timing value throws `TrcFormatError`.

### Types and errors

| Export | Shape |
| --- | --- |
| `TrcHeader` | Parsed descriptor. See the fields below. |
| `TimeRange` | `{ from, to }`. Both time endpoints are included. |
| `SampleRange` | `{ start, endExclusive }`. The same shape represents sample indices or byte offsets depending on the function. |
| `SampleSeries` | `{ times, values }`. Two `Float64Array` columns of equal length. |
| `SegmentTiming` | `{ segmentIndex, triggerTime, triggerOffset }`. |
| `TrcFormatError` | `Error` subclass with constructor `new TrcFormatError(message: string)`. Use `instanceof TrcFormatError` to identify it. |

| `TrcHeader` fields | Meaning |
| --- | --- |
| `template`, `recordType`, `supportsSampleReading` | Descriptor template, raw recording type code, and whether the sample layout is supported. |
| `instrumentName`, `instrumentNumber`, `traceLabel`, `waveSource` | Instrument and waveform identifiers. `waveSource` is the raw code. Analog C1–C4 use 0–3. |
| `trigger` | Local instrument clock fields `year`, `month`, `day`, `hour`, `minute`, and `second`. The second can be fractional. The file contains no time zone. |
| `littleEndian`, `bytesPerSample` | Sample byte order and width of 1 or 2 bytes. |
| `dataOffset`, `dataLength` | Offset from the start of the file and byte length of the primary sample block. |
| `sampleCount`, `firstValidSample`, `lastValidSample` | Count and valid bounds in the full stored sample array. The last index is inclusive. |
| `isSequence`, `segmentCount`, `samplesPerSegment` | Sequence flag, captured segment count, and stored samples per segment. |
| `segmentTimingOffset`, `segmentTimingLength` | Offset and byte length of `TRIGTIME`. |
| `horizontalInterval`, `horizontalOffset`, `horizontalUnit` | Sample interval, descriptor time offset, and horizontal unit. A Sequence segment uses its own `triggerOffset` when decoded. |
| `verticalGain`, `verticalOffset`, `verticalUnit` | Scale, offset, and unit used to convert stored samples. |

## Development

```sh
npm ci
npm run typecheck
npm test
npm run test:upstream
npm pack --dry-run
```

The unit tests use generated traces. The upstream check downloads a pinned `pulse_sequence.trc` sample and compares samples and timing values for all 20 segments against a saved reference. For a local copy, use `npm run test:upstream -- /path/to/pulse_sequence.trc`.

For a format compatibility issue, include the instrument model, descriptor template, and a shareable sample if available. For production deployments, use a [maintained Node.js LTS release](https://nodejs.org/en/about/previous-releases).

## License

[MIT](LICENSE).
