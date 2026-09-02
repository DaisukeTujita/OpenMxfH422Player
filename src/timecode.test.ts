import { describe, expect, it } from "vitest";
import { formatTimecodeFrame, framesPerTimecodeDay, mediaFrameToTimecode, parseTimecodeFrame, timecodeAtFrame, timecodeToMediaFrame, timecodeToMediaSeconds } from "./timecode";

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

describe("bidirectional SMPTE conversion", () => {
  const ndf = { startFrame: 24 * 36000, roundedTimecodeBase: 24, dropFrame: false, editRateNumerator: 24, editRateDenominator: 1, durationFrames: 240 };
  it("round trips NDF with a non-zero material start", () => {
    expect(mediaFrameToTimecode(ndf, 120)).toBe("10:00:05:00");
    expect(timecodeToMediaFrame(ndf, "10:00:05:00")).toBe(120);
    expect(timecodeToMediaSeconds(ndf, "10:00:05:00")).toBe(5);
  });
  it.each([["00:01:00;02",1800],["00:10:00;00",17982],["01:00:00;00",107892]])("handles 29.97 DF boundary %s",(tc,frame)=>expect(parseTimecodeFrame(tc,30,true)).toBe(frame));
  it("handles 59.94 DF boundaries",()=>{expect(parseTimecodeFrame("00:01:00;04",60,true)).toBe(3600);expect(parseTimecodeFrame("00:10:00;00",60,true)).toBe(35964);});
  it("wraps at 24 hours",()=>expect(formatTimecodeFrame(framesPerTimecodeDay(30,true),30,true)).toBe("00:00:00;00"));
  it("rejects invalid frame and skipped DF labels",()=>{expect(()=>parseTimecodeFrame("00:00:00:30",30,false)).toThrow("invalid-frame-number");expect(()=>parseTimecodeFrame("00:01:00;01",30,true)).toThrow("invalid-drop-frame-number");});
  it("rejects out of material range",()=>expect(()=>timecodeToMediaFrame(ndf,"10:01:00:00")).toThrow("out-of-range"));
});
