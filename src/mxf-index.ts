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

/**
 * Index Table Segments are per-partition slices of one index, and their entries already carry
 * absolute edit units, so seeking has to see all of them. Taking only the first segment made every
 * seek past it fall back to a sequential scan. Segments naming a different BodySID belong to another
 * essence and are left out.
 */
export function mergeIndexTables(tables: MxfIndexTable[]): MxfIndexTable | undefined {
  if (tables.length <= 1) return tables[0];
  const ordered = [...tables].sort((a, b) => a.startPosition - b.startPosition), first = ordered[0];
  // IndexSID first: it names the index stream, and a footer-partition segment of that same stream
  // carries a different BodySID.
  // SID 0 is MXF's "none", so it never identifies a stream.
  const sid = (value: number | undefined) => value === undefined || value === 0 ? undefined : value;
  const sameEssence = sid(first.indexSid) !== undefined
    ? ordered.filter(table => sid(table.indexSid) === undefined || table.indexSid === first.indexSid)
    : ordered.filter(table => sid(table.bodySid) === undefined || sid(first.bodySid) === undefined || table.bodySid === first.bodySid);
  const seen = new Set<number>(), entries: MxfIndexEntry[] = [];
  for (const table of sameEssence) for (const entry of table.entries) if (!seen.has(entry.editUnit)) { seen.add(entry.editUnit); entries.push(entry); }
  return { ...first, duration: sameEssence.reduce((total, table) => total + table.duration, 0), entries };
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
