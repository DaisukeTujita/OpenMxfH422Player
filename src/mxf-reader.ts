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
const MAX_STANDARD_RUN_IN_BYTES = 65535;
const MAX_COMPATIBILITY_PROLOGUE_BYTES = 4 * 1024 * 1024;
const RUN_IN_SCAN_CHUNK_BYTES = 4096;

async function firstMxfOffset(reader: RandomAccessReader, signal?: AbortSignal, requirePartition = false): Promise<bigint | undefined> {
  console.info("[H422Player] MXF start discovery", {readerSize:String(reader.size),requirePartition,maxStandardRunInBytes:MAX_STANDARD_RUN_IN_BYTES,maxCompatibilityPrologueBytes:MAX_COMPATIBILITY_PROLOGUE_BYTES,scanChunkBytes:RUN_IN_SCAN_CHUNK_BYTES});
  if (reader.size < 16n) { console.warn("[H422Player] MXF start discovery: file is shorter than a KLV key"); return; }
  const firstKey = await reader.read(0n, 16, signal);
  const startsWithUl = firstKey[0] === 0x06 && firstKey[1] === 0x0e && firstKey[2] === 0x2b && firstKey[3] === 0x34;
  console.info("[H422Player] MXF first key bytes", {hex:hex(firstKey),startsWithUl});
  if (!requirePartition && startsWithUl) {
    try { await readKlvHeader(reader, 0n, signal); console.info("[H422Player] MXF start discovery: valid KLV at offset 0"); return 0n; }
    catch (error) { if ((error as Error).name === "AbortError") throw error; }
  }
  const scanLimit = Math.min(MAX_COMPATIBILITY_PROLOGUE_BYTES, Math.max(0, Number(reader.size - 16n)));
  console.info("[H422Player] MXF prologue scan:start", {scanLimit});
  for (let start = 0; start <= scanLimit; start += RUN_IN_SCAN_CHUNK_BYTES) {
    const available = reader.size - BigInt(start);
    if (available < 16n) break;
    const length = Number(available < BigInt(RUN_IN_SCAN_CHUNK_BYTES + 15) ? available : BigInt(RUN_IN_SCAN_CHUNK_BYTES + 15));
    const bytes = await reader.read(BigInt(start), length, signal);
    const last = Math.min(RUN_IN_SCAN_CHUNK_BYTES - 1, scanLimit - start, bytes.length - 16);
    for (let relative = start === 0 ? 1 : 0; relative <= last; relative++) {
      if (bytes[relative] !== 0x06 || bytes[relative + 1] !== 0x0e || bytes[relative + 2] !== 0x2b || bytes[relative + 3] !== 0x34) continue;
      const offset = start + relative, key = bytes.subarray(relative, relative + 16);
      if (!isPartition(key)) continue;
      try { await readKlvHeader(reader, BigInt(offset), signal); console.info("[H422Player] MXF prologue scan:Partition Pack found", {offset,kind:partitionKind(key),standardRunIn:offset<=MAX_STANDARD_RUN_IN_BYTES}); return BigInt(offset); }
      catch (error) { if ((error as Error).name === "AbortError") throw error; }
    }
  }
  console.warn("[H422Player] MXF prologue scan:no Partition Pack found", {searchedThrough:scanLimit,firstKey:hex(firstKey)});
}

function partition(offset: bigint, key: Uint8Array, value: Uint8Array): MxfPartitionInfo {
  const result: MxfPartitionInfo = { offset, kind: partitionKind(key) };
  if (value.length >= 64) { result.headerByteCount = u64(value, 32); result.indexByteCount = u64(value, 40); result.indexSid = u32(value, 48); result.bodySid = u32(value, 60); }
  return result;
}

async function ripOffsets(reader: RandomAccessReader, signal?: AbortSignal): Promise<bigint[] | undefined> {
  if (reader.size < 20n) return;
  const tail = await reader.read(reader.size - 4n, 4, signal), length = BigInt(u32(tail, 0));
  if (length < 20n || length > reader.size || length > 4n * 1024n * 1024n) return;
  const ripOffset = reader.size - length, header = await readKlvHeader(reader, ripOffset, signal);
  if (!hex(header.key).startsWith("060e2b34020501010d0102010111") || header.nextOffset !== reader.size) return;
  const bytes = await reader.read(ripOffset, Number(length), signal);
  // RIP entries are (BodySID:uint32, ByteOffset:uint64); trailing uint32 is total RIP length.
  const first = bytes[16], ber = (first & 0x80) ? 1 + (first & 0x7f) : 1, valueStart = 16 + ber;
  if ((bytes.length - 4 - valueStart) % 12 !== 0) return;
  const offsets: bigint[] = []; for (let at = valueStart; at + 12 <= bytes.length - 4; at += 12) offsets.push(u64(bytes, at + 4));
  if (!offsets.length || offsets.some((offset, index) => offset >= ripOffset || (index > 0 && offset <= offsets[index - 1]))) return;
  return offsets;
}

function checkedEnd(start: bigint, length: bigint, size: bigint, label: string): bigint {
  if (length < 0n || start < 0n || start > size || length > size - start) throw new Error(`${label} range exceeds file size`);
  return start + length;
}

