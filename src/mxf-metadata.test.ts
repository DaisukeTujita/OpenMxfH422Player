import { describe, expect, it } from "vitest";
import { parseMxfMetadata } from "./mxf-metadata";

const bytes = (...values: number[]) => new Uint8Array(values);
const be32 = (value: number) => bytes(value >>> 24, value >>> 16, value >>> 8, value);
const be64 = (value: bigint) => {
  const result = new Uint8Array(8), view = new DataView(result.buffer); view.setBigUint64(0, value); return result;
};
const rational = (numerator: number, denominator: number) => concat(be32(numerator), be32(denominator));
const concat = (...parts: Uint8Array[]) => { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { result.set(part, at); at += part.length; } return result; };
const field = (tag: number, value: Uint8Array) => concat(bytes(tag >>> 8, tag, value.length >>> 8, value.length), value);
const berLength = (length: number) => length < 0x80 ? bytes(length) : length <= 0xff ? bytes(0x81, length) : bytes(0x82, length >>> 8, length);
const klv = (keyHex: string, value: Uint8Array) => concat(bytes(...(keyHex.match(/../g) ?? []).map(value => Number.parseInt(value, 16))), berLength(value.length), value);
const metadataKey = "060e2b34025301010d01010101012f00";

describe("parseMxfMetadata", () => {
  it("detects descriptor format values and Timecode Track fields", () => {
    const descriptor = klv(metadataKey, concat(
      field(0x4b01, rational(30000, 1001)), field(0x3203, be32(1920)), field(0x3202, be32(1080)),
      field(0x320e, rational(16, 9)), field(0x3d03, rational(48000, 1)), field(0x3d07, be32(2)), field(0x3d01, be32(24)), field(0x3d0a, bytes(0,6)), field(0x3d06, bytes(6,14,43,52,4,1,1,1,4,2,2,1,1,0,0,0)),
      field(0x1501, be64(1_080_000n)), field(0x1502, bytes(0, 30)), field(0x1503, bytes(1)), field(0x0202, be64(900n)),
    ));
    const parsed = parseMxfMetadata(descriptor);
    expect(parsed.mediaInfo).toMatchObject({ editRateNumerator: 30000, editRateDenominator: 1001, video: { width: 1920, height: 1080, aspectRatio: "16:9" }, audio: { sampleRate: 48000, channels: 2, bitsPerSample: 24, blockAlign:6, essenceCodingUl:"060e2b34040101010402020101000000" } });
    expect(parsed.mediaInfo.timecodeTrackCount).toBe(1);
    expect(parsed.timecodes[0]).toEqual({ startFrame: 1_080_000, roundedTimecodeBase: 30, dropFrame: true, editRateNumerator: 30000, editRateDenominator: 1001, durationFrames: 900, source: "mxf" });
  });

  it("uses display dimensions for a 544-line separate-fields XDCAM descriptor", () => {
    const descriptor = klv(metadataKey, concat(
      field(0x3203, be32(1920)), field(0x3202, be32(544)),
      field(0x3205, be32(1920)), field(0x3204, be32(1080)),
      field(0x3209, be32(1920)), field(0x3208, be32(1080)), field(0x320c, bytes(1)),
    ));
    expect(parseMxfMetadata(descriptor).mediaInfo.video).toMatchObject({
      width: 1920, height: 1080, storedWidth: 1920, storedHeight: 544,
      sampledWidth: 1920, sampledHeight: 1080, displayWidth: 1920, displayHeight: 1080, frameLayout: 1,
    });
  });

  it("normalizes a separate-fields 1920x544 descriptor when sampled and display dimensions are absent", () => {
    const descriptor = klv(metadataKey, concat(
      field(0x3203, be32(1920)), field(0x3202, be32(544)), field(0x320c, bytes(1)),
    ));
    expect(parseMxfMetadata(descriptor).mediaInfo.video).toMatchObject({
      width: 1920, height: 1080, storedWidth: 1920, storedHeight: 544, frameLayout: 1,
    });
  });

  it("keeps unavailable metadata undefined and accepts files without a Timecode Track", () => {
    const parsed = parseMxfMetadata(klv(metadataKey, field(0x3203, be32(1920))));
    expect(parsed.mediaInfo.video?.width).toBe(1920);
    expect(parsed.mediaInfo.video?.height).toBeUndefined();
    expect(parsed.timecodes).toEqual([]);
  });

  it("parses Index Table entries with a 64-bit Stream Offset", () => {
    const streamOffset = 0x20_0000_0000_0001n;
    const entry = concat(bytes(0, 0, 0x80), be64(streamOffset));
    const index = klv("060e2b34025301010d01020101100100", concat(
      field(0x3f0b, rational(30000, 1001)), field(0x3f0c, be64(0n)), field(0x3f0d, be64(1n)),
      field(0x3f0a, concat(be32(1), be32(11), entry)),
    ));
    const table = parseMxfMetadata(index).indexTables[0];
    expect(parseMxfMetadata(index).mediaInfo).toMatchObject({ indexTableCount: 1, indexEntryCount: 1 });
    expect(table.editRateNumerator).toBe(30000);
    expect(table.entries[0]).toMatchObject({ editUnit: 0, streamOffset, keyFrameOffset: 0, temporalOffset: 0, isRandomAccessPoint: true, flags: 0x80 });
  });

  it("ignores a broken Index Table so seeking can fall back", () => {
    const broken = klv("060e2b34025301010d01020101100100", bytes(0x3f, 0x0b, 0x80));
    expect(parseMxfMetadata(broken).indexTables).toEqual([]);
  });
});
