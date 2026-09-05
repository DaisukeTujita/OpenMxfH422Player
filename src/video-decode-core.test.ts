import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeLegacy, decodeStreaming, handleWorkerRequest, initDecoder, invalidateStreaming, type DecodeWorkerState } from "./video-decode-core";

type DecoderMock = {
  AV_PIX_FMT_YUV422P?: number;
  ff_init_decoder: ReturnType<typeof vi.fn>;
  ff_decode_multi: ReturnType<typeof vi.fn>;
  ff_free_decoder: ReturnType<typeof vi.fn>;
};

describe("decodeLegacy", () => {
  it("frees ctx, pkt, and frame exactly once after successful decoding", async () => {
    const [codec, ctx, pkt, frame] = [11, 22, 33, 44];
    const av: DecoderMock = {
      ff_init_decoder: vi.fn().mockResolvedValue([codec, ctx, pkt, frame]),
      ff_decode_multi: vi.fn().mockResolvedValue([]),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    await decodeLegacy({ av: av as any }, { codecId: 2, chunks: [new Uint8Array([1])], mediaFrames: [0], frameRate: 25, videoRenderMode: "rgba" });

    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
    expect(av.ff_free_decoder).toHaveBeenCalledWith(ctx, pkt, frame);
    expect(av.ff_free_decoder.mock.calls[0]).not.toContain(codec);
  });

  it("frees the decoder exactly once after decoding fails", async () => {
    const decodeError = new Error("decode failed");
    const av: DecoderMock = {
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockRejectedValue(decodeError),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    await expect(decodeLegacy({ av: av as any }, { codecId: 2, chunks: [], mediaFrames: [], frameRate: 25, videoRenderMode: "rgba" })).rejects.toBe(decodeError);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("does not hide a decoding error when decoder cleanup also fails", async () => {
    const decodeError = new Error("decode failed");
    const cleanupError = new Error("cleanup failed");
    const av: DecoderMock = {
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockRejectedValue(decodeError),
      ff_free_decoder: vi.fn().mockRejectedValue(cleanupError),
    };

    await expect(decodeLegacy({ av: av as any }, { codecId: 2, chunks: [], mediaFrames: [], frameRate: 25, videoRenderMode: "rgba" })).rejects.toBe(decodeError);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("reports a cleanup error when decoding succeeded", async () => {
    const cleanupError = new Error("cleanup failed");
    const av: DecoderMock = {
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockResolvedValue([]),
      ff_free_decoder: vi.fn().mockRejectedValue(cleanupError),
    };

    await expect(decodeLegacy({ av: av as any }, { codecId: 2, chunks: [], mediaFrames: [], frameRate: 25, videoRenderMode: "rgba" })).rejects.toBe(cleanupError);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("falls back to input edit-unit order when decoded PTS uses another time base", async () => {
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    const decodedFrame = (pts: number) => ({
      pts, width: 2, height: 1, format: 4,
      data: new Uint8Array([16, 16, 128, 128]),
      layout: [{ offset: 0, stride: 2 }, { offset: 2, stride: 1 }, { offset: 3, stride: 1 }],
    });
    const av: DecoderMock = {
      AV_PIX_FMT_YUV422P: 4,
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockResolvedValue([decodedFrame(90_090), decodedFrame(180_180)]),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    const result = await decodeLegacy({ av: av as any }, { codecId: 2, chunks: [new Uint8Array([1]), new Uint8Array([2])], mediaFrames: [100, 101], frameRate: 25, videoRenderMode: "rgba" });

    expect(result.frames.map(item => item.mediaFrame)).toEqual([100, 101]);
    expect(result.frames.map(item => item.time)).toEqual([4, 4.04]);
    vi.unstubAllGlobals();
  });

  it("keeps valid decoded PTS so reordered MPEG-2 output retains its edit units", async () => {
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    const decodedFrame = (pts: number) => ({
      pts, width: 2, height: 1, format: 4,
      data: new Uint8Array([16, 16, 128, 128]),
      layout: [{ offset: 0, stride: 2 }, { offset: 2, stride: 1 }, { offset: 3, stride: 1 }],
    });
    const av: DecoderMock = {
      AV_PIX_FMT_YUV422P: 4,
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockResolvedValue([decodedFrame(102), decodedFrame(100), decodedFrame(101)]),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    const result = await decodeLegacy({ av: av as any }, { codecId: 2, chunks: [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])], mediaFrames: [100, 101, 102], frameRate: 25, videoRenderMode: "rgba" });

    expect(result.frames.map(item => item.mediaFrame)).toEqual([102, 100, 101]);
    vi.unstubAllGlobals();
  });
});

describe("decodeStreaming decoder reuse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reuses one decoder across adjacent chunks and flushes it only at the end", async () => {
    const av: DecoderMock = { AV_PIX_FMT_YUV422P: 4, ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]), ff_decode_multi: vi.fn().mockResolvedValue([]), ff_free_decoder: vi.fn().mockResolvedValue(undefined) };
    const state: DecodeWorkerState = { av: av as any };
    await decodeStreaming(state, { codecId: 2, chunks: [new Uint8Array([1])], mediaFrames: [0], frameRate: 30, flush: false, loadGeneration: 1, seekGeneration: 2, videoRenderMode: "yuv-webgl", maxMediaFrame: 300 });
    await decodeStreaming(state, { codecId: 2, chunks: [new Uint8Array([2])], mediaFrames: [1], frameRate: 30, flush: true, loadGeneration: 1, seekGeneration: 2, videoRenderMode: "yuv-webgl", maxMediaFrame: 300 });
    expect(av.ff_init_decoder).toHaveBeenCalledOnce();
    expect(av.ff_decode_multi).toHaveBeenNthCalledWith(1, 22, 33, 44, expect.any(Array), false);
    expect(av.ff_decode_multi).toHaveBeenNthCalledWith(2, 22, 33, 44, expect.any(Array), true);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("reinitializes the decoder when the seek generation changes", async () => {
    const av: DecoderMock = { AV_PIX_FMT_YUV422P: 4, ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]), ff_decode_multi: vi.fn().mockResolvedValue([]), ff_free_decoder: vi.fn().mockResolvedValue(undefined) };
    const state: DecodeWorkerState = { av: av as any };
    await decodeStreaming(state, { codecId: 2, chunks: [new Uint8Array([1])], mediaFrames: [0], frameRate: 30, flush: false, loadGeneration: 1, seekGeneration: 2, videoRenderMode: "yuv-webgl", maxMediaFrame: 300 });
    await decodeStreaming(state, { codecId: 2, chunks: [new Uint8Array([2])], mediaFrames: [1], frameRate: 30, flush: false, loadGeneration: 1, seekGeneration: 3, videoRenderMode: "yuv-webgl", maxMediaFrame: 300 });
    expect(av.ff_init_decoder).toHaveBeenCalledTimes(2);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("defers disposal until an in-flight decode finishes", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const av: DecoderMock = { ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]), ff_decode_multi: vi.fn(async () => { entered(); await wait; return []; }), ff_free_decoder: vi.fn().mockResolvedValue(undefined) };
    const state: DecodeWorkerState = { av: av as any };
    const decoding = decodeStreaming(state, { codecId: 2, chunks: [new Uint8Array([1])], mediaFrames: [0], frameRate: 30, flush: false, loadGeneration: 1, seekGeneration: 2, videoRenderMode: "yuv-webgl", maxMediaFrame: 300 });
    await started;
    invalidateStreaming(state);
    expect(av.ff_free_decoder).not.toHaveBeenCalled();
    release();
    await decoding;
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("keeps decoded YUV planes for direct WebGL rendering", async () => {
    const decoded = { pts: 0, width: 2, height: 1, format: 4, data: new Uint8Array([16, 16, 128, 128]), layout: [{ offset: 0, stride: 2 }, { offset: 2, stride: 1 }, { offset: 3, stride: 1 }] };
    const av: DecoderMock = { AV_PIX_FMT_YUV422P: 4, ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]), ff_decode_multi: vi.fn().mockResolvedValue([decoded]), ff_free_decoder: vi.fn().mockResolvedValue(undefined) };
    const state: DecodeWorkerState = { av: av as any };
    const result = await decodeStreaming(state, { codecId: 2, chunks: [new Uint8Array([1])], mediaFrames: [0], frameRate: 30, flush: true, loadGeneration: 1, seekGeneration: 2, videoRenderMode: "yuv-webgl", maxMediaFrame: 1 });
    expect(result.frames[0].frame).toMatchObject({ width: 2, height: 1, y: new Uint8Array([16, 16]), u: new Uint8Array([128]), v: new Uint8Array([128]) });
    expect(result.convertMs).toBe(0);
    expect(result.frames).toHaveLength(1);
  });

  it("ignores a decoded PTS outside the media's valid frame range", async () => {
    const decoded = { pts: 999_999, width: 2, height: 1, format: 4, data: new Uint8Array([16, 16, 128, 128]), layout: [{ offset: 0, stride: 2 }, { offset: 2, stride: 1 }, { offset: 3, stride: 1 }] };
    const av: DecoderMock = { AV_PIX_FMT_YUV422P: 4, ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]), ff_decode_multi: vi.fn().mockResolvedValue([decoded]), ff_free_decoder: vi.fn().mockResolvedValue(undefined) };
    const state: DecodeWorkerState = { av: av as any };
    const result = await decodeStreaming(state, { codecId: 2, chunks: [new Uint8Array([1])], mediaFrames: [42], frameRate: 30, flush: true, loadGeneration: 1, seekGeneration: 2, videoRenderMode: "yuv-webgl", maxMediaFrame: 300 });
    expect(result.frames[0].mediaFrame).toBe(42);
  });
});

describe("handleWorkerRequest", () => {
  it("dispatches decode-legacy, decode-streaming, invalidate-streaming, and dispose", async () => {
    const av: DecoderMock = { AV_PIX_FMT_YUV422P: 4, ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]), ff_decode_multi: vi.fn().mockResolvedValue([]), ff_free_decoder: vi.fn().mockResolvedValue(undefined) };
    const state: DecodeWorkerState = { av: av as any };

    const legacyResult = await handleWorkerRequest(state, { id: 1, type: "decode-legacy", codecId: 2, chunks: [], mediaFrames: [], frameRate: 25, videoRenderMode: "rgba" });
    expect(legacyResult).toMatchObject({ frames: [] });

    await handleWorkerRequest(state, { id: 2, type: "decode-streaming", codecId: 2, chunks: [], mediaFrames: [], frameRate: 30, flush: false, loadGeneration: 1, seekGeneration: 1, videoRenderMode: "yuv-webgl", maxMediaFrame: 10 });
    expect(state.streaming).toBeDefined();

    await handleWorkerRequest(state, { id: 3, type: "invalidate-streaming" });
    expect(state.streaming).toBeUndefined();

    await handleWorkerRequest(state, { id: 4, type: "dispose" });
    expect(state.av).toBeUndefined();
  });

  it("surfaces an init failure from a bad libav base", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unavailable")));
    const state: DecodeWorkerState = {};
    await expect(handleWorkerRequest(state, { id: 1, type: "init", base: "/libav" })).rejects.toThrow("Failed to fetch custom libav.js frontend");
    vi.unstubAllGlobals();
  });
});

describe("initDecoder", () => {
  it("rejects a libav build without swscale support", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("frontend source")));
    const moduleUrl = `data:text/javascript,${encodeURIComponent("export async function LibAV() { return { libavjs_with_swscale: async () => 0 }; }")}`;
    vi.spyOn(URL, "createObjectURL").mockReturnValue(moduleUrl);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const state: DecodeWorkerState = {};
    await expect(initDecoder(state, "/libav")).rejects.toThrow("Custom libav.js was built without swscale");
    vi.restoreAllMocks();
  });
});
