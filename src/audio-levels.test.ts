import { describe, expect, it } from "vitest";

import {
  accumulateAudioLevels,
  AUDIO_LEVEL_SILENCE_DB,
  createAudioLevelAccumulator,
  finalizeAudioLevels,
  silentAudioLevels,
  toDecibels,
  type AudioLevelBufferLike,
} from "./audio-levels";

function buffer(channels: number[][], sampleRate = 48000): AudioLevelBufferLike {
  return { numberOfChannels: channels.length, length: channels[0]?.length ?? 0, sampleRate, getChannelData: index => new Float32Array(channels[index]) };
}

describe("toDecibels", () => {
  it("reports full scale as 0 dBFS", () => {
    expect(toDecibels(1)).toBeCloseTo(0, 6);
    expect(toDecibels(0.5)).toBeCloseTo(-6.0206, 3);
  });

  it("floors silence instead of reporting -Infinity, which no meter can lay out", () => {
    expect(toDecibels(0)).toBe(AUDIO_LEVEL_SILENCE_DB);
    expect(toDecibels(-1)).toBe(AUDIO_LEVEL_SILENCE_DB);
    expect(toDecibels(1e-12)).toBe(AUDIO_LEVEL_SILENCE_DB);
  });

  it("does not hide an over: material above full scale reads above 0 dBFS", () => {
    expect(toDecibels(2)).toBeCloseTo(6.0206, 3);
  });
});

describe("accumulateAudioLevels", () => {
  it("takes the magnitude of the largest sample and the RMS of the window", () => {
    const accumulator = createAudioLevelAccumulator();
    accumulateAudioLevels(accumulator, buffer([[0.25, -0.75, 0.5], [0.1, 0.1, 0.1]]), 0, 3);
    const levels = finalizeAudioLevels(accumulator, 4, 0.1);

    expect(levels.channels[0].peak).toBeCloseTo(0.75, 6);
    expect(levels.channels[0].rms).toBeCloseTo(Math.sqrt((0.0625 + 0.5625 + 0.25) / 3), 6);
    expect(levels.channels[1].peak).toBeCloseTo(0.1, 6);
    expect(levels.time).toBe(4);
    expect(levels.windowSeconds).toBe(0.1);
  });

  it("keeps the peak across the two chunks a window can straddle", () => {
    const accumulator = createAudioLevelAccumulator();
    accumulateAudioLevels(accumulator, buffer([[0.2], [0]]), 0, 1);
    accumulateAudioLevels(accumulator, buffer([[0.9], [0]]), 0, 1);

    expect(finalizeAudioLevels(accumulator, 0, 0.1).channels[0].peak).toBeCloseTo(0.9, 6);
    expect(accumulator.samples).toBe(2);
  });

  it("measures only the requested range and clamps it to the buffer", () => {
    const accumulator = createAudioLevelAccumulator();
    expect(accumulateAudioLevels(accumulator, buffer([[0, 1, 0], [0, 0, 0]]), 0, 1)).toBe(1);
    expect(finalizeAudioLevels(accumulator, 0, 0.1).channels[0].peak).toBe(0);
    expect(accumulateAudioLevels(accumulator, buffer([[0, 1, 0], [0, 0, 0]]), 2, 99)).toBe(1);
    expect(accumulateAudioLevels(accumulator, buffer([[0, 1, 0], [0, 0, 0]]), 5, 9)).toBe(0);
  });

  it("never measures past the first two channels, whatever the file carries", () => {
    const accumulator = createAudioLevelAccumulator();
    accumulateAudioLevels(accumulator, buffer([[0.1], [0.2], [0.9], [0.9]]), 0, 1);
    const levels = finalizeAudioLevels(accumulator, 0, 0.1);

    expect(levels.channels).toHaveLength(2);
    expect(levels.channels.map(channel => channel.peak)).toEqual([0.1, 0.2]);
  });

  it("ignores a buffer that cannot hand out samples rather than throwing at the meter", () => {
    const accumulator = createAudioLevelAccumulator();
    expect(accumulateAudioLevels(accumulator, { numberOfChannels: 2, length: 4 } as unknown as AudioLevelBufferLike, 0, 4)).toBe(0);
    expect(accumulator.samples).toBe(0);
  });
});

describe("silentAudioLevels", () => {
  it("reports two floored channels", () => {
    const levels = silentAudioLevels(2, 0.1);
    expect(levels.channels).toHaveLength(2);
    for (const channel of levels.channels) {
      expect(channel.peak).toBe(0);
      expect(channel.rms).toBe(0);
      expect(channel.peakDb).toBe(AUDIO_LEVEL_SILENCE_DB);
      expect(channel.rmsDb).toBe(AUDIO_LEVEL_SILENCE_DB);
    }
  });
});
