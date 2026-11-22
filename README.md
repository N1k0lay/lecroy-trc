# lecroy-trc

Unofficial TypeScript library for reading Teledyne LeCroy `.trc` waveforms in Node.js 22+. It has no runtime dependencies. It accepts a `Uint8Array` or Node.js `Buffer`, so the caller can supply data from local files or object storage.

## Read a waveform

```js
import { readFile } from 'node:fs/promises';
import { readTrcHeader, getSampleByteRange, decodeSamples } from 'lecroy-trc';

const file = await readFile('C1.trc');
const header = readTrcHeader(file.subarray(0, 512));
const range = { start: header.firstValidSample, endExclusive: header.lastValidSample + 1 };
const span = getSampleByteRange(header, range);
const { times, values } = decodeSamples(file.subarray(span.start, span.endExclusive), header, range, 1_000);
```

- `readTrcHeader(bytes)` accepts a file prefix containing the WAVEDESC fields. It returns the instrument identifiers, raw waveform source code, trigger clock fields, scales, units and waveform layout. Trigger clock fields have no time zone.
- `getSampleByteRange(header, range?)` maps valid sample indices to byte offsets in the original file. Both ranges use inclusive start and exclusive end. For an HTTP range request use `bytes=${span.start}-${span.endExclusive - 1}` for a nonempty span.
- `decodeSamples(bytes, header, range?, buckets?)` accepts the exact byte slice from that range. It returns two `Float64Array` columns in the units reported by the header. Pass a positive bucket limit for graph previews. Each bucket emits its extrema in acquisition order at their original timestamps. A flat bucket emits one point. Omit the bucket limit to decode every selected sample.

The default range covers the valid samples. When reading from storage, obtain the header and samples from the same immutable file or object version.

## Format support

The first version reads `LECROY_2_3` descriptors and decodes contiguous single-sweep traces with signed 8-bit or 16-bit samples in either byte order. Sequence and other unsupported layouts expose header metadata and report `supportsSampleReading: false`. A request to decode such a layout throws `TrcFormatError`. The library covers file reading. Instrument control requires a separate transport.

The descriptor layout and scale formulas follow the [Teledyne LeCroy WAVEDESC documentation](https://cdn.teledynelecroy.com/files/manuals/maui-remote-control-and-automation-manual.pdf#page=190).

## Development

Run `npm ci`, `npm test` and `npm pack --dry-run` from this directory. Automated tests use generated files with known headers and calibration values.

## License

[MIT](LICENSE).
