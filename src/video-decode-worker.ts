import { createDecodeWorkerState, handleWorkerRequest, type WorkerRequest } from "./video-decode-core";

// Declared locally instead of pulling in the "webworker" lib, which conflicts with the "DOM"
// lib (used by the rest of this package) over the ambient `self` type in a single tsconfig.
declare const self: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage(message: unknown): void };

const state = createDecodeWorkerState();

self.onmessage = (event: { data: WorkerRequest }) => {
  const request = event.data;
  handleWorkerRequest(state, request)
    .then(payload => self.postMessage({ id: request.id, ok: true, payload }))
    .catch((error: unknown) => self.postMessage({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) }));
};
