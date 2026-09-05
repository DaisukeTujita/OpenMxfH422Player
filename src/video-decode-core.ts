import { loadCustomLibAV, type LibAV } from "./libav-loader";
import { yuv422pToRgba } from "./media";
import type { Yuv422Frame } from "./webgl";
import type { VideoRenderMode } from "./types";

export type RawDecodedFrame = { data?: Uint8Array; layout?: Array<{ offset: number; stride: number }>; width: number; height: number; format?: number; pts?: number };

/**
 * Frames cross the Worker boundary as plain objects holding only freshly allocated TypedArrays,
 * so every backing ArrayBuffer can be transferred instead of structured-cloned. A whole chunk of
 * 1080-line 4:2:2 frames is hundreds of megabytes; cloning it duplicates that in the serializer
 * and makes the reply fail with "Data cannot be cloned, out of memory".
 */
export type WireFrame =
  | { kind: "yuv422p"; width: number; height: number; y: Uint8Array; u: Uint8Array; v: Uint8Array }
  | { kind: "rgba"; width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };
export interface WireRenderFrame { frame: WireFrame; time: number; mediaFrame: number }
export interface WireDecodeResult { frames: WireRenderFrame[]; decodeMs: number; convertMs: number; pooledFrames: number }

export type WorkerRenderFrame = { frame: ImageData | Yuv422Frame; time: number; mediaFrame: number };
export interface DecodeResult { frames: WorkerRenderFrame[]; decodeMs: number; convertMs: number; pooledFrames: number }

/**
 * Planes are transferred to the main thread, so the Worker cannot reuse them on its own — the
 * buffers are gone. The engine hands them back once the playhead has passed them and they land
 * here. Without this a 1080-line 4:2:2 stream allocates ~4 MB per frame, so steady-state playback
 * produces well over 100 MB/s of garbage and the collector pauses show up as dropped frames.
 */
export class FrameBufferPool {
  private readonly free = new Map<number, ArrayBuffer[]>();
  private pooledBytes = 0;
  private budgetBytes = 0;
  private frameBytes = 0;

  /** Holding one chunk is enough to cover a decode from the eviction that preceded it; more is idle memory. */
  setChunkShape(framesPerChunk: number, bytesPerFrame: number): void {
    this.frameBytes = bytesPerFrame;
    this.budgetBytes = Math.max(0, framesPerChunk) * bytesPerFrame;
    this.trim();
  }

  take(byteLength: number): ArrayBuffer {
    const buffers = this.free.get(byteLength), buffer = buffers?.pop();
    if (!buffer) return new ArrayBuffer(byteLength);
    this.pooledBytes -= byteLength;
    return buffer;
  }

  recycle(buffers: readonly ArrayBuffer[] | undefined): void {
    for (const buffer of buffers ?? []) {
      // A buffer that was transferred onward arrives detached; there is nothing left to reuse.
      if (buffer.byteLength === 0 || this.pooledBytes + buffer.byteLength > this.budgetBytes) continue;
      const free = this.free.get(buffer.byteLength);
      if (free) free.push(buffer); else this.free.set(buffer.byteLength, [buffer]);
      this.pooledBytes += buffer.byteLength;
    }
  }

  /** Reported as the `pooledVideoFrames` diagnostic: memory parked and ready to reuse, in frames rather than buffers. */
  get pooledFrames(): number { return this.frameBytes > 0 ? Math.floor(this.pooledBytes / this.frameBytes) : 0; }

  private trim(): void {
    for (const [size, buffers] of this.free) {
      while (this.pooledBytes > this.budgetBytes && buffers.length) { buffers.pop(); this.pooledBytes -= size; }
      if (!buffers.length) this.free.delete(size);
    }
  }
}

/** Every buffer is allocated per frame, so the Set only guards against a caller passing one result twice. */
export function decodeResultTransferables(result: WireDecodeResult): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const { frame } of result.frames) {
    if (frame.kind === "rgba") buffers.add(frame.data.buffer as ArrayBuffer);
    else for (const plane of [frame.y, frame.u, frame.v]) buffers.add(plane.buffer as ArrayBuffer);
  }
  return [...buffers];
}

