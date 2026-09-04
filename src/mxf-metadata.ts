import { readBer } from "./mxf";
import type { MxfIndexTable } from "./mxf-index";
import type { MxfTimecodeInfo } from "./timecode";

export interface MxfMediaInfo {
  operationalPattern?: string;
  essenceContainer?: string;
  editRateNumerator?: number;
  editRateDenominator?: number;
  durationFrames?: number;
  video?: {
    codec?: string; width?: number; height?: number;
    storedWidth?: number; storedHeight?: number;
    sampledWidth?: number; sampledHeight?: number;
    displayWidth?: number; displayHeight?: number; frameLayout?: number;
    frameRateNumerator?: number; frameRateDenominator?: number;
    aspectRatio?: string; pixelFormat?: string; durationFrames?: number;
  };
  audio?: { codec?: string; essenceCodingUl?: string; sampleRate?: number; channels?: number; bitsPerSample?: number; blockAlign?: number };
  /** Inspection summaries; these are derived from parsed structures, never playback fallbacks. */
  timecodeTrackCount: number;
  selectedTimecode?: MxfTimecodeInfo;
  timecodeSelectionReason?: string;
  indexTableCount: number;
  indexEntryCount: number;
}

export interface MxfMetadataResult { mediaInfo: MxfMediaInfo; timecodes: MxfTimecodeInfo[]; indexTables: MxfIndexTable[] }
type Fields = Map<number, Uint8Array>;
const text = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
const u16 = (v: Uint8Array) => new DataView(v.buffer, v.byteOffset, v.byteLength).getUint16(0);
const u32 = (v: Uint8Array) => new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(0);
const i64 = (v: Uint8Array) => Number(new DataView(v.buffer, v.byteOffset, v.byteLength).getBigInt64(0));
const u64 = (v: Uint8Array) => new DataView(v.buffer, v.byteOffset, v.byteLength).getBigUint64(0);
const rational = (v?: Uint8Array) => v && v.length >= 8 ? [u32(v.subarray(0, 4)), u32(v.subarray(4, 8))] as const : undefined;

function localSet(value: Uint8Array, fixedLengthBytes = false): Fields {
  const fields: Fields = new Map();
  let at = 0;
  while (at + (fixedLengthBytes ? 4 : 3) <= value.length) {
    const tag = (value[at] << 8) | value[at + 1];
    const length = fixedLengthBytes
      ? { value: (value[at + 2] << 8) | value[at + 3], bytes: 2 }
      : readBer(value, at + 2);
    const start = at + 2 + length.bytes, end = start + length.value;
    if (end > value.length) break;
    fields.set(tag, value.subarray(start, end));
    at = end;
  }
  return fields;
}

function parseIndex(fields: Fields): MxfIndexTable | undefined {
  const rate = rational(fields.get(0x3f0b)), start = fields.get(0x3f0c), duration = fields.get(0x3f0d);
  if (!rate || !start || !duration) return;
  const constant = fields.get(0x3f05);
  const table: MxfIndexTable = { editRateNumerator: rate[0], editRateDenominator: rate[1], startPosition: i64(start), duration: i64(duration), editUnitByteCount: constant ? u32(constant) : undefined, entries: [] };
  const array = fields.get(0x3f0a);
  if (!array || array.length < 8) return table;
  const count = u32(array), itemSize = u32(array.subarray(4));
  if (itemSize < 11 || 8 + count * itemSize > array.length) return table;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * itemSize;
    const temporal = new DataView(array.buffer, array.byteOffset + at, itemSize).getInt8(0);
    const key = new DataView(array.buffer, array.byteOffset + at, itemSize).getInt8(1);
    const flags = array[at + 2];
    table.entries.push({ editUnit: table.startPosition + i, temporalOffset: temporal, keyFrameOffset: key, flags, isRandomAccessPoint: key === 0 || Boolean(flags & 0x80), streamOffset: u64(array.subarray(at + 3, at + 11)) });
  }
  return table;
}

export function createMxfMetadataResult(): MxfMetadataResult {
  return { mediaInfo: { timecodeTrackCount: 0, indexTableCount: 0, indexEntryCount: 0 }, timecodes: [], indexTables: [] };
}

