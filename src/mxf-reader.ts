import { readKlvHeader, readKlvValue } from "./klv-reader";
import { createMxfMetadataResult, finalizeMxfMetadata, parseMxfMetadataKlv, type MxfMetadataResult } from "./mxf-metadata";
import type { RandomAccessReader } from "./random-access-reader";

export interface MxfPartitionInfo { offset: bigint; kind: "header" | "body" | "footer" | "unknown"; bodySid?: number; indexSid?: number; headerByteCount?: bigint; indexByteCount?: bigint }
export interface MxfReaderResult extends MxfMetadataResult { partitions: MxfPartitionInfo[]; usedRandomIndexPack: boolean }
const hex = (data: Uint8Array) => Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
const u32 = (v: Uint8Array, at: number) => new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(at);
const u64 = (v: Uint8Array, at: number) => new DataView(v.buffer, v.byteOffset, v.byteLength).getBigUint64(at);
const partitionKind = (key: Uint8Array): MxfPartitionInfo["kind"] => ({ "02": "header", "03": "body", "04": "footer" })[key[13]?.toString(16).padStart(2, "0")] as MxfPartitionInfo["kind"] ?? "unknown";
const isPartition = (key: Uint8Array) => hex(key).startsWith("060e2b34020501010d01020101") && [2, 3, 4].includes(key[13]);
const isMetadata = (key: Uint8Array) => { const value = hex(key); return isPartition(key) || value.startsWith("060e2b3402530101"); };

function partition(offset: bigint, key: Uint8Array, value: Uint8Array): MxfPartitionInfo {
  const result: MxfPartitionInfo = { offset, kind: partitionKind(key) };
  if (value.length >= 64) { result.headerByteCount = u64(value, 32); result.indexByteCount = u64(value, 40); result.indexSid = u32(value, 48); result.bodySid = u32(value, 60); }
  return result;
}

async function ripOffsets(reader: RandomAccessReader, signal?: AbortSignal): Promise<bigint[] | undefined> {
  if (reader.size < 20n) return;
  const tail = await reader.read(reader.size - 4n, 4, signal), length = BigInt(u32(tail, 0));
  if (length < 20n || length > reader.size || length > 4n * 1024n * 1024n) return;
  const bytes = await reader.read(reader.size - length, Number(length), signal);
  if (!hex(bytes.subarray(0, 16)).startsWith("060e2b34020501010d0102010111")) return;
  // RIP entries are (BodySID:uint32, ByteOffset:uint64); trailing uint32 is total RIP length.
  const first = bytes[16], ber = (first & 0x80) ? 1 + (first & 0x7f) : 1, valueStart = 16 + ber;
  const offsets: bigint[] = []; for (let at = valueStart; at + 12 <= bytes.length - 4; at += 12) offsets.push(u64(bytes, at + 4));
  return offsets.length ? offsets : undefined;
}

/** Parses metadata and index KLVs while skipping essence values by their BER lengths. */
export async function parseMxfMetadataFromReader(reader: RandomAccessReader, options: { signal?: AbortSignal; maxMetadataValueSize?: number } = {}): Promise<MxfReaderResult> {
  const { signal } = options, max = options.maxMetadataValueSize ?? 4 * 1024 * 1024;
  const result = createMxfMetadataResult(), rates: Array<readonly [number, number]> = [], partitions: MxfPartitionInfo[] = [];
  const rip = await ripOffsets(reader, signal).catch(error => { if ((error as Error).name === "AbortError") throw error; return undefined; });
  // RIP offsets prioritize known partitions; a sequential scan remains authoritative for metadata between them.
  if (rip) for (const offset of rip) try { const header = await readKlvHeader(reader, offset, signal); if (isPartition(header.key) && header.valueLength <= BigInt(max)) partitions.push(partition(offset, header.key, await readKlvValue(reader, header, max, signal))); } catch (error) { if ((error as Error).name === "AbortError") throw error; }
  let offset = 0n;
  while (offset < reader.size) {
    let header; try { header = await readKlvHeader(reader, offset, signal); } catch (error) { if ((error as Error).name === "AbortError") throw error; break; }
    if (isMetadata(header.key) && header.valueLength <= BigInt(max)) {
      const value = await readKlvValue(reader, header, max, signal);
      parseMxfMetadataKlv(result, header.key, value, rates);
      if (isPartition(header.key) && !partitions.some(item => item.offset === offset)) partitions.push(partition(offset, header.key, value));
    }
    offset = header.nextOffset;
  }
  return Object.assign(finalizeMxfMetadata(result, rates), { partitions: partitions.sort((a, b) => a.offset < b.offset ? -1 : 1), usedRandomIndexPack: Boolean(rip) });
}
