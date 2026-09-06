import { readKlvHeader, type KlvHeader } from "./klv-reader";
import type { MxfIndexTable } from "./mxf-index";
import type { MxfPartitionInfo } from "./mxf-reader";
import { abortError, type RandomAccessReader } from "./random-access-reader";

export const DEFAULT_ESSENCE_PREROLL_FRAMES = 45;
export const DEFAULT_ESSENCE_READ_SIZE = 4 * 1024 * 1024;

export interface EssenceIndexEntry {
  offset: bigint; valueOffset: bigint; valueLength: bigint; trackNumber: number;
  bodySID?: number; kind: "video" | "audio" | "unknown"; editUnit: number;
  presentationTime: number; partition?: MxfPartitionInfo;
  keyFrameOffset?: number; temporalOffset?: number; flags?: number; isRandomAccessPoint?: boolean;
}
export interface EssenceIndex { packets: EssenceIndexEntry[]; partitions: MxfPartitionInfo[]; frameRate: number }
export interface EssenceRangeOptions { startFrame: number; endFrame: number; prerollFrames?: number; signal?: AbortSignal; maxReadSize?: number; kinds?: Array<EssenceIndexEntry["kind"]>; trackNumbers?:number[] }
export interface ReadEssencePacket extends EssenceIndexEntry { data: Uint8Array }
type EntryLookup = Map<number, MxfIndexTable["entries"][number]>;

const hex = (data: Uint8Array) => Array.from(data, value => value.toString(16).padStart(2, "0")).join("");
function essenceKind(key: Uint8Array): EssenceIndexEntry["kind"] | undefined {
  if (hex(key.subarray(0, 12)) !== "060e2b34010201010d010301") return;
  return key[12] === 0x15 ? "video" : key[12] === 0x16 ? "audio" : "unknown";
}
function partitionFor(offset: bigint, partitions: MxfPartitionInfo[]): MxfPartitionInfo | undefined {
  let found: MxfPartitionInfo | undefined;
  for (const candidate of partitions) { if (candidate.offset > offset) break; found = candidate; }
  return found;
}

/**
 * One Index Table Segment per Body Partition is the ordinary MXF shape, so several segments sharing
 * a SID are slices of one index rather than a conflict. Entries already carry absolute edit units
 * (startPosition + i), so combining them is a union; the earliest segment wins any overlap. Treating
 * repeats as ambiguous instead left every edit unit past the first segment with no index data, which
 * silently disabled key-frame seeking and decimated playback over most of a long file.
 */
/** SID 0 is MXF's "none"; treating it as an identifier attaches indexes to the wrong stream. */
const sid = (value: number | undefined) => value === undefined || value === 0 ? undefined : value;

function mergeSegments(tables: MxfIndexTable[]): EntryLookup | undefined {
  const lookup: EntryLookup = new Map();
  for (const table of [...tables].sort((a, b) => a.startPosition - b.startPosition))
    for (const entry of table.entries) {
      const existing = lookup.get(entry.editUnit);
      // Segments of one index are disjoint. Two different descriptions of the same edit unit are a
      // real contradiction, so the group is dropped rather than silently resolved; a repeat of the
      // identical entry, which some writers put in the footer, is not.
      if (!existing) { lookup.set(entry.editUnit, entry); continue; }
      if (existing.streamOffset !== entry.streamOffset || existing.keyFrameOffset !== entry.keyFrameOffset) return undefined;
    }
  return lookup;
}

function lookupsBy(tables: MxfIndexTable[], field: "bodySid" | "indexSid"): Map<number, EntryLookup> {
  const grouped = new Map<number, MxfIndexTable[]>();
  for (const table of tables) {
    const value = sid(table[field]); if (value === undefined) continue;
    grouped.set(value, [...(grouped.get(value) ?? []), table]);
  }
  const result = new Map<number, EntryLookup>();
  for (const [value, group] of grouped) { const merged = mergeSegments(group); if (merged) result.set(value, merged); }
  return result;
}

function indexLookups(tables: MxfIndexTable[]) {
  // An IndexSID names one index stream, so its segments merge even when they carry different
  // BodySIDs: a segment written into the footer partition indexes the same essence but is stamped
  // with that partition's BodySID (commonly 0). Grouping on BodySID alone therefore split one index
  // in two and left everything past the first segment unindexed.
  const indexSidForBodySid = new Map<number, number>();
  for (const table of tables)
    if (sid(table.bodySid) !== undefined && sid(table.indexSid) !== undefined && !indexSidForBodySid.has(table.bodySid!)) indexSidForBodySid.set(table.bodySid!, table.indexSid!);
  // Segments naming no SID at all cannot be attributed, so they are trusted only when none does.
  const unattributed = tables.every(table => sid(table.bodySid) === undefined && sid(table.indexSid) === undefined);
  return { byBodySid: lookupsBy(tables, "bodySid"), byIndexSid: lookupsBy(tables, "indexSid"), indexSidForBodySid, sole: unattributed && tables.length ? mergeSegments(tables) : undefined };
}

