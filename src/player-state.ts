import type { PlayerState, PlayerStatus } from "./types";

/**
 * The states in which the player is working towards playable media rather than sitting in a
 * steady state. A host shows its spinner and disables transport for exactly these.
 */
export const WAITING_PLAYER_STATES: readonly PlayerState[] = ["loading", "seeking", "buffering"];

export function isWaitingPlayerState(state: PlayerState): boolean {
  return WAITING_PLAYER_STATES.includes(state);
}

/**
 * Composes the one value a host subscribes to out of the three the engine tracks. The order is the
 * order of specificity, not of importance: a failed load is an error whatever else is in flight, a
 * seek that has to refill the queue is still a seek rather than a buffer underrun, and a status of
 * `buffering` and the buffering flag mean the same thing to a host, so either is enough.
 */
export function derivePlayerState(input: { status: PlayerStatus; seeking: boolean; buffering: boolean }): PlayerState {
  if (input.status === "error") return "error";
  if (input.status === "loading") return "loading";
  if (input.seeking) return "seeking";
  if (input.buffering || input.status === "buffering") return "buffering";
  return input.status;
}
