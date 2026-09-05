import { createDecodeWorkerState, decodeResultTransferables, handleWorkerRequest, type WorkerRequest } from "./video-decode-core";

// Declared locally instead of pulling in the "webworker" lib, which conflicts with the "DOM"
// lib (used by the rest of this package) over the ambient `self` type in a single tsconfig.
declare const self: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage(message: unknown, transfer: ArrayBuffer[]): void };

const state = createDecodeWorkerState();

self.onmessage = (event: { data: WorkerRequest }) => {
  const request = event.data;
  handleWorkerRequest(state, request)
    .then(payload => {
      const transfer = payload ? decodeResultTransferables(payload) : [];
      try { self.postMessage({ id: request.id, ok: true, payload }, transfer); }
      catch (error) {
        // Report what the handoff was carrying: the browser's DataCloneError says only that the
        // data could not be cloned, which is unactionable without the frame count and byte size.
        const bytes = transfer.reduce((total, buffer) => total + buffer.byteLength, 0);
        throw new Error(`Failed to hand ${payload?.frames.length ?? 0} decoded frame(s) (${bytes} bytes) back to the main thread: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    })
    .catch((error: unknown) => self.postMessage({ id: request.id, ok: false, name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }, []));
};
