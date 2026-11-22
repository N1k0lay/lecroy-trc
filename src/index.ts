const descriptorSize = 346;
const segmentTimingSize = 16;

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
  /** Counts and valid indices refer to the entire stored sample array. */
  readonly sampleCount: number;
  readonly firstValidSample: number;
  readonly lastValidSample: number;
  readonly segmentCount: number;
  readonly samplesPerSegment: number;
  readonly isSequence: boolean;
  readonly segmentTimingOffset: number;
  readonly segmentTimingLength: number;
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

export interface TimeRange {
  readonly from: number;
  readonly to: number;
}

export interface SampleSeries {
  readonly times: Float64Array;
  readonly values: Float64Array;
}

export interface SegmentTiming {
  readonly segmentIndex: number;
  /** TRIGTIME: seconds from the first trigger of the acquisition. */
  readonly triggerTime: number;
  /** TRIGTIME: seconds from this segment's trigger to its first sample. */
  readonly triggerOffset: number;
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
  const segmentTimingOffset = start + blocks[0] + blocks[1] + blocks[2];
  const segmentTimingLength = blocks[3];
  const dataOffset = segmentTimingOffset + segmentTimingLength + blocks[4] + blocks[5];
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
  const isSequence = segmentCount > 1 || segmentTimingLength > 0 || recordType === 7;
  const samplesPerSegment = segmentCount > 0 ? sampleCount / segmentCount : 0;
  const hasSegmentTiming = segmentTimingLength === segmentCount * segmentTimingSize;
  // shortcut: read contiguous sweeps. Sparse, RIS and dual-array traces need separate decoding.
  const supportsSampleReading = (recordType === 0 || recordType === 7) &&
    int(132) === 0 && int(136) === 1 && blocks[4] === 0 && blocks[7] === 0 &&
    segmentCount > 0 && Number.isInteger(samplesPerSegment) && (!isSequence || hasSegmentTiming);
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
    firstValidSample, lastValidSample, segmentCount, samplesPerSegment, isSequence,
    segmentTimingOffset, segmentTimingLength, recordType, supportsSampleReading,
    horizontalInterval, horizontalOffset, horizontalUnit: string(244, 48),
    verticalGain, verticalOffset, verticalUnit: string(196, 48),
  };
}

/** Maps a zero-based Sequence segment to its two-double TRIGTIME entry. */
export function getSegmentTimingByteRange(header: TrcHeader, segmentIndex: number): SampleRange {
  if (!header.isSequence || header.segmentTimingLength === 0 ||
      header.segmentTimingLength !== header.segmentCount * segmentTimingSize) {
    throw new TrcFormatError('Expected one TRIGTIME entry per Sequence segment');
  }
  validateSegmentIndex(header, segmentIndex);
  const start = header.segmentTimingOffset + segmentIndex * segmentTimingSize;
  return { start, endExclusive: start + segmentTimingSize };
}

/** Decodes the exact TRIGTIME byte range for one segment. */
export function decodeSegmentTiming(
  bytes: Uint8Array,
  header: TrcHeader,
  segmentIndex: number,
): SegmentTiming {
  getSegmentTimingByteRange(header, segmentIndex);
  if (bytes.byteLength !== segmentTimingSize) {
    throw new TrcFormatError('Expected exactly 16 bytes for a TRIGTIME entry');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triggerTime = view.getFloat64(0, header.littleEndian);
  const triggerOffset = view.getFloat64(8, header.littleEndian);
  if (!Number.isFinite(triggerTime) || !Number.isFinite(triggerOffset)) {
    throw new TrcFormatError('Invalid Sequence trigger timing');
  }
  return { segmentIndex, triggerTime, triggerOffset };
}

function validateSegmentIndex(header: TrcHeader, index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= header.segmentCount) {
    throw new RangeError('Segment index is outside the waveform');
  }
}

function getSampleWindow(header: TrcHeader, range?: SampleRange, segmentIndex?: number) {
  if (!header.supportsSampleReading) {
    throw new TrcFormatError('Unsupported waveform sample layout');
  }
  if (header.isSequence && segmentIndex === undefined) {
    throw new TrcFormatError('Sequence sample reading requires a segment index');
  }
  const index = segmentIndex ?? 0;
  validateSegmentIndex(header, index);
  const segmentStart = index * header.samplesPerSegment;
  const clamp = (sample: number) => Math.max(0, Math.min(header.samplesPerSegment, sample - segmentStart));
  const first = clamp(header.firstValidSample);
  const end = clamp(header.lastValidSample + 1);
  const { start, endExclusive } = range ?? { start: first, endExclusive: end };
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) ||
      start < first || endExclusive > end || endExclusive < start) {
    throw new RangeError('Sample range is outside the valid waveform');
  }
  return { start, endExclusive, segmentStart };
}

function getHorizontalOffset(header: TrcHeader, timing?: SegmentTiming): number {
  if (header.isSequence !== (timing !== undefined) ||
      (timing !== undefined && !Number.isFinite(timing.triggerOffset))) {
    throw new TrcFormatError('Sequence decoding requires valid segment timing');
  }
  return timing?.triggerOffset ?? header.horizontalOffset;
}

/** Selects valid samples at or between the time bounds. The resulting indices are half-open. */
export function getSampleRangeForTime(
  header: TrcHeader,
  { from, to }: TimeRange,
  { timing, timeScale = 1 }: { timing?: SegmentTiming; timeScale?: number } = {},
): SampleRange {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new RangeError('Expected finite time bounds in ascending order');
  }
  if (!Number.isFinite(timeScale) || timeScale <= 0) {
    throw new RangeError('Time scale must be finite and positive');
  }
  const offset = getHorizontalOffset(header, timing);
  const { start, endExclusive } = getSampleWindow(header, undefined, timing?.segmentIndex);
  // Compare in the requested units to keep boundaries identical to scaled decoded timestamps.
  const boundary = (time: number, after: boolean) => {
    let left = start;
    let right = endExclusive;
    while (left < right) {
      const index = Math.floor((left + right) / 2);
      const value = (offset + index * header.horizontalInterval) * timeScale;
      if (value < time || (after && value === time)) left = index + 1;
      else right = index;
    }
    return left;
  };
  return { start: boundary(from, false), endExclusive: boundary(to, true) };
}

/** Maps valid sample indices to a half-open byte range within the original file. */
export function getSampleByteRange(
  header: TrcHeader,
  range?: SampleRange,
  segmentIndex?: number,
): SampleRange {
  const { start, endExclusive, segmentStart } = getSampleWindow(header, range, segmentIndex);
  return {
    start: header.dataOffset + (segmentStart + start) * header.bytesPerSample,
    endExclusive: header.dataOffset + (segmentStart + endExclusive) * header.bytesPerSample,
  };
}

/** Decode an exact byte slice. With buckets, keep up to two extrema per interval. */
export function decodeSamples(
  bytes: Uint8Array,
  header: TrcHeader,
  range?: SampleRange,
  buckets?: number,
  timing?: SegmentTiming,
): SampleSeries {
  const horizontalOffset = getHorizontalOffset(header, timing);
  const { start, endExclusive } = getSampleWindow(header, range, timing?.segmentIndex);
  const count = endExclusive - start;
  if (bytes.byteLength !== count * header.bytesPerSample) {
    throw new TrcFormatError('Expected exactly the bytes of the requested sample range');
  }
  if (buckets !== undefined && (!Number.isSafeInteger(buckets) || buckets < 1)) {
    throw new RangeError('Bucket count must be a positive safe integer');
  }

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
    times[written] = horizontalOffset + (start + index) * header.horizontalInterval;
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