/** Builds a lightweight KLV map. Values are skipped using BER lengths and are never read. */
export async function indexMxfEssence(reader: RandomAccessReader, options: { partitions?: MxfPartitionInfo[]; indexTables?: MxfIndexTable[]; frameRate?: number; signal?: AbortSignal } = {}): Promise<EssenceIndex> {
  const partitions = [...(options.partitions ?? [])].sort((a, b) => a.offset < b.offset ? -1 : 1);
  const frameRate = options.frameRate ?? 30000 / 1001, packets: EssenceIndexEntry[] = [];
  const lookups = indexLookups(options.indexTables ?? []);
  const counts = new Map<string, number>();
  let offset = 0n;
  while (offset < reader.size) {
    if (options.signal?.aborted) throw abortError();
    let header: KlvHeader;
    try { header = await readKlvHeader(reader, offset, options.signal); } catch (error) { if ((error as Error).name === "AbortError") throw error; break; }
    const kind = essenceKind(header.key);
    if (kind) {
      const owner = partitionFor(offset, partitions);
      const trackNumber = header.key[13] * 0x10000 + header.key[14] * 0x100 + header.key[15];
      // A single essence track can continue through multiple Body Partitions.
      // Its edit-unit timeline must not restart when the owning partition changes.
      const streamKey = `${kind}:${trackNumber}`;
      const editUnit = counts.get(streamKey) ?? 0; counts.set(streamKey, editUnit + 1);
      // MXF Index Tables describe picture edit units here. Never attach an ambiguous
      // table (or a picture table to sound); missing data deliberately uses preroll.
      const ownerBodySid = sid(owner?.bodySid), indexSid = sid(owner?.indexSid) ?? (ownerBodySid !== undefined ? lookups.indexSidForBodySid.get(ownerBodySid) : undefined);
      const lookup = kind === "video" ?
        (indexSid !== undefined ? lookups.byIndexSid.get(indexSid) : undefined) ??
        (ownerBodySid !== undefined ? lookups.byBodySid.get(ownerBodySid) : undefined) ??
        lookups.sole : undefined;
      const tableEntry = lookup?.get(editUnit);
      packets.push({ offset, valueOffset: header.valueOffset, valueLength: header.valueLength, trackNumber, bodySID: owner?.bodySid, kind, editUnit, presentationTime: editUnit / frameRate, partition: owner, keyFrameOffset: tableEntry?.keyFrameOffset, temporalOffset: tableEntry?.temporalOffset, flags: tableEntry?.flags, isRandomAccessPoint: tableEntry?.isRandomAccessPoint });
    }
    if (header.nextOffset <= offset) throw new Error("Invalid zero-length KLV progression");
    offset = header.nextOffset;
  }
  return { packets, partitions, frameRate };
}

/**
 * Whether this packet can be decoded without any preceding one. The Index Entry says so three
 * different ways depending on the writer: a KeyFrameOffset of 0 points at itself, an explicit
 * RandomAccessPoint flag, or bit 7 of the entry flags. Nothing indexed means nothing decimatable.
 */
export function isRandomAccessVideoPacket(packet: EssenceIndexEntry): boolean {
  if (packet.keyFrameOffset !== undefined) return packet.keyFrameOffset === 0;
  if (packet.isRandomAccessPoint !== undefined) return packet.isRandomAccessPoint;
  if (packet.flags !== undefined) return (packet.flags & 0x80) !== 0;
  return false;
}

export function essenceDecodeStart(index: EssenceIndex, target: number, preroll = DEFAULT_ESSENCE_PREROLL_FRAMES): number {
  const videos = index.packets.filter(packet => packet.kind === "video" && packet.editUnit <= target);
  for (let at = videos.length - 1; at >= 0; at--) {
    const packet = videos[at];
    if (packet.keyFrameOffset !== undefined) return Math.max(0, packet.editUnit + packet.keyFrameOffset);
    if (packet.isRandomAccessPoint === true || packet.flags !== undefined && (packet.flags & 0x80) !== 0) return packet.editUnit;
  }
  return Math.max(0, target - Math.max(0, Math.trunc(preroll)));
}

async function readValue(reader: RandomAccessReader, packet: EssenceIndexEntry, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (packet.valueLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Essence value is too large");
  const output = new Uint8Array(Number(packet.valueLength));
  for (let written = 0; written < output.length;) {
    const length = Math.min(max, output.length - written);
    output.set(await reader.read(packet.valueOffset + BigInt(written), length, signal), written); written += length;
  }
  return output;
}

/** Reads only packets needed from a decode-safe point through the requested end frame. */
export async function readEssenceRange(reader: RandomAccessReader, index: EssenceIndex, options: EssenceRangeOptions): Promise<ReadEssencePacket[]> {
  const start = Math.max(0, Math.trunc(options.startFrame)), end = Math.max(start, Math.trunc(options.endFrame));
  const decodeStart = essenceDecodeStart(index, start, options.prerollFrames), max = options.maxReadSize ?? DEFAULT_ESSENCE_READ_SIZE;
  if (!Number.isSafeInteger(max) || max <= 0) throw new RangeError("maxReadSize must be positive");
  const kinds = new Set(options.kinds ?? ["video", "audio"]), tracks=options.trackNumbers&&new Set(options.trackNumbers), selected = index.packets.filter(packet => kinds.has(packet.kind) && (!tracks||tracks.has(packet.trackNumber)) && packet.editUnit >= decodeStart && packet.editUnit <= end);
  const result: ReadEssencePacket[] = [];
  for (const packet of selected) { if (options.signal?.aborted) throw abortError(); result.push({ ...packet, data: await readValue(reader, packet, max, options.signal) }); }
  return result;
}
