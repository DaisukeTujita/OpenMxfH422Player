import type { VideoRenderMode } from "./types";
import type { DecodeResult, WorkerRequest } from "./video-decode-core";

export interface VideoDecoderClient {
  init(base: string): Promise<void>;
  decodeVideo(chunks: Uint8Array[], codecId: number, mediaFrames: number[], frameRate: number, videoRenderMode: VideoRenderMode): Promise<DecodeResult>;
  decodeStreamingVideo(chunks: Uint8Array[], mediaFrames: number[], frameRate: number, flush: boolean, loadGeneration: number, seekGeneration: number, codecId: number, videoRenderMode: VideoRenderMode, maxMediaFrame: number): Promise<DecodeResult>;
  invalidateStreaming(): void;
  dispose(): void;
}

interface WorkerResponse { id: number; ok: boolean; payload?: unknown; message?: string }
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
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
    const { id, ok, payload, message } = event.data;
    const entry = pending.get(id); if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(payload); else entry.reject(new Error(message ?? "Video decoder worker error"));
  };
  worker.onerror = (event: ErrorEvent) => {
    const error = new Error(event.message || "Video decoder worker error");
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  function send<T>(request: WorkerRequestPayload): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...request, id } as WorkerRequest);
    });
  }

  return {
    init: base => send({ type: "init", base }),
    decodeVideo: (chunks, codecId, mediaFrames, frameRate, videoRenderMode) =>
      send({ type: "decode-legacy", chunks, codecId, mediaFrames, frameRate, videoRenderMode }),
    decodeStreamingVideo: (chunks, mediaFrames, frameRate, flush, loadGeneration, seekGeneration, codecId, videoRenderMode, maxMediaFrame) =>
      send({ type: "decode-streaming", chunks, mediaFrames, frameRate, flush, loadGeneration, seekGeneration, codecId, videoRenderMode, maxMediaFrame }),
    invalidateStreaming: () => { void send({ type: "invalidate-streaming" }).catch(() => undefined); },
    dispose: () => { void send({ type: "dispose" }).catch(() => undefined); worker.terminate(); },
  };
}
