import type { VideoRenderMode } from "./types";
import { toDecodeResult, type DecodeResult, type WireDecodeResult, type WorkerRequest } from "./video-decode-core";

export interface VideoDecoderClient {
  init(base: string): Promise<void>;
  decodeVideo(chunks: Uint8Array[], codecId: number, mediaFrames: number[], frameRate: number, videoRenderMode: VideoRenderMode, recycle?: ArrayBuffer[]): Promise<DecodeResult>;
  decodeStreamingVideo(chunks: Uint8Array[], mediaFrames: number[], frameRate: number, flush: boolean, loadGeneration: number, seekGeneration: number, codecId: number, videoRenderMode: VideoRenderMode, maxMediaFrame: number, recycle?: ArrayBuffer[]): Promise<DecodeResult>;
  invalidateStreaming(): void;
  dispose(): void;
}

interface WorkerResponse { id: number; ok: boolean; payload?: unknown; name?: string; message?: string; stack?: string }
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

function workerError(response: WorkerResponse): Error {
  const error = new Error(response.message ?? "Video decoder worker error");
  if (response.name) error.name = response.name;
  if (response.stack) error.stack = response.stack;
  return error;
}
// A plain `Omit<WorkerRequest, "id">` collapses the discriminated union (Omit only sees the
// intersection of member keys), so each variant is stripped of "id" individually instead.
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type WorkerRequestPayload = DistributiveOmit<WorkerRequest, "id">;

/** Runs libav.js decode, planar extraction, and YUV/RGBA conversion off the main thread. */
export function createWorkerVideoDecoderClient(): VideoDecoderClient {
  const worker = new Worker(new URL("./video-decode-worker.js", import.meta.url), { type: "module" });
  const pending = new Map<number, Pending>();
  let nextId = 1;

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id); if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.payload); else entry.reject(workerError(response));
  };
  worker.onerror = (event: ErrorEvent) => {
    const error = new Error(event.message || "Video decoder worker error");
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  // Recycled buffers are transferred, never cloned: a chunk's worth of planes is hundreds of megabytes.
  function send<T>(request: WorkerRequestPayload, transfer: ArrayBuffer[] = []): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...request, id } as WorkerRequest, transfer);
    });
  }

  return {
    init: base => send({ type: "init", base }),
    decodeVideo: (chunks, codecId, mediaFrames, frameRate, videoRenderMode, recycle = []) =>
      send<WireDecodeResult>({ type: "decode-legacy", chunks, codecId, mediaFrames, frameRate, videoRenderMode, recycle }, recycle).then(toDecodeResult),
    decodeStreamingVideo: (chunks, mediaFrames, frameRate, flush, loadGeneration, seekGeneration, codecId, videoRenderMode, maxMediaFrame, recycle = []) =>
      send<WireDecodeResult>({ type: "decode-streaming", chunks, mediaFrames, frameRate, flush, loadGeneration, seekGeneration, codecId, videoRenderMode, maxMediaFrame, recycle }, recycle).then(toDecodeResult),
    invalidateStreaming: () => { void send({ type: "invalidate-streaming" }).catch(() => undefined); },
    dispose: () => { void send({ type: "dispose" }).catch(() => undefined); worker.terminate(); },
  };
}
