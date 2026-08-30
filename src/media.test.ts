import { describe, expect, it } from "vitest";
import { pcmS24beToFloat32, yuv422pToRgba } from "./media";

describe("media conversion", () => {
  it("converts neutral yuv422p to opaque RGBA", () => {
    expect(Array.from(yuv422pToRgba(new Uint8Array([16, 235]), new Uint8Array([128]), new Uint8Array([128]), 2, 1)))
      .toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
  it("converts interleaved signed 24-bit big-endian PCM", () => {
    const result = pcmS24beToFloat32(new Uint8Array([0x7f,0xff,0xff, 0x80,0,0]), 2);
    expect(result[0][0]).toBeCloseTo(1, 6); expect(result[1][0]).toBe(-1);
  });
});