/** A yuv422p wire frame already satisfies Yuv422Frame; only RGBA needs its ImageData rebuilt. */
export function toDecodeResult(wire: WireDecodeResult): DecodeResult {
  return {
    decodeMs: wire.decodeMs, convertMs: wire.convertMs, pooledFrames: wire.pooledFrames,
    frames: wire.frames.map(({ frame, time, mediaFrame }) => ({ time, mediaFrame, frame: frame.kind === "rgba" ? new ImageData(frame.data, frame.width, frame.height) : frame })),
  };
}

/**
 * The buffers behind a frame the engine has finished with, so they can be transferred back to the
 * Worker's pool. Only call this once the frame has left the queue: transferring detaches it.
 */
export function renderFrameBuffers(frame: ImageData | Yuv422Frame): ArrayBuffer[] {
  return "u" in frame ? [frame.y.buffer as ArrayBuffer, frame.u.buffer as ArrayBuffer, frame.v.buffer as ArrayBuffer] : [frame.data.buffer as ArrayBuffer];
}

/** Requests are serialized by the Worker, so a decoder is never in use when it is freed; `disposed` only guards against freeing the same context twice. */
interface StreamingDecoderState { av: LibAV; codecId: number; ctx: number; pkt: number; frame: number; loadGeneration: number; seekGeneration: number; disposed: boolean }

export interface DecodeWorkerState { av?: LibAV; streaming?: StreamingDecoderState; pool: FrameBufferPool }

export function createDecodeWorkerState(): DecodeWorkerState { return { pool: new FrameBufferPool() }; }

export async function initDecoder(state: DecodeWorkerState, base: string): Promise<void> {
  const av = await loadCustomLibAV(base);
  if (await av.libavjs_with_swscale?.() !== 1) throw new Error("Custom libav.js was built without swscale");
  state.av = av;
}

/** Every byte of each plane is overwritten row by row, so a recycled buffer needs no clearing first. */
function extractPlanes(f: RawDecodedFrame, av: LibAV, pool: FrameBufferPool): { y: Uint8Array; u: Uint8Array; v: Uint8Array } {
  if (f.format !== av.AV_PIX_FMT_YUV422P || !f.layout || f.layout.length < 3)
    throw new Error(`Expected yuv422p planes from MPEG-2 decoder (pixel format ${f.format ?? "unknown"})`);
  const chromaWidth = Math.ceil(f.width / 2);
  const plane = (index: number, width: number) => {
    const output = new Uint8Array(pool.take(width * f.height)), layout = f.layout![index];
    for (let row = 0; row < f.height; row++) output.set(f.data!.subarray(layout.offset + row * layout.stride, layout.offset + row * layout.stride + width), row * width);
    return output;
  };
  return { y: plane(0, f.width), u: plane(1, chromaWidth), v: plane(2, chromaWidth) };
}

/**
 * Legacy decodes the whole file in one shot, so a decoded PTS is only trusted when it maps
 * back onto one of the packets in this same batch. Streaming decodes bounded chunks with a
 * persistent decoder, so a decoded PTS may still belong to a neighboring chunk still draining
 * the decoder's reorder buffer; it is instead validated against the whole media's frame range.
 */
