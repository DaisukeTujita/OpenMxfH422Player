export interface RandomAccessReader {
  readonly size: bigint;
  read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ReaderStats {
  readRequestCount: number; underlyingReadCount: number; cacheHitCount: number;
  bytesRequested: bigint; bytesLoaded: bigint; cachedBytes: number;
  inFlightCount: number; largestUnderlyingRead: number;
}

export interface FileRandomAccessReaderOptions {
  chunkSize?: number;
  maxCacheBytes?: number;
  maxReadSize?: number;
  debug?: boolean | ((message: string) => void);
}

export const DEFAULT_READER_CHUNK_SIZE = 1024 * 1024;
export const DEFAULT_READER_CACHE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_READER_MAX_READ_SIZE = 4 * 1024 * 1024;

type Pending = { promise: Promise<Uint8Array>; waiters: number };

export function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function validateInteger(name: string, value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new RangeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
}

/** Random access over a Blob using aligned, bounded Blob.slice() reads. */
export class FileRandomAccessReader implements RandomAccessReader {
  readonly size: bigint;
  readonly chunkSize: number; readonly maxCacheBytes: number; readonly maxReadSize: number;
  private cache = new Map<bigint, Uint8Array>(); private cachedBytes = 0;
  private pending = new Map<bigint, Pending>(); private disposed = false;
  private readonly destroyController = new AbortController();
  private stats: ReaderStats = { readRequestCount: 0, underlyingReadCount: 0, cacheHitCount: 0, bytesRequested: 0n, bytesLoaded: 0n, cachedBytes: 0, inFlightCount: 0, largestUnderlyingRead: 0 };
  constructor(private readonly blob: Blob, options: FileRandomAccessReaderOptions = {}) {
    this.size = BigInt(blob.size);
    this.chunkSize = options.chunkSize ?? DEFAULT_READER_CHUNK_SIZE;
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_READER_CACHE_BYTES;
    this.maxReadSize = options.maxReadSize ?? DEFAULT_READER_MAX_READ_SIZE;
    validateInteger("chunkSize", this.chunkSize); validateInteger("maxCacheBytes", this.maxCacheBytes, true); validateInteger("maxReadSize", this.maxReadSize);
    if (this.chunkSize > this.maxReadSize) throw new RangeError("chunkSize must not exceed maxReadSize");
    this.debug = typeof options.debug === "function" ? options.debug : options.debug ? message => console.debug(message) : undefined;
  }
  private readonly debug?: (message: string) => void;
  getStats(): ReaderStats { return { ...this.stats, cachedBytes: this.cachedBytes, inFlightCount: this.pending.size }; }
  clear(): void { this.cache.clear(); this.cachedBytes = 0; }
  destroy(): void { this.disposed = true; this.destroyController.abort(); this.clear(); }
  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.disposed) throw new Error("Reader has been destroyed");
    if (signal?.aborted) throw abortError();
    if (offset < 0n) throw new RangeError("offset must not be negative");
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("offset exceeds JavaScript's safe integer range");
    validateInteger("length", length, true);
    if (length > this.maxReadSize) throw new RangeError(`length exceeds maximum read size (${this.maxReadSize})`);
    if (offset > this.size || BigInt(length) > this.size - offset) throw new RangeError("read range exceeds EOF");
    this.stats.readRequestCount++; this.stats.bytesRequested += BigInt(length);
    if (!length) return new Uint8Array();
    const first = offset / BigInt(this.chunkSize), last = (offset + BigInt(length) - 1n) / BigInt(this.chunkSize);
    const chunks: Uint8Array[] = [];
    for (let index = first; index <= last; index++) chunks.push(await this.getChunk(index, signal));
    if (signal?.aborted) throw abortError();
    const result = new Uint8Array(length); let written = 0;
    for (let index = first; index <= last; index++) {
      const chunk = chunks[Number(index - first)], chunkStart = index * BigInt(this.chunkSize);
      const from = Number((offset > chunkStart ? offset : chunkStart) - chunkStart);
      const count = Math.min(chunk.length - from, length - written);
      result.set(chunk.subarray(from, from + count), written); written += count;
    }
    return result;
  }
  private async getChunk(index: bigint, signal?: AbortSignal): Promise<Uint8Array> {
    const cached = this.cache.get(index);
    if (cached) { this.cache.delete(index); this.cache.set(index, cached); this.stats.cacheHitCount++; return cached; }
    let entry = this.pending.get(index);
    if (!entry) {
      entry = { waiters: 0, promise: this.loadChunk(index) };
      this.pending.set(index, entry);
      void entry.promise.finally(() => { if (this.pending.get(index) === entry) this.pending.delete(index); }).catch(() => {});
    }
    entry.waiters++;
    try { return await this.withAbort(this.withAbort(entry.promise, this.destroyController.signal), signal); }
    finally { entry.waiters--; }
  }
  private async loadChunk(index: bigint): Promise<Uint8Array> {
    const startBig = index * BigInt(this.chunkSize), endBig = startBig + BigInt(this.chunkSize) > this.size ? this.size : startBig + BigInt(this.chunkSize);
    if (startBig > BigInt(Number.MAX_SAFE_INTEGER) || endBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Blob slice range exceeds JavaScript's safe integer range");
    const length = Number(endBig - startBig); this.stats.underlyingReadCount++; this.stats.largestUnderlyingRead = Math.max(this.stats.largestUnderlyingRead, length);
    this.debug?.(`[RandomAccessReader] load ${startBig}+${length}`);
    const bytes = new Uint8Array(await this.blob.slice(Number(startBig), Number(endBig)).arrayBuffer());
    this.stats.bytesLoaded += BigInt(bytes.length);
    const entry = this.pending.get(index);
    if (!this.disposed && entry && entry.waiters > 0 && bytes.length <= this.maxCacheBytes) {
      while (this.cachedBytes + bytes.length > this.maxCacheBytes) { const oldest = this.cache.keys().next().value as bigint | undefined; if (oldest === undefined) break; const old = this.cache.get(oldest)!; this.cache.delete(oldest); this.cachedBytes -= old.length; }
      this.cache.set(index, bytes); this.cachedBytes += bytes.length;
    }
    return bytes;
  }
  private withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => { const abort = () => reject(abortError()); signal.addEventListener("abort", abort, { once: true }); promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)); });
  }
}
