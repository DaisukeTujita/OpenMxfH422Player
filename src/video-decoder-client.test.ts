import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerVideoDecoderClient } from "./video-decoder-client";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: any[] = [];
  terminated = false;
  constructor(public url: URL, public options?: unknown) { FakeWorker.instances.push(this); }
  postMessage(message: any) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  reply(id: number, ok: boolean, payload?: unknown, rest?: { name?: string; message?: string; stack?: string }) { this.onmessage?.({ data: { id, ok, payload, ...rest } }); }
  fail(message: string) { this.onerror?.({ message }); }
}

describe("createWorkerVideoDecoderClient", () => {
  afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances.length = 0; });

  function setup() {
    vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
    const client = createWorkerVideoDecoderClient();
    const worker = FakeWorker.instances[0];
    return { client, worker };
  }

  it("constructs a module worker pointed at the decode worker script", () => {
    const { worker } = setup();
    expect(String(worker.url)).toContain("video-decode-worker");
    expect(worker.options).toMatchObject({ type: "module" });
  });

  it("resolves init once the worker replies for the matching id", async () => {
    const { client, worker } = setup();
    const promise = client.init("/libav");
    expect(worker.posted[0]).toMatchObject({ type: "init", base: "/libav", id: 1 });
    worker.reply(1, true, undefined);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with the worker's error message", async () => {
    const { client, worker } = setup();
    const promise = client.init("/libav");
    worker.reply(1, false, undefined, { message: "boom" });
    await expect(promise).rejects.toThrow("boom");
  });

  it("preserves the worker error's name and stack so the full failure survives the boundary", async () => {
    const { client, worker } = setup();
    const promise = client.init("/libav");
    worker.reply(1, false, undefined, { name: "DataCloneError", message: "Data cannot be cloned, out of memory.", stack: "DataCloneError: Data cannot be cloned, out of memory.\n    at postMessage" });
    await expect(promise).rejects.toMatchObject({ name: "DataCloneError", message: "Data cannot be cloned, out of memory.", stack: expect.stringContaining("at postMessage") });
  });

  it("rebuilds ImageData from the wire payload the worker transferred", async () => {
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    const { client, worker } = setup();
    const promise = client.decodeVideo([], 2, [], 25, "rgba");
    worker.reply(1, true, { decodeMs: 3, convertMs: 2, frames: [{ time: 0, mediaFrame: 0, frame: { kind: "rgba", width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) } }] });
    const result = await promise;
    expect(result.frames[0].frame).toBeInstanceOf(ImageData);
    expect(result.frames[0].frame).toMatchObject({ width: 1, height: 1 });
  });

  it("correlates concurrent requests by id and returns each payload to its own caller", async () => {
    const { client, worker } = setup();
    const first = client.decodeVideo([], 2, [], 25, "rgba");
    const second = client.decodeVideo([], 2, [], 25, "rgba");
    expect(worker.posted.map(message => message.id)).toEqual([1, 2]);
    worker.reply(2, true, { frames: [], decodeMs: 2, convertMs: 0 });
    worker.reply(1, true, { frames: [], decodeMs: 1, convertMs: 0 });
    await expect(first).resolves.toMatchObject({ decodeMs: 1 });
    await expect(second).resolves.toMatchObject({ decodeMs: 2 });
  });

  it("rejects every pending request when the worker itself errors", async () => {
    const { client, worker } = setup();
    const first = client.decodeVideo([], 2, [], 25, "rgba");
    const second = client.decodeStreamingVideo([], [], 30, false, 1, 1, 2, "yuv-webgl", 10);
    worker.fail("worker crashed");
    await expect(first).rejects.toThrow("worker crashed");
    await expect(second).rejects.toThrow("worker crashed");
  });

  it("terminates the worker on dispose", () => {
    const { client, worker } = setup();
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("posts an invalidate-streaming message without waiting for a reply", () => {
    const { client, worker } = setup();
    client.invalidateStreaming();
    expect(worker.posted[0]).toMatchObject({ type: "invalidate-streaming" });
  });
});