function buildFrames(decoded: RawDecodedFrame[], av: LibAV, pool: FrameBufferPool, mediaFrames: number[], frameRate: number, videoRenderMode: VideoRenderMode, ptsValidation: { mode: "input-set" } | { mode: "media-range"; maxMediaFrame: number }): { frames: WireRenderFrame[]; convertMs: number } {
  const frames: WireRenderFrame[] = []; let convertMs = 0;
  const inputMediaFrames = ptsValidation.mode === "input-set" ? new Set(mediaFrames) : undefined;
  for (let i = 0; i < decoded.length; i++) {
    const f = decoded[i]; if (!f.data) continue;
    const { y, u, v } = extractPlanes(f, av, pool);
    let renderFrame: WireFrame;
    if (videoRenderMode === "yuv-webgl") renderFrame = { kind: "yuv422p", width: f.width, height: f.height, y, u, v };
    else {
      const started = performance.now();
      // The planes are scratch in this mode: hand them straight back rather than pooling only the output.
      const rgba = yuv422pToRgba(y, u, v, f.width, f.height, new Uint8ClampedArray(pool.take(f.width * f.height * 4)));
      convertMs += performance.now() - started;
      pool.recycle([y.buffer as ArrayBuffer, u.buffer as ArrayBuffer, v.buffer as ArrayBuffer]);
      renderFrame = { kind: "rgba", width: f.width, height: f.height, data: rgba };
    }
    const decodedPts = f.pts === undefined ? Number.NaN : Number(f.pts);
    const mediaFrame = ptsValidation.mode === "input-set"
      ? (Number.isSafeInteger(decodedPts) && inputMediaFrames!.has(decodedPts) ? decodedPts : mediaFrames[i] ?? i)
      : (Number.isSafeInteger(decodedPts) && decodedPts >= 0 && decodedPts < ptsValidation.maxMediaFrame ? decodedPts : mediaFrames[i] ?? i);
    frames.push({ frame: renderFrame, time: mediaFrame / frameRate, mediaFrame });
  }
  return { frames, convertMs };
}

/** `recycle` carries the plane buffers the engine has finished with, transferred back for reuse. */
export interface DecodeLegacyRequest { codecId: number; chunks: Uint8Array[]; mediaFrames: number[]; frameRate: number; videoRenderMode: VideoRenderMode; recycle?: ArrayBuffer[] }

export async function decodeLegacy(state: DecodeWorkerState, request: DecodeLegacyRequest): Promise<WireDecodeResult> {
  const av = state.av!;
  state.pool.recycle(request.recycle);
  // ff_init_decoder receives the codec_id detected for the MXF essence (AV_CODEC_ID_MPEG2VIDEO=2).
  const [, ctx, pkt, frame] = await av.ff_init_decoder(request.codecId);
  let decodeFailure: { error: unknown } | undefined; let result: WireDecodeResult = { frames: [], decodeMs: 0, convertMs: 0, pooledFrames: 0 };
  try {
    const rateScale = Number.isInteger(request.frameRate) ? 1 : 1001, rateDenominator = Math.round(request.frameRate * rateScale);
    const packets = request.chunks.map((data, i) => ({ data, pts: request.mediaFrames[i] ?? i, time_base_num: rateScale, time_base_den: rateDenominator }));
    const started = performance.now();
    const decoded = await av.ff_decode_multi(ctx, pkt, frame, packets, true) as RawDecodedFrame[];
    const decodeMs = performance.now() - started;
    const { frames, convertMs } = buildFrames(decoded, av, state.pool, request.mediaFrames, request.frameRate, request.videoRenderMode, { mode: "input-set" });
    result = { frames, decodeMs, convertMs, pooledFrames: state.pool.pooledFrames };
  } catch (error) {
    decodeFailure = { error };
  }
  try { await av.ff_free_decoder(ctx, pkt, frame); }
  catch (error) { if (!decodeFailure) throw error; }
  if (decodeFailure) throw decodeFailure.error;
  return result;
}

export interface DecodeStreamingRequest { codecId: number; chunks: Uint8Array[]; mediaFrames: number[]; frameRate: number; flush: boolean; loadGeneration: number; seekGeneration: number; videoRenderMode: VideoRenderMode; maxMediaFrame: number; recycle?: ArrayBuffer[] }

async function freeStreamingDecoder(decoder: StreamingDecoderState): Promise<void> {
  if (decoder.disposed) return;
  decoder.disposed = true;
  await decoder.av.ff_free_decoder(decoder.ctx, decoder.pkt, decoder.frame);
}

