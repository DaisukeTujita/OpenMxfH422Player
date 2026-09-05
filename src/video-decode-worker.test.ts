import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WireDecodeResult, WorkerRequest } from "./video-decode-core";

vi.mock("./video-decode-core", async importOriginal => ({ ...await importOriginal<typeof import("./video-decode-core")>(), handleWorkerRequest: vi.fn() }));

type Posted = { message: any; transfer: ArrayBuffer[] };

function planarResult(frames: number): WireDecodeResult {
  return {
    decodeMs: 10, convertMs: 0,
    frames: Array.from({ length: frames }, (_, index) => ({
      time: index / 25, mediaFrame: index,
      frame: { kind: "yuv422p" as const, width: 2, height: 1, y: new Uint8Array(2), u: new Uint8Array(1), v: new Uint8Array(1) },
    })),
  };
}

describe("video decode worker message handling", () => {
  let posted: Posted[];
  let fakeSelf: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage(message: unknown, transfer: ArrayBuffer[]): void };
  let handleWorkerRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    posted = [];
    fakeSelf = { onmessage: null, postMessage: (message, transfer) => { posted.push({ message, transfer }); } };
    vi.stubGlobal("self", fakeSelf);
    vi.resetModules();
    handleWorkerRequest = vi.mocked((await import("./video-decode-core")).handleWorkerRequest) as unknown as ReturnType<typeof vi.fn>;
    handleWorkerRequest.mockReset();
    await import("./video-decode-worker");
  });
  afterEach(() => vi.unstubAllGlobals());

  const deliver = (request: WorkerRequest) => { fakeSelf.onmessage!({ data: request }); return vi.waitFor(() => expect(posted).toHaveLength(1)); };

  it("transfers every decoded plane instead of structured-cloning the reply", async () => {
    const result = planarResult(3);
    handleWorkerRequest.mockResolvedValue(result);

    await deliver({ id: 7, type: "decode-streaming", codecId: 2, chunks: [], mediaFrames: [], frameRate: 25, flush: false, loadGeneration: 1, seekGeneration: 1, videoRenderMode: "yuv-webgl", maxMediaFrame: 100 });

    expect(posted[0].message).toMatchObject({ id: 7, ok: true });
    expect(posted[0].transfer).toHaveLength(9);
    expect(new Set(posted[0].transfer).size).toBe(9);
  });

  it("sends no transfer list for a request that returns no frames", async () => {
    handleWorkerRequest.mockResolvedValue(undefined);
    await deliver({ id: 1, type: "init", base: "/libav" });
    expect(posted[0]).toMatchObject({ message: { id: 1, ok: true, payload: undefined }, transfer: [] });
  });

  it("reports the frame count and byte size when the browser refuses the handoff", async () => {
    handleWorkerRequest.mockResolvedValue(planarResult(2));
    const refusal = Object.assign(new Error("Data cannot be cloned, out of memory."), { name: "DataCloneError" });
    fakeSelf.postMessage = (message, transfer) => { if ((message as { ok: boolean }).ok) throw refusal; posted.push({ message, transfer }); };

    await deliver({ id: 9, type: "decode-streaming", codecId: 2, chunks: [], mediaFrames: [], frameRate: 25, flush: false, loadGeneration: 1, seekGeneration: 1, videoRenderMode: "yuv-webgl", maxMediaFrame: 100 });

    expect(posted[0].message).toMatchObject({ id: 9, ok: false });
    expect(posted[0].message.message).toBe("Failed to hand 2 decoded frame(s) (8 bytes) back to the main thread: Data cannot be cloned, out of memory.");
  });

  it("forwards a decode failure's name and stack to the main thread", async () => {
    handleWorkerRequest.mockRejectedValue(Object.assign(new Error("decode failed"), { name: "DecodeError", stack: "DecodeError: decode failed\n    at ff_decode_multi" }));

    await deliver({ id: 4, type: "decode-legacy", codecId: 2, chunks: [], mediaFrames: [], frameRate: 25, videoRenderMode: "rgba" });

    expect(posted[0].message).toMatchObject({ id: 4, ok: false, name: "DecodeError", message: "decode failed", stack: expect.stringContaining("at ff_decode_multi") });
  });
});
