import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLibavAssets } from "./setup-libav-assets.mjs";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.LIBAV_ASSET_BASE_URL;
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("ensureLibavAssets", () => {
  it("downloads a pinned asset and verifies its SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "libav-assets-")); temporary.push(root);
    const data = Buffer.from("custom libav asset");
    const manifestPath = join(root, "assets.json");
    await writeFile(manifestPath, JSON.stringify({
      version: "test", baseUrl: "https://release.example.test",
      assets: [{ name: "libav-h422.mjs", sha256: createHash("sha256").update(data).digest("hex") }],
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(data)));

    await ensureLibavAssets({ manifestPath, destination: join(root, "dist") });

    expect(await readFile(join(root, "dist/libav-h422.mjs"))).toEqual(data);
  });

  it("rejects a file whose hash differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "libav-assets-")); temporary.push(root);
    const manifestPath = join(root, "assets.json");
    await writeFile(manifestPath, JSON.stringify({
      version: "test", baseUrl: "https://release.example.test",
      assets: [{ name: "libav-h422.mjs", sha256: "0".repeat(64) }],
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("tampered")));
    await expect(ensureLibavAssets({ manifestPath, destination: join(root, "dist") }))
      .rejects.toThrow("SHA-256 が一致しません");
  });
});