async function parseRange(reader: RandomAccessReader, start: bigint, end: bigint, result: MxfMetadataResult, rates: Array<readonly [number, number]>, max: number, signal?: AbortSignal, owner?: MxfPartitionInfo): Promise<void> {
  let offset = start;
  while (offset < end) {
    const header = await readKlvHeader(reader, offset, signal);
    const crossesDeclaredEnd = header.nextOffset > end;
    if (isMetadata(header.key) && header.valueLength <= BigInt(max)) {
      const previousTableCount = result.indexTables.length;
      parseMxfMetadataKlv(result, header.key, await readKlvValue(reader, header, max, signal), rates);
      for (let index = previousTableCount; index < result.indexTables.length; index++) {
        result.indexTables[index].bodySid = owner?.bodySid;
        result.indexTables[index].indexSid = owner?.indexSid;
      }
    }
    if (crossesDeclaredEnd) {
      console.warn("[H422Player] MXF metadata KLV crosses declared partition boundary; parsed bounded value then stopped", {offset:String(offset),declaredEnd:String(end),klvEnd:String(header.nextOffset),overrunBytes:String(header.nextOffset-end),key:hex(header.key),parsed:isMetadata(header.key)&&header.valueLength<=BigInt(max)});
      break;
    }
    offset = header.nextOffset;
  }
}

async function parseFromRip(reader: RandomAccessReader, offsets: bigint[], result: MxfMetadataResult, rates: Array<readonly [number, number]>, max: number, signal?: AbortSignal): Promise<MxfPartitionInfo[]> {
  const partitions: MxfPartitionInfo[] = [];
  for (const offset of offsets) {
    console.info("[H422Player] MXF RIP partition:read", {offset:String(offset)});
    const header = await readKlvHeader(reader, offset, signal);
    console.info("[H422Player] MXF RIP partition:header", {offset:String(offset),key:hex(header.key),valueLength:String(header.valueLength),isPartition:isPartition(header.key)});
    if (!isPartition(header.key) || header.valueLength > BigInt(max)) throw new Error(`RIP points to an invalid Partition Pack at ${offset} (key=${hex(header.key)}, valueLength=${header.valueLength})`);
    const value = await readKlvValue(reader, header, max, signal), info = partition(offset, header.key, value);
    partitions.push(info); parseMxfMetadataKlv(result, header.key, value, rates);
    const headerEnd = checkedEnd(header.nextOffset, info.headerByteCount ?? 0n, reader.size, "Header Metadata");
    const indexEnd = checkedEnd(headerEnd, info.indexByteCount ?? 0n, reader.size, "Index");
    if (info.headerByteCount) await parseRange(reader, header.nextOffset, headerEnd, result, rates, max, signal, info);
    if (info.indexByteCount) await parseRange(reader, headerEnd, indexEnd, result, rates, max, signal, info);
  }
  return partitions;
}

/** Parses metadata and index KLVs while skipping essence values by their BER lengths. */
export async function parseMxfMetadataFromReader(reader: RandomAccessReader, options: { signal?: AbortSignal; maxMetadataValueSize?: number } = {}): Promise<MxfReaderResult> {
  console.info("[H422Player] MXF metadata parse:start", {readerSize:String(reader.size)});
  const { signal } = options, max = options.maxMetadataValueSize ?? 4 * 1024 * 1024;
  let result = createMxfMetadataResult(), rates: Array<readonly [number, number]> = [], partitions: MxfPartitionInfo[] = [];
  const rip = await ripOffsets(reader, signal).catch(error => { if ((error as Error).name === "AbortError") throw error; return undefined; });
  console.info("[H422Player] MXF RIP probe", {found:Boolean(rip),offsetCount:rip?.length??0});
  if (rip) {
    try {
      partitions = await parseFromRip(reader, rip, result, rates, max, signal);
      console.info("[H422Player] MXF metadata parse:complete via RIP", {partitionCount:partitions.length});
      return Object.assign(finalizeMxfMetadata(result, rates), { partitions, usedRandomIndexPack: true });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      console.warn("[H422Player] MXF RIP parse failed; falling back to prologue discovery", {offsets:rip.map(String),reason:error instanceof Error?error.message:String(error),error});
      // A structurally invalid RIP/partition map falls back to bounded-value sequential discovery.
      result = createMxfMetadataResult(); rates = []; partitions = [];
    }
  }
  // Standard MXF run-in is bounded at 65,535 bytes. Some field-generated files
  // contain a longer vendor prologue, so streaming performs a bounded 4 MiB
  // compatibility scan instead of falling back to a full-file search.
  const initialOffset = await firstMxfOffset(reader, signal) ?? 0n;
  const parseSequentially = async (start: bigint): Promise<boolean> => {
    let offset = start;
    while (offset < reader.size) {
      let header;
      try { header = await readKlvHeader(reader, offset, signal); }
      catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        console.warn("[H422Player] MXF sequential KLV walk stopped", {offset:String(offset),reason:error instanceof Error?error.message:String(error)});
        return false;
      }
      if (isMetadata(header.key) && header.valueLength <= BigInt(max)) {
        const value = await readKlvValue(reader, header, max, signal);
        parseMxfMetadataKlv(result, header.key, value, rates);
        if (isPartition(header.key) && !partitions.some(item => item.offset === offset)) partitions.push(partition(offset, header.key, value));
      }
      offset = header.nextOffset;
    }
    return true;
  };
  const reachedEnd = await parseSequentially(initialOffset);
  if (!reachedEnd && initialOffset === 0n && partitions.length === 0) {
    console.info("[H422Player] MXF metadata parse:retrying with Partition-only run-in scan");
    const runInOffset = await firstMxfOffset(reader, signal, true);
    if (runInOffset !== undefined) {
      result = createMxfMetadataResult(); rates = []; partitions = [];
      await parseSequentially(runInOffset);
    }
  }
  console.info("[H422Player] MXF metadata parse:complete sequentially", {initialOffset:String(initialOffset),reachedEnd,partitionCount:partitions.length,indexTableCount:result.indexTables.length,timecodeTrackCount:result.timecodes.length});
  return Object.assign(finalizeMxfMetadata(result, rates), { partitions: partitions.sort((a, b) => a.offset < b.offset ? -1 : 1), usedRandomIndexPack: false });
}