/** Shared KLV value parser used by both contiguous and random-access traversal. */
export function parseMxfMetadataKlv(result: MxfMetadataResult, key: Uint8Array, value: Uint8Array, editRates: Array<readonly [number, number]>): void {
  const keyHex = text(key);
  if (keyHex.startsWith("060e2b34020501010d01020101") && value.length >= 80) {
    const op = text(value.subarray(64, 80));
    if (op.startsWith("060e2b34040101010d01020101")) result.mediaInfo.operationalPattern = "OP1a";
  } else if (keyHex.startsWith("060e2b34025301010d0102010110")) {
    try { const index = parseIndex(localSet(value, key[5] === 0x53)); if (index) result.indexTables.push(index); } catch { /* A corrupt index is non-fatal. */ }
  } else if (keyHex.startsWith("060e2b3402530101")) {
    let fields: Fields; try { fields = localSet(value, key[5] === 0x53); } catch { return; }
    const rate = rational(fields.get(0x4b01)); if (rate) editRates.push(rate);
    const startTc = fields.get(0x1501), base = fields.get(0x1502), drop = fields.get(0x1503);
    if (startTc && base && drop) result.timecodes.push({ startFrame: i64(startTc), roundedTimecodeBase: u16(base), dropFrame: drop[0] !== 0, editRateNumerator: rate?.[0] ?? 0, editRateDenominator: rate?.[1] ?? 0, durationFrames: fields.get(0x0202) ? i64(fields.get(0x0202)!) : undefined, source: "mxf" });
    const storedWidth = fields.get(0x3203), storedHeight = fields.get(0x3202);
    const sampledWidth = fields.get(0x3205), sampledHeight = fields.get(0x3204);
    const displayWidth = fields.get(0x3209), displayHeight = fields.get(0x3208);
    const frameLayout = fields.get(0x320c), aspect = rational(fields.get(0x320e));
    if (storedWidth || storedHeight || sampledWidth || sampledHeight || displayWidth || displayHeight || frameLayout || aspect) {
      const previous = result.mediaInfo.video;
      const rawStoredWidth = storedWidth ? u32(storedWidth) : previous?.storedWidth, rawStoredHeight = storedHeight ? u32(storedHeight) : previous?.storedHeight;
      const rawSampledWidth = sampledWidth ? u32(sampledWidth) : previous?.sampledWidth, rawSampledHeight = sampledHeight ? u32(sampledHeight) : previous?.sampledHeight;
      const rawDisplayWidth = displayWidth ? u32(displayWidth) : previous?.displayWidth, rawDisplayHeight = displayHeight ? u32(displayHeight) : previous?.displayHeight;
      const layout = frameLayout?.[0] ?? previous?.frameLayout, width = rawDisplayWidth ?? rawSampledWidth ?? rawStoredWidth ?? previous?.width;
      let height = rawDisplayHeight ?? rawSampledHeight ?? rawStoredHeight ?? previous?.height;
      // XDCAM 1080i may expose a 540-line display field or a 544-line stored field
      // while FrameLayout=SeparateFields describes the complete 1080-line picture.
      if (layout === 1 && width === 1920 && (height === 540 || height === 544)) height = 1080;
      result.mediaInfo.video = {
        ...result.mediaInfo.video, width, height,
        storedWidth: rawStoredWidth, storedHeight: rawStoredHeight,
        sampledWidth: rawSampledWidth, sampledHeight: rawSampledHeight,
        displayWidth: rawDisplayWidth, displayHeight: rawDisplayHeight, frameLayout: layout,
        aspectRatio: aspect ? `${aspect[0]}:${aspect[1]}` : previous?.aspectRatio,
      };
    }
    const sampleRate = rational(fields.get(0x3d03)), channels = fields.get(0x3d07), bits = fields.get(0x3d01), coding=fields.get(0x3d06), blockAlign=fields.get(0x3d0a);
    if (sampleRate || channels || bits || coding || blockAlign) result.mediaInfo.audio = { ...result.mediaInfo.audio, essenceCodingUl:coding?text(coding):undefined, sampleRate: sampleRate ? sampleRate[0] / sampleRate[1] : undefined, channels: channels ? u32(channels) : undefined, bitsPerSample: bits ? u32(bits) : undefined, blockAlign:blockAlign?u16(blockAlign):undefined };
    const essence = fields.get(0x3004); if (essence) result.mediaInfo.essenceContainer = text(essence);
    const duration = fields.get(0x3002); if (duration) result.mediaInfo.durationFrames = i64(duration);
  }
}

export function finalizeMxfMetadata(result: MxfMetadataResult, editRates: Array<readonly [number, number]>): MxfMetadataResult {
  const rate = editRates[0] ?? (result.indexTables[0] ? [result.indexTables[0].editRateNumerator, result.indexTables[0].editRateDenominator] as const : undefined);
  if (rate) {
    result.mediaInfo.editRateNumerator = rate[0]; result.mediaInfo.editRateDenominator = rate[1];
    if (result.mediaInfo.video) { result.mediaInfo.video.frameRateNumerator = rate[0]; result.mediaInfo.video.frameRateDenominator = rate[1]; }
    for (const tc of result.timecodes) if (!tc.editRateNumerator) { tc.editRateNumerator = rate[0]; tc.editRateDenominator = rate[1]; }
  }
  result.mediaInfo.timecodeTrackCount = result.timecodes.length; result.mediaInfo.indexTableCount = result.indexTables.length;
  result.mediaInfo.indexEntryCount = result.indexTables.reduce((total, table) => total + table.entries.length, 0);
  return result;
}

/** Parse structural metadata local sets and index segments without assuming an essence format. */
export function parseMxfMetadata(data: Uint8Array): MxfMetadataResult {
  const result = createMxfMetadataResult();
  const editRates: Array<readonly [number, number]> = [];
  let at = 0;
  while (at + 17 <= data.length) {
    let length: { value: number; bytes: number };
    try { length = readBer(data, at + 16); } catch { break; }
    const key = data.subarray(at, at + 16);
    const start = at + 16 + length.bytes, end = start + length.value;
    if (end > data.length) break;
    parseMxfMetadataKlv(result, key, data.subarray(start, end), editRates);
    at = end;
  }
  return finalizeMxfMetadata(result, editRates);
}