function hasReusableStreamingDecoder(state: DecodeWorkerState, request: DecodeStreamingRequest): boolean {
  const decoder = state.streaming;
  return Boolean(decoder && !decoder.disposed && decoder.loadGeneration === request.loadGeneration && decoder.seekGeneration === request.seekGeneration && decoder.codecId === request.codecId);
}

export async function decodeStreaming(state: DecodeWorkerState, request: DecodeStreamingRequest): Promise<WireDecodeResult> {
  const av = state.av!;
  state.pool.recycle(request.recycle);
  // Read before decoding: this is what the pool had available to reuse. Reading it afterwards would
  // always report ~0, because building the chunk's frames is exactly what drains it.
  const pooledFrames = state.pool.pooledFrames;
  if (!hasReusableStreamingDecoder(state, request)) {
    // Free the superseded decoder before allocating its replacement, so two contexts never hold
    // reference frames for the same stream at the same time.
    await invalidateStreaming(state);
    const [, ctx, pkt, frame] = await av.ff_init_decoder(request.codecId);
    state.streaming = { av, codecId: request.codecId, ctx, pkt, frame, loadGeneration: request.loadGeneration, seekGeneration: request.seekGeneration, disposed: false };
  }
  const decoder = state.streaming!;
  let failure: unknown; let result: WireDecodeResult = { frames: [], decodeMs: 0, convertMs: 0, pooledFrames };
  try {
    const rateScale = Number.isInteger(request.frameRate) ? 1 : 1001, rateDenominator = Math.round(request.frameRate * rateScale);
    const packets = request.chunks.map((data, i) => ({ data, pts: request.mediaFrames[i] ?? i, time_base_num: rateScale, time_base_den: rateDenominator }));
    const started = performance.now();
    const decoded = await av.ff_decode_multi(decoder.ctx, decoder.pkt, decoder.frame, packets, request.flush) as RawDecodedFrame[];
    const decodeMs = performance.now() - started;
    const { frames, convertMs } = buildFrames(decoded, av, state.pool, request.mediaFrames, request.frameRate, request.videoRenderMode, { mode: "media-range", maxMediaFrame: request.maxMediaFrame });
    // Sized from what this chunk actually produced, so it tracks the stream's real frame size.
    const first = frames[0]?.frame;
    if (first) state.pool.setChunkShape(request.chunks.length, first.kind === "rgba" ? first.data.byteLength : first.y.byteLength + first.u.byteLength + first.v.byteLength);
    result = { frames, decodeMs, convertMs, pooledFrames };
  } catch (error) {
    failure = error;
  }
  if (request.flush || failure !== undefined) {
    if (state.streaming === decoder) state.streaming = undefined;
    try { await freeStreamingDecoder(decoder); } catch (error) { if (failure === undefined) failure = error; }
  }
  if (failure !== undefined) throw failure;
  return result;
}

export async function invalidateStreaming(state: DecodeWorkerState): Promise<void> {
  const decoder = state.streaming; state.streaming = undefined;
  if (decoder) await freeStreamingDecoder(decoder);
}

export type WorkerRequest =
  | { id: number; type: "init"; base: string }
  | ({ id: number; type: "decode-legacy" } & DecodeLegacyRequest)
  | ({ id: number; type: "decode-streaming" } & DecodeStreamingRequest)
  | { id: number; type: "invalidate-streaming" }
  | { id: number; type: "dispose" };

export async function handleWorkerRequest(state: DecodeWorkerState, request: WorkerRequest): Promise<WireDecodeResult | undefined> {
  switch (request.type) {
    case "init": await initDecoder(state, request.base); return undefined;
    case "decode-legacy": return decodeLegacy(state, request);
    case "decode-streaming": return decodeStreaming(state, request);
    case "invalidate-streaming": await invalidateStreaming(state); return undefined;
    case "dispose": await invalidateStreaming(state); state.av = undefined; return undefined;
  }
}
