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
export interface WireDecodeResult { frames: WireRenderFrame[]; decodeMs: number; convertMs: number }

export type WorkerRenderFrame = { frame: ImageData | Yuv422Frame; time: number; mediaFrame: number };
export interface DecodeResult { frames: WorkerRenderFrame[]; decodeMs: number; convertMs: number }

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
    decodeMs: wire.decodeMs, convertMs: wire.convertMs,
    frames: wire.frames.map(({ frame, time, mediaFrame }) => ({ time, mediaFrame, frame: frame.kind === "rgba" ? new ImageData(frame.data, frame.width, frame.height) : frame })),
  };
}

interface StreamingDecoderState { av: LibAV; codecId: number; ctx: number; pkt: number; frame: number; loadGeneration: number; seekGeneration: number; busy: boolean; disposeRequested: boolean; disposed: boolean }

export interface DecodeWorkerState { av?: LibAV; streaming?: StreamingDecoderState }

export function createDecodeWorkerState(): DecodeWorkerState { return {}; }

export async function initDecoder(state: DecodeWorkerState, base: string): Promise<void> {
  const av = await loadCustomLibAV(base);
  if (await av.libavjs_with_swscale?.() !== 1) throw new Error("Custom libav.js was built without swscale");
  state.av = av;
}

function extractPlanes(f: RawDecodedFrame, av: LibAV): { y: Uint8Array; u: Uint8Array; v: Uint8Array } {
  if (f.format !== av.AV_PIX_FMT_YUV422P || !f.layout || f.layout.length < 3)
    throw new Error(`Expected yuv422p planes from MPEG-2 decoder (pixel format ${f.format ?? "unknown"})`);
  const chromaWidth = Math.ceil(f.width / 2);
  const plane = (index: number, width: number) => {
    const output = new Uint8Array(width * f.height), layout = f.layout![index];
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
function buildFrames(decoded: RawDecodedFrame[], av: LibAV, mediaFrames: number[], frameRate: number, videoRenderMode: VideoRenderMode, ptsValidation: { mode: "input-set" } | { mode: "media-range"; maxMediaFrame: number }): { frames: WireRenderFrame[]; convertMs: number } {
  const frames: WireRenderFrame[] = []; let convertMs = 0;
  const inputMediaFrames = ptsValidation.mode === "input-set" ? new Set(mediaFrames) : undefined;
  for (let i = 0; i < decoded.length; i++) {
    const f = decoded[i]; if (!f.data) continue;
    const { y, u, v } = extractPlanes(f, av);
    let renderFrame: WireFrame;
    if (videoRenderMode === "yuv-webgl") renderFrame = { kind: "yuv422p", width: f.width, height: f.height, y, u, v };
    else {
      const started = performance.now();
      const rgba = yuv422pToRgba(y, u, v, f.width, f.height);
      convertMs += performance.now() - started;
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

export interface DecodeLegacyRequest { codecId: number; chunks: Uint8Array[]; mediaFrames: number[]; frameRate: number; videoRenderMode: VideoRenderMode }

export async function decodeLegacy(state: DecodeWorkerState, request: DecodeLegacyRequest): Promise<WireDecodeResult> {
  const av = state.av!;
  // ff_init_decoder receives the codec_id detected for the MXF essence (AV_CODEC_ID_MPEG2VIDEO=2).
  const [, ctx, pkt, frame] = await av.ff_init_decoder(request.codecId);
  let decodeFailure: { error: unknown } | undefined; let result: WireDecodeResult = { frames: [], decodeMs: 0, convertMs: 0 };
  try {
    const rateScale = Number.isInteger(request.frameRate) ? 1 : 1001, rateDenominator = Math.round(request.frameRate * rateScale);
    const packets = request.chunks.map((data, i) => ({ data, pts: request.mediaFrames[i] ?? i, time_base_num: rateScale, time_base_den: rateDenominator }));
    const started = performance.now();
    const decoded = await av.ff_decode_multi(ctx, pkt, frame, packets, true) as RawDecodedFrame[];
    const decodeMs = performance.now() - started;
    const { frames, convertMs } = buildFrames(decoded, av, request.mediaFrames, request.frameRate, request.videoRenderMode, { mode: "input-set" });
    result = { frames, decodeMs, convertMs };
  } catch (error) {
    decodeFailure = { error };
  }
  try { await av.ff_free_decoder(ctx, pkt, frame); }
  catch (error) { if (!decodeFailure) throw error; }
  if (decodeFailure) throw decodeFailure.error;
  return result;
}

export interface DecodeStreamingRequest { codecId: number; chunks: Uint8Array[]; mediaFrames: number[]; frameRate: number; flush: boolean; loadGeneration: number; seekGeneration: number; videoRenderMode: VideoRenderMode; maxMediaFrame: number }

async function freeStreamingDecoder(decoder: StreamingDecoderState): Promise<void> {
  if (decoder.disposed) return;
  decoder.disposed = true;
  await decoder.av.ff_free_decoder(decoder.ctx, decoder.pkt, decoder.frame);
}

function hasReusableStreamingDecoder(state: DecodeWorkerState, request: DecodeStreamingRequest): boolean {
  const decoder = state.streaming;
  return Boolean(decoder && !decoder.disposed && !decoder.disposeRequested && decoder.loadGeneration === request.loadGeneration && decoder.seekGeneration === request.seekGeneration && decoder.codecId === request.codecId);
}

export async function decodeStreaming(state: DecodeWorkerState, request: DecodeStreamingRequest): Promise<WireDecodeResult> {
  const av = state.av!;
  if (!hasReusableStreamingDecoder(state, request)) {
    if (state.streaming) invalidateStreaming(state);
    const [, ctx, pkt, frame] = await av.ff_init_decoder(request.codecId);
    state.streaming = { av, codecId: request.codecId, ctx, pkt, frame, loadGeneration: request.loadGeneration, seekGeneration: request.seekGeneration, busy: false, disposeRequested: false, disposed: false };
  }
  const decoder = state.streaming!;
  decoder.busy = true; let failure: unknown; let result: WireDecodeResult = { frames: [], decodeMs: 0, convertMs: 0 };
  try {
    const rateScale = Number.isInteger(request.frameRate) ? 1 : 1001, rateDenominator = Math.round(request.frameRate * rateScale);
    const packets = request.chunks.map((data, i) => ({ data, pts: request.mediaFrames[i] ?? i, time_base_num: rateScale, time_base_den: rateDenominator }));
    const started = performance.now();
    const decoded = await av.ff_decode_multi(decoder.ctx, decoder.pkt, decoder.frame, packets, request.flush) as RawDecodedFrame[];
    const decodeMs = performance.now() - started;
    const { frames, convertMs } = buildFrames(decoded, av, request.mediaFrames, request.frameRate, request.videoRenderMode, { mode: "media-range", maxMediaFrame: request.maxMediaFrame });
    result = { frames, decodeMs, convertMs };
  } catch (error) {
    failure = error; decoder.disposeRequested = true; if (state.streaming === decoder) state.streaming = undefined;
  }
  if (request.flush) { decoder.disposeRequested = true; if (state.streaming === decoder) state.streaming = undefined; }
  decoder.busy = false;
  if (decoder.disposeRequested) try { await freeStreamingDecoder(decoder); } catch (error) { if (failure === undefined) failure = error; }
  if (failure !== undefined) throw failure;
  return result;
}

export function invalidateStreaming(state: DecodeWorkerState): void {
  const decoder = state.streaming; state.streaming = undefined; if (!decoder) return;
  decoder.disposeRequested = true;
  if (!decoder.busy) void freeStreamingDecoder(decoder).catch(error => console.warn("[H422Player] streaming decoder cleanup failed", error));
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
    case "invalidate-streaming": invalidateStreaming(state); return undefined;
    case "dispose": invalidateStreaming(state); state.av = undefined; return undefined;
  }
}
