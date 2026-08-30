const HEADER_PARTITION = "060e2b34020501010d0102010102";
const BODY_PARTITION = "060e2b34020501010d0102010103";
const FOOTER_PARTITION = "060e2b34020501010d0102010104";

export interface EssencePacket {
  kind: "video" | "audio";
  trackNumber: number;
  bodyOffset: number;
  data: Uint8Array;
}

export interface ParsedMxf {
  packets: EssencePacket[];
  operationalPattern: "OP1a";
  isXdcamHd422: true;
  videoCodec: { codecId: 2; codecName: "mpeg2video" };
  audioCodec?: { codecId: 65549; codecName: "pcm_s24be" };
}

function hex(data: Uint8Array): string {
  return Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
}

/** Decode an MXF BER length. Exported to make malformed input independently testable. */
export function readBer(data: Uint8Array, offset: number): { value: number; bytes: number } {
  const first = data[offset];
  if (first === undefined) throw new Error("Truncated BER length");
  if ((first & 0x80) === 0) return { value: first, bytes: 1 };
  const count = first & 0x7f;
  if (!count || count > 6 || offset + count >= data.length) throw new Error("Invalid BER length");
  let value = 0;
  for (let i = 1; i <= count; i++) value = value * 256 + data[offset + i];
  if (!Number.isSafeInteger(value)) throw new Error("MXF item is too large");
  return { value, bytes: count + 1 };
}

function isPartition(key: string): boolean {
  const prefix = key.slice(0, 28);
  return prefix === HEADER_PARTITION || prefix === BODY_PARTITION || prefix === FOOTER_PARTITION;
}

function classifyEssence(key: Uint8Array): "video" | "audio" | undefined {
  // SMPTE 379-1 Generic Container essence element key. Item type 0x15 is picture,
  // 0x16 is sound; byte 12 is the item type and bytes 13..15 form the track number.
  if (hex(key.subarray(0, 12)) !== "060e2b34010201010d010301") return;
  if (key[12] === 0x15) return "video";
  if (key[12] === 0x16) return "audio";
}

/** Parse KLVs without rewriting or transcoding the source bytes. */
export function parseMxf(data: Uint8Array): ParsedMxf {
  if (data.length < 17) throw new Error("Not an MXF file: file is too small");
  let offset = 0;
  let op1a = false;
  let xdcam = false;
  const packets: EssencePacket[] = [];
  while (offset + 17 <= data.length) {
    const key = data.subarray(offset, offset + 16);
    const keyHex = hex(key);
    const ber = readBer(data, offset + 16);
    const start = offset + 16 + ber.bytes;
    const end = start + ber.value;
    if (end > data.length) throw new Error("Truncated MXF KLV value");
    if (isPartition(keyHex) && ber.value >= 80) {
      // OperationalPattern UL begins at byte 64 of a partition pack value.
      const op = hex(data.subarray(start + 64, start + 80));
      op1a ||= op.startsWith("060e2b34040101010d01020101");
    }
    const kind = classifyEssence(key);
    if (kind) {
      const trackNumber = key[13] * 0x10000 + key[14] * 0x100 + key[15];
      packets.push({ kind, trackNumber, bodyOffset: start, data: data.subarray(start, end) });
      // XDCAM HD422 picture essence uses MPEG-2 4:2:2 profile and begins with a sequence header.
      if (kind === "video" && data[start] === 0 && data[start + 1] === 0 && data[start + 2] === 1 && data[start + 3] === 0xb3) xdcam = true;
    }
    offset = end;
  }
  if (!op1a) throw new Error("Unsupported MXF: only OP1a is accepted");
  if (!packets.some(p => p.kind === "video") || !xdcam)
    throw new Error("Unsupported essence: expected XDCAM HD422 MPEG-2");
  return {
    packets, operationalPattern: "OP1a", isXdcamHd422: true,
    videoCodec: { codecId: 2, codecName: "mpeg2video" },
    audioCodec: packets.some(p => p.kind === "audio") ? { codecId: 65549, codecName: "pcm_s24be" } : undefined,
  };
}
