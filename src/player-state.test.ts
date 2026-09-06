import { describe, expect, it } from "vitest";

import { derivePlayerState, isWaitingPlayerState, WAITING_PLAYER_STATES } from "./player-state";

describe("derivePlayerState", () => {
  it("passes a steady status through unchanged", () => {
    expect(derivePlayerState({ status: "paused", seeking: false, buffering: false })).toBe("paused");
    expect(derivePlayerState({ status: "playing", seeking: false, buffering: false })).toBe("playing");
    expect(derivePlayerState({ status: "ready", seeking: false, buffering: false })).toBe("ready");
    expect(derivePlayerState({ status: "ended", seeking: false, buffering: false })).toBe("ended");
  });

  it("reports a failed load as an error whatever else is still in flight", () => {
    expect(derivePlayerState({ status: "error", seeking: true, buffering: true })).toBe("error");
  });

  it("reports the file read before anything a seek or a refill is doing", () => {
    expect(derivePlayerState({ status: "loading", seeking: true, buffering: true })).toBe("loading");
  });

  it("reports a seek that has to refill the queue as a seek, not as a buffer underrun", () => {
    expect(derivePlayerState({ status: "buffering", seeking: true, buffering: true })).toBe("seeking");
  });

  it("reports buffering from either the flag or the status", () => {
    expect(derivePlayerState({ status: "playing", seeking: false, buffering: true })).toBe("buffering");
    expect(derivePlayerState({ status: "buffering", seeking: false, buffering: false })).toBe("buffering");
  });
});

describe("isWaitingPlayerState", () => {
  it("covers exactly the states in which the player owes the host media it does not have yet", () => {
    expect(WAITING_PLAYER_STATES).toEqual(["loading", "seeking", "buffering"]);
    for (const state of WAITING_PLAYER_STATES) expect(isWaitingPlayerState(state)).toBe(true);
    for (const state of ["idle", "ready", "playing", "paused", "ended", "error"] as const) expect(isWaitingPlayerState(state)).toBe(false);
  });
});
