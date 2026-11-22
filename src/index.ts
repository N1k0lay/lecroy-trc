const descriptorSize = 346;

export interface TrcHeader {
  readonly template: 'LECROY_2_3';
  readonly instrumentName: string;
  readonly instrumentNumber: number;
  readonly traceLabel: string;
  /** Raw WAVE_SOURCE code. Analog inputs C1–C4 are 0–3. */
  readonly waveSource: number;
  /** Local clock fields from the instrument. TRC stores no time zone. */
  readonly trigger: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
  };
  readonly littleEndian: boolean;
  readonly bytesPerSample: 1 | 2;
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly sampleCount: number;
  readonly firstValidSample: number;
  readonly lastValidSample: number;
  readonly segmentCount: number;
  readonly recordType: number;
  readonly supportsSampleReading: boolean;
  readonly horizontalInterval: number;
  readonly horizontalOffset: number;
  readonly horizontalUnit: string;
  readonly verticalGain: number;
  readonly verticalOffset: number;
  readonly verticalUnit: string;
}

export interface SampleRange {
  readonly start: number;
  readonly endExclusive: number;
}

export interface SampleSeries {
  readonly times: Float64Array;
  readonly values: Float64Array;
}

export class TrcFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrcFormatError';
  }
}

/** Accepts a complete file or a prefix containing the WAVEDESC fields. */
export function readTrcHeader(bytes: Uint8Array): TrcHeader {
  const signature = [87, 65, 86, 69, 68, 69, 83, 67]; // WAVEDESC
  const start = bytes.findIndex((byte, index) =>
    byte === signature[0] && signature.every((value, offset) => bytes[index + offset] === value),
  );
  if (start < 0 || bytes.byteLength - start < descriptorSize) {
    throw new TrcFormatError('Missing or incomplete WAVEDESC descriptor');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, descriptorSize);
  const string = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start + offset, start + offset + length)).split('\0', 1)[0].trim();

  const template = string(16, 16);
  if (template !== 'LECROY_2_3') {
    throw new TrcFormatError('Unsupported WAVEDESC template: ' + template);
  }
  const order = view.getUint16(34);
  if (order !== 0 && order !== 0x0100) {
    throw new TrcFormatError('Invalid COMM_ORDER field');
  }
  const littleEndian = order === 0x0100;
  const short = (offset: number) => view.getInt16(offset, littleEndian);
  const int = (offset: number) => view.getInt32(offset, littleEndian);
  const float = (offset: number) => view.getFloat32(offset, littleEndian);

  const encoding = short(32);
  if (encoding !== 0 && encoding !== 1) {
    throw new TrcFormatError('Unsupported COMM_TYPE field');
  }
  const bytesPerSample = encoding === 0 ? 1 : 2;
  const blocks = [36, 40, 44, 48, 52, 56, 60, 64, 68, 72].map(int);
  const dataOffset = start + blocks.slice(0, 6).reduce((sum, size) => sum + size, 0);
  const dataLength = blocks[6];
  const sampleCount = int(116);
  const firstValidSample = int(124);
  const lastValidSample = int(128);
  const segmentCount = int(144);
  const recordType = short(316);
  if (blocks[0] < descriptorSize || blocks.some(size => size < 0) ||
      sampleCount < 1 || dataLength < sampleCount * bytesPerSample ||
      firstValidSample < 0 || lastValidSample < firstValidSample ||
      lastValidSample >= sampleCount || segmentCount < 0) {
    throw new TrcFormatError('Invalid WAVEDESC block lengths or sample bounds');
  }

  const horizontalInterval = float(176);
  const horizontalOffset = view.getFloat64(180, littleEndian);
  const verticalGain = float(156);
  const verticalOffset = float(160);
  if (![horizontalInterval, horizontalOffset, verticalGain, verticalOffset].every(Number.isFinite) ||
      horizontalInterval <= 0 || verticalGain === 0) {
    throw new TrcFormatError('Invalid waveform scale');
  }
  // shortcut: decode one contiguous sweep. Segment and RIS timing need separate handling.
  const supportsSampleReading = recordType === 0 && segmentCount === 1 &&
    int(132) === 0 && int(136) === 1 && blocks[3] === 0 && blocks[4] === 0 && blocks[7] === 0;
  return {
    template,
    instrumentName: string(76, 16),
    instrumentNumber: view.getUint32(92, littleEndian),
    traceLabel: string(96, 16),
    waveSource: short(344),
    trigger: {
      year: view.getUint16(308, littleEndian),
      month: view.getUint8(307),
      day: view.getUint8(306),
      hour: view.getUint8(305),
      minute: view.getUint8(304),
      second: view.getFloat64(296, littleEndian),
    },
    littleEndian, bytesPerSample, dataOffset, dataLength, sampleCount,
    firstValidSample, lastValidSample, segmentCount, recordType, supportsSampleReading,
    horizontalInterval, horizontalOffset, horizontalUnit: string(244, 48),
    verticalGain, verticalOffset, verticalUnit: string(196, 48),
  };
}

