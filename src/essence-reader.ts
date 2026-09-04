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

function uniqueTablesBy(tables: MxfIndexTable[], field: "bodySid" | "indexSid"): Map<number, MxfIndexTable> {
  const result = new Map<number, MxfIndexTable>(), ambiguous = new Set<number>();
  for (const table of tables) {
    const value = table[field]; if (value === undefined) continue;
    if (result.has(value)) { result.delete(value); ambiguous.add(value); }
    else if (!ambiguous.has(value)) result.set(value, table);
  }
  return result;
}

function indexLookups(tables: MxfIndexTable[]) {
  const entries = new Map<MxfIndexTable, EntryLookup>();
  for (const table of tables) entries.set(table, new Map(table.entries.map(entry => [entry.editUnit, entry])));
  return { entries, byBodySid: uniqueTablesBy(tables, "bodySid"), byIndexSid: uniqueTablesBy(tables, "indexSid"), sole: tables.length === 1 ? tables[0] : undefined };
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
      const soleMatches = lookups.sole &&
        (lookups.sole.bodySid === undefined || lookups.sole.bodySid === owner?.bodySid) &&
        (lookups.sole.indexSid === undefined || lookups.sole.indexSid === owner?.indexSid);
      const table = kind === "video" ?
        (owner?.bodySid !== undefined ? lookups.byBodySid.get(owner.bodySid) : undefined) ??
        (owner?.indexSid !== undefined ? lookups.byIndexSid.get(owner.indexSid) : undefined) ??
        (soleMatches ? lookups.sole : undefined) : undefined;
      const tableEntry = table ? lookups.entries.get(table)?.get(editUnit) : undefined;
      packets.push({ offset, valueOffset: header.valueOffset, valueLength: header.valueLength, trackNumber, bodySID: owner?.bodySid, kind, editUnit, presentationTime: editUnit / frameRate, partition: owner, keyFrameOffset: tableEntry?.keyFrameOffset, temporalOffset: tableEntry?.temporalOffset, flags: tableEntry?.flags, isRandomAccessPoint: tableEntry?.isRandomAccessPoint });
    }
    if (header.nextOffset <= offset) throw new Error("Invalid zero-length KLV progression");
    offset = header.nextOffset;
  }
  return { packets, partitions, frameRate };
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
