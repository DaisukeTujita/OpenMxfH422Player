import { afterEach, describe, expect, it, vi } from "vitest";

import { loadCustomLibAV, PlayerEngine } from "./engine";

function moduleUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

describe("loadCustomLibAV", () => {
  afterEach(() => vi.restoreAllMocks());

  it("adds the requested URL to network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unavailable")));

    await expect(loadCustomLibAV("/libav"))
      .rejects.toThrow("Failed to fetch custom libav.js frontend: /libav/libav-h422.mjs (network unavailable)");
  });

  it("reports an HTTP failure with the requested URL and status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404, statusText: "Not Found" })));

    await expect(loadCustomLibAV("/libav/"))
      .rejects.toThrow("Failed to fetch custom libav.js frontend: /libav/libav-h422.mjs (404 Not Found)");
  });

  it("rejects an invalid module and releases its Blob URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("export const invalid = true")));
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue(moduleUrl("export const invalid = true"));
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await expect(loadCustomLibAV("/libav"))
      .rejects.toThrow("Invalid custom libav.js frontend: /libav/libav-h422.mjs");
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe("text/javascript");
    expect(revokeObjectURL).toHaveBeenCalledWith(createObjectURL.mock.results[0].value);
  });

  it("uses the asset base for LibAV and releases the Blob URL after import", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("frontend source")));
    const loadedModule = moduleUrl("export async function LibAV(options) { return { options }; }");
    vi.spyOn(URL, "createObjectURL").mockReturnValue(loadedModule);
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await expect(loadCustomLibAV("/libav/")).resolves.toMatchObject({
      options: { base: "/libav", noworker: false },
    });
    expect(revokeObjectURL).toHaveBeenCalledWith(loadedModule);
  });
});

type DecoderMock = {
  ff_init_decoder: ReturnType<typeof vi.fn>;
  ff_decode_multi: ReturnType<typeof vi.fn>;
  ff_free_decoder: ReturnType<typeof vi.fn>;
};

function decoderHarness(av: DecoderMock) {
  const engine = Object.create(PlayerEngine.prototype) as {
    libav: DecoderMock;
    decodeVideo(chunks: Uint8Array[], codecId: number): Promise<void>;
  };
  engine.libav = av;
  return engine;
}

describe("PlayerEngine decoder cleanup", () => {
  it("frees ctx, pkt, and frame exactly once after successful decoding", async () => {
    const [codec, ctx, pkt, frame] = [11, 22, 33, 44];
    const av = {
      ff_init_decoder: vi.fn().mockResolvedValue([codec, ctx, pkt, frame]),
      ff_decode_multi: vi.fn().mockResolvedValue([]),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    await decoderHarness(av).decodeVideo([new Uint8Array([1])], 2);

    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
    expect(av.ff_free_decoder).toHaveBeenCalledWith(ctx, pkt, frame);
    expect(av.ff_free_decoder.mock.calls[0]).not.toContain(codec);
  });

  it("frees the decoder exactly once after decoding fails", async () => {
    const decodeError = new Error("decode failed");
    const av = {
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockRejectedValue(decodeError),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    await expect(decoderHarness(av).decodeVideo([], 2)).rejects.toBe(decodeError);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("does not hide a decoding error when decoder cleanup also fails", async () => {
    const decodeError = new Error("decode failed");
    const cleanupError = new Error("cleanup failed");
    const av = {
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockRejectedValue(decodeError),
      ff_free_decoder: vi.fn().mockRejectedValue(cleanupError),
    };

    await expect(decoderHarness(av).decodeVideo([], 2)).rejects.toBe(decodeError);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("reports a cleanup error when decoding succeeded", async () => {
    const cleanupError = new Error("cleanup failed");
    const av = {
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockResolvedValue([]),
      ff_free_decoder: vi.fn().mockRejectedValue(cleanupError),
    };

    await expect(decoderHarness(av).decodeVideo([], 2)).rejects.toBe(cleanupError);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });
});