/** Maps valid sample indices to a half-open byte range within the original file. */
export function getSampleByteRange(
  header: TrcHeader,
  range: SampleRange = { start: header.firstValidSample, endExclusive: header.lastValidSample + 1 },
): SampleRange {
  if (!header.supportsSampleReading) {
    throw new TrcFormatError('Sample decoding requires a contiguous single-sweep trace');
  }
  const { start, endExclusive } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) ||
      start < header.firstValidSample || endExclusive > header.lastValidSample + 1 ||
      endExclusive < start) {
    throw new RangeError('Sample range is outside the valid waveform');
  }
  return {
    start: header.dataOffset + start * header.bytesPerSample,
    endExclusive: header.dataOffset + endExclusive * header.bytesPerSample,
  };
}

/** Decode an exact byte slice. With buckets, keep up to two extrema per interval. */
export function decodeSamples(
  bytes: Uint8Array,
  header: TrcHeader,
  range: SampleRange = { start: header.firstValidSample, endExclusive: header.lastValidSample + 1 },
  buckets?: number,
): SampleSeries {
  const span = getSampleByteRange(header, range);
  if (bytes.byteLength !== span.endExclusive - span.start) {
    throw new TrcFormatError('Expected exactly the bytes of the requested sample range');
  }
  if (buckets !== undefined && (!Number.isSafeInteger(buckets) || buckets < 1)) {
    throw new RangeError('Bucket count must be a positive safe integer');
  }

  const count = range.endExclusive - range.start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = header.bytesPerSample === 1
    ? (index: number) => view.getInt8(index)
    : (index: number) => view.getInt16(index * 2, header.littleEndian);
  const step = buckets === undefined ? 1 : Math.max(1, Math.ceil(count / buckets));
  const capacity = Math.min(count, 2 * Math.ceil(count / step));
  const times = new Float64Array(capacity);
  const values = new Float64Array(capacity);
  let written = 0;
  const push = (index: number, raw: number) => {
    times[written] = header.horizontalOffset + (range.start + index) * header.horizontalInterval;
    values[written] = raw * header.verticalGain - header.verticalOffset;
    written++;
  };

  for (let begin = 0; begin < count; begin += step) {
    let low = read(begin);
    let high = low;
    let lowIndex = begin;
    let highIndex = begin;
    const end = Math.min(begin + step, count);
    for (let index = begin + 1; index < end; index++) {
      const raw = read(index);
      if (raw < low) {
        low = raw;
        lowIndex = index;
      }
      if (raw > high) {
        high = raw;
        highIndex = index;
      }
    }
    if (lowIndex <= highIndex) {
      push(lowIndex, low);
      if (lowIndex < highIndex) push(highIndex, high);
    } else {
      push(highIndex, high);
      push(lowIndex, low);
    }
  }

  return { times: times.subarray(0, written), values: values.subarray(0, written) };
}
