# lecroy-trc

English · [Русский](README.ru.md)

An unofficial reader for Teledyne LeCroy `.trc` oscilloscope recordings in Node.js and browsers. Extract metadata, decode individual Sequence segments, and prepare plots that preserve narrow peaks.

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

`times` and `values` are `Float64Array` columns. Their units are `header.horizontalUnit` and `header.verticalUnit`. The header also exposes the instrument number, raw waveform source code, scale, offset, and trigger clock fields. The file stores the trigger clock without a time zone.

CommonJS can use `require('lecroy-trc')`. TypeScript resolves the bundled declarations from the same package. Public types include `TrcHeader`, `TimeRange`, `SampleRange`, `SampleSeries`, and `SegmentTiming`.

## Read a time window

Use the header to locate a window before reading its sample bytes. This works with local file reads, HTTP Range requests, and object storage.

```js
import { getSampleRangeForTime, getSampleByteRange } from 'lecroy-trc';

// For a waveform whose horizontal unit is seconds, pass bounds in microseconds.
const range = getSampleRangeForTime(header, { from: -2, to: 10 }, { timeScale: 1e6 });
const span = getSampleByteRange(header, range);
```

1. Read a prefix containing the complete `WAVEDESC` descriptor and pass it to `readTrcHeader`.
2. Select a time window. Both time endpoints are inclusive. The resulting sample indices and byte offsets use an exclusive end.
3. For a nonempty span, request `bytes=${span.start}-${span.endExclusive - 1}`, or read the equivalent slice from a local file. Use the same file or object version for the header and samples.
4. Pass those exact bytes to `decodeSamples(bytes, header, range)`. For an overview, add a bucket limit such as `decodeSamples(bytes, header, range, 1_000)`.

An overview keeps each bucket's minimum and maximum at their original timestamps, in acquisition order. A flat bucket yields one point. Omitting the limit returns every selected sample. `timeScale` changes how selection bounds are interpreted. Decoded timestamps remain in the file's horizontal unit.

## Read a Sequence segment

A Sequence contains consecutive segments. Each has a zero-based index and two timing values in seconds in the `TRIGTIME` block. Download [pulse_sequence.trc](https://raw.githubusercontent.com/lobis/lecroy-scope/2f627b418100d979c5a9b9dc9312fc275c534ce7/tests/files/pulse_sequence.trc) to run this example.

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

- `timing.triggerTime` is the elapsed time from the first trigger in the Sequence to this segment's trigger.
- `timing.triggerOffset` is the time from this segment's trigger to its first stored sample.
- `times[i]` is relative to this segment's trigger. For an axis relative to the first trigger, use `timing.triggerTime + times[i]`.
- To select a time window within a segment, pass `{ timing }` to `getSampleRangeForTime` and pass the same segment index to `getSampleByteRange`.

## Use in a browser

If your app uses a bundler, import from `lecroy-trc` as in the quick start.

For a page without a bundler, copy `dist/browser/index.js` from the installed package next to your page's JavaScript module and name the copy `lecroy-trc.js`. Import it using a relative URL.

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

Check `header.supportsSampleReading` before decoding a waveform whose layout may vary. A truncated byte slice or an unsupported layout passed to the decoder throws `TrcFormatError`. The file format and timing formulas follow the [Teledyne LeCroy WAVEDESC reference](https://cdn.teledynelecroy.com/files/manuals/maui-remote-control-and-automation-manual.pdf#page=190).

## Development

```sh
npm ci
npm run typecheck
npm test
npm run test:upstream
npm pack --dry-run
```

The unit tests use generated traces. The upstream check downloads a pinned `pulse_sequence.trc` sample and compares all 20 segments against reference values from [lecroyscope 1.0.0](https://pypi.org/project/lecroyscope/1.0.0/). For a local copy, use `npm run test:upstream -- /path/to/pulse_sequence.trc`.

For a format compatibility issue, include the instrument model, descriptor template, and a shareable sample if available. For production deployments, use a [maintained Node.js LTS release](https://nodejs.org/en/about/previous-releases).

## License

[MIT](LICENSE).
