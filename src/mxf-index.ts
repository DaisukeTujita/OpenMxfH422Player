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
  const entries = index.entries.filter(entry => entry.editUnit <= target);
  for (let at=entries.length-1;at>=0;at--) {
    const entry=entries[at];
    if (entry.keyFrameOffset !== undefined) {
      const editUnit=Math.max(0,entry.editUnit+entry.keyFrameOffset);
      if(editUnit>target)continue;
      const referenced=index.entries.find(candidate=>candidate.editUnit===editUnit);
      return {editUnit,streamOffset:referenced?.streamOffset,source:"index"};
    }
    if (entry.isRandomAccessPoint===true || entry.flags!==undefined && (entry.flags&0x80)!==0)
      return {editUnit:entry.editUnit,streamOffset:entry.streamOffset,source:"index"};
  }
  // A constant byte size locates an edit unit but does not prove it is independently decodable.
  return { editUnit: 0, source: "sequential-fallback" };
}
