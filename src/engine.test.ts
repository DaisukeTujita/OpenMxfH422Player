import { afterEach, describe, expect, it, vi } from "vitest";

import { loadCustomLibAV } from "./engine";

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
