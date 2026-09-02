export interface MxfIndexEntry {
  editUnit: number;
  streamOffset: bigint;
  keyFrameOffset?: number;
  temporalOffset?: number;
  isRandomAccessPoint?: boolean;
  flags?: number;
}

export interface MxfIndexTable {
  /** Partition identifiers, when the reader can associate the segment unambiguously. */
  bodySid?: number;
  indexSid?: number;
  editRateNumerator: number;
  editRateDenominator: number;
  startPosition: number;
  duration: number;
  editUnitByteCount?: number;
  entries: MxfIndexEntry[];
}

export interface SeekPoint {
  editUnit: number;
  streamOffset?: bigint;
  source: "index" | "sequential-fallback";
}

/** Select the last random-access entry at or before the requested edit unit. */
export function findSeekPoint(index: MxfIndexTable | undefined, targetEditUnit: number): SeekPoint {
  const target = Math.max(0, Math.trunc(targetEditUnit));
  if (!index) return { editUnit: 0, source: "sequential-fallback" };
  const candidates = index.entries.filter(entry => entry.editUnit <= target && entry.isRandomAccessPoint !== false);
  const selected = candidates.at(-1);
  if (selected) return { editUnit: selected.editUnit, streamOffset: selected.streamOffset, source: "index" };
  if (index.editUnitByteCount !== undefined) {
    const editUnit = Math.max(index.startPosition, Math.min(target, index.startPosition + index.duration - 1));
    return { editUnit, streamOffset: BigInt(editUnit - index.startPosition) * BigInt(index.editUnitByteCount), source: "index" };
  }
  return { editUnit: 0, source: "sequential-fallback" };
}
