import { createDecodeWorkerState, decodeResultTransferables, handleWorkerRequest, type WorkerRequest } from "./video-decode-core";

// Declared locally instead of pulling in the "webworker" lib, which conflicts with the "DOM"
// lib (used by the rest of this package) over the ambient `self` type in a single tsconfig.
declare const self: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage(message: unknown, transfer: ArrayBuffer[]): void };

const state = createDecodeWorkerState();

/**
 * One libav instance serves every request, so they must not interleave: a decode that is still
 * draining has to finish before an invalidate frees its context, and that free has to finish before
 * the next decode allocates a replacement. Handling messages as they arrived gave none of that — a
 * seek posted mid-decode started a second decode against the same instance and left both chunks'
 * frames (~450 MB each) alive at once.
 */
type QueuedRequest = { request: WorkerRequest; superseded: boolean };
const queue: QueuedRequest[] = [];
let draining = false;

const isDecode = (request: WorkerRequest) => request.type === "decode-streaming" || request.type === "decode-legacy";

async function respond({ request, superseded }: QueuedRequest): Promise<void> {
  try {
    if (superseded) throw Object.assign(new Error(`${request.type} superseded before it started`), { name: "AbortError" });
    const payload = await handleWorkerRequest(state, request);
    const transfer = payload ? decodeResultTransferables(payload) : [];
    try { self.postMessage({ id: request.id, ok: true, payload }, transfer); }
    catch (error) {
      // Report what the handoff was carrying: the browser's DataCloneError says only that the
      // data could not be cloned, which is unactionable without the frame count and byte size.
      const bytes = transfer.reduce((total, buffer) => total + buffer.byteLength, 0);
      throw new Error(`Failed to hand ${payload?.frames.length ?? 0} decoded frame(s) (${bytes} bytes) back to the main thread: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  } catch (error: unknown) {
    self.postMessage({ id: request.id, ok: false, name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }, []);
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try { while (queue.length) await respond(queue.shift()!); }
  finally { draining = false; }
}

self.onmessage = (event: { data: WorkerRequest }) => {
  const request = event.data;
  // The engine only invalidates after moving to a new load or seek generation, so decodes still
  // waiting behind one are for frames nobody will display. Running them anyway would make a scrub
  // settle one whole chunk decode later for every seek the user passed through.
  if (request.type === "invalidate-streaming" || request.type === "dispose") for (const queued of queue) if (isDecode(queued.request)) queued.superseded = true;
  queue.push({ request, superseded: false });
  void drain();
};
