import { describe, expect, it } from "vitest";
import { FileRandomAccessReader } from "./random-access-reader";

class TrackingBlob extends Blob {
  slices: Array<[number, number]> = [];
  override slice(start?: number, end?: number, type?: string): Blob { this.slices.push([start ?? 0, end ?? this.size]); return super.slice(start, end, type); }
}
const bytes = (length: number) => Uint8Array.from({ length }, (_, i) => i & 0xff);

describe("FileRandomAccessReader", () => {
  it("reads only aligned ranges, crosses chunks, and returns isolated copies", async () => {
    const blob = new TrackingBlob([bytes(40)]), reader = new FileRandomAccessReader(blob, { chunkSize: 8, maxCacheBytes: 24, maxReadSize: 32 });
    const first = await reader.read(6n, 7); expect([...first]).toEqual([6,7,8,9,10,11,12]); expect(blob.slices).toEqual([[0,8],[8,16]]);
    first[0] = 99; expect((await reader.read(6n, 1))[0]).toBe(6); expect(reader.getStats().cacheHitCount).toBeGreaterThan(0);
  });
  it("handles zero and EOF and rejects invalid ranges", async () => {
    const reader = new FileRandomAccessReader(new Blob([bytes(10)]), { chunkSize: 4, maxReadSize: 8 });
    await expect(reader.read(10n, 0)).resolves.toHaveLength(0); await expect(reader.read(8n, 2)).resolves.toEqual(bytes(10).slice(8));
    await expect(reader.read(-1n, 1)).rejects.toThrow(RangeError); await expect(reader.read(9n, 2)).rejects.toThrow(/EOF/);
    await expect(reader.read(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0)).rejects.toThrow(/safe integer/); await expect(reader.read(0n, 9)).rejects.toThrow(/maximum/);
  });
  it("shares concurrent reads, retries failures, and enforces LRU capacity", async () => {
    let failures = 1;
    class FlakyBlob extends Blob { override slice(start?: number,end?: number): Blob { if (failures--) return { arrayBuffer: async () => { throw new Error("failed"); } } as Blob; return super.slice(start,end); } }
    const flaky = new FileRandomAccessReader(new FlakyBlob([bytes(16)]), { chunkSize: 4, maxCacheBytes: 8, maxReadSize: 8 });
    await expect(flaky.read(0n, 1)).rejects.toThrow("failed"); await expect(flaky.read(0n, 1)).resolves.toEqual(new Uint8Array([0]));
    const blob = new TrackingBlob([bytes(20)]), reader = new FileRandomAccessReader(blob, { chunkSize: 4, maxCacheBytes: 8, maxReadSize: 8 });
    await Promise.all([reader.read(4n,2),reader.read(5n,2)]); expect(reader.getStats().underlyingReadCount).toBe(1);
    await reader.read(0n,1); await reader.read(8n,1); expect(reader.getStats().cachedBytes).toBeLessThanOrEqual(8);
    await reader.read(4n,1); expect(reader.getStats().underlyingReadCount).toBe(4); // chunk 1 was LRU-evicted
  });
  it("aborts individual waiters without poisoning a shared request", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release=resolve; });
    class SlowBlob extends Blob { override slice(start?:number,end?:number): Blob { const sliced=super.slice(start,end); return { arrayBuffer: async()=>{await gate;return sliced.arrayBuffer();} } as Blob; } }
    const reader = new FileRandomAccessReader(new SlowBlob([bytes(8)]), { chunkSize: 4, maxReadSize: 4 }); const controller=new AbortController();
    const aborted=reader.read(0n,2,controller.signal), survivor=reader.read(1n,2); controller.abort(); release();
    await expect(aborted).rejects.toMatchObject({name:"AbortError"}); await expect(survivor).resolves.toEqual(new Uint8Array([1,2])); expect(reader.getStats().underlyingReadCount).toBe(1);
    const already=new AbortController();already.abort();await expect(reader.read(0n,1,already.signal)).rejects.toMatchObject({name:"AbortError"});
  });
  it("clears cached data and aborts waiters when destroyed",async()=>{const reader=new FileRandomAccessReader(new Blob([bytes(8)]),{chunkSize:4,maxReadSize:4});await reader.read(0n,1);expect(reader.getStats().cachedBytes).toBe(4);reader.destroy();expect(reader.getStats().cachedBytes).toBe(0);await expect(reader.read(0n,1)).rejects.toThrow(/destroyed/);});
});
