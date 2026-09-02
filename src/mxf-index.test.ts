import { describe, expect, it } from "vitest";
import { findSeekPoint, type MxfIndexTable } from "./mxf-index";

const index: MxfIndexTable = { editRateNumerator: 25, editRateDenominator: 1, startPosition: 0, duration: 100, entries: [
  { editUnit: 0, streamOffset: 10n, isRandomAccessPoint: true },
  { editUnit: 12, streamOffset: 200n, isRandomAccessPoint: true },
  { editUnit: 20, streamOffset: 300n, isRandomAccessPoint: false },
] };

describe("findSeekPoint", () => {
  it("selects the preceding random access point", () => expect(findSeekPoint(index, 20)).toEqual({ editUnit: 12, streamOffset: 200n, source: "index" }));
  it("reports the sequential fallback when no index exists", () => expect(findSeekPoint(undefined, 20)).toEqual({ editUnit: 0, source: "sequential-fallback" }));
  it("does not mistake a byte-addressable non-RAP entry for a safe decode start",()=>expect(findSeekPoint({...index,entries:[],editUnitByteCount:100},20)).toEqual({editUnit:0,source:"sequential-fallback"}));
  it("uses KeyFrameOffset to resolve the referenced RAP",()=>expect(findSeekPoint({...index,entries:[index.entries[0],{editUnit:20,streamOffset:300n,keyFrameOffset:-8}]},20)).toEqual({editUnit:12,source:"index"}));
});
