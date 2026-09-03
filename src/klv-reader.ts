import type { RandomAccessReader } from "./random-access-reader";

export interface KlvHeader { key: Uint8Array; valueOffset: bigint; valueLength: bigint; nextOffset: bigint }

/** Reads only a KLV header; callers decide whether to load or skip its value. */
export async function readKlvHeader(reader: RandomAccessReader, offset: bigint, signal?: AbortSignal): Promise<KlvHeader> {
  if (offset < 0n || offset > reader.size) throw new RangeError("KLV offset is outside the file");
  if (reader.size - offset < 17n) throw new Error("Truncated KLV header");
  const prefix = await reader.read(offset, 17, signal), first = prefix[16];
  let valueLength: bigint, berBytes = 1;
  if ((first & 0x80) === 0) valueLength = BigInt(first);
  else {
    const count = first & 0x7f;
    if (!count || count > 8) throw new Error("Invalid BER length");
    berBytes += count;
    if (reader.size - offset < BigInt(16 + berBytes)) throw new Error("Truncated BER length");
    const encoded = await reader.read(offset + 17n, count, signal);
    // MXF KLV commonly uses a fixed-width BER length (BER4), so leading zero
    // octets and long-form values below 128 are valid interoperability forms.
    valueLength = 0n; for (const byte of encoded) valueLength = (valueLength << 8n) | BigInt(byte);
  }
  const valueOffset = offset + BigInt(16 + berBytes), nextOffset = valueOffset + valueLength;
  if (nextOffset < valueOffset || nextOffset > reader.size) throw new Error("KLV value exceeds file range");
  return { key: prefix.slice(0, 16), valueOffset, valueLength, nextOffset };
}

export async function readKlvValue(reader: RandomAccessReader, header: KlvHeader, maxLength = 4 * 1024 * 1024, signal?: AbortSignal): Promise<Uint8Array> {
  if (header.valueLength > BigInt(maxLength) || header.valueLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("KLV value is too large to materialize");
  return reader.read(header.valueOffset, Number(header.valueLength), signal);
}
