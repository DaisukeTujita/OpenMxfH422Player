import { describe, expect, it } from "vitest";
import { formatTimecodeFrame, timecodeAtFrame } from "./timecode";

describe("SMPTE timecode conversion", () => {
  it("formats non-drop timecode and adds the playback frame", () => {
    expect(formatTimecodeFrame(30 * 60 * 60 + 5 * 30, 30)).toBe("01:00:05:00");
    expect(timecodeAtFrame({ startFrame: 30 * 10 * 60 * 60, roundedTimecodeBase: 30, dropFrame: false, editRateNumerator: 30, editRateDenominator: 1 }, 150)).toBe("10:00:05:00");
  });
  it("uses 29.97 drop-frame numbering", () => {
    expect(formatTimecodeFrame(1_800, 30, true)).toBe("00:01:00;02");
    expect(formatTimecodeFrame(17_982, 30, true)).toBe("00:10:00;00");
  });
  it("uses 59.94 drop-frame numbering", () => expect(formatTimecodeFrame(3_600, 60, true)).toBe("00:01:00;04"));
  it("wraps after 24 hours", () => expect(formatTimecodeFrame(24 * 60 * 60 * 30 + 7, 30)).toBe("00:00:00:07"));
});
