import type { AudioChannelLevel, AudioLevels } from "./types";

/**
 * Floor of the reported dBFS values. Digital silence is -Infinity dB, which no meter can lay out,
 * so the value is clamped here instead of leaving every host to clamp it again. -100 dBFS is below
 * the noise floor of the 24-bit material this player decodes, so nothing audible is lost.
 */
export const AUDIO_LEVEL_SILENCE_DB = -100;

/** Only the first two channels are ever measured, whatever the file carries. */
export const AUDIO_LEVEL_MAX_CHANNELS = 2;

/** How often levels are measured, and the length of the window each measurement covers. */
export const DEFAULT_AUDIO_LEVEL_INTERVAL_MS = 100;

/** The part of `AudioBuffer` measurement needs. Declared so it can be measured without Web Audio. */
export interface AudioLevelBufferLike {
  numberOfChannels: number;
  length: number;
  sampleRate?: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioLevelAccumulator {
  peak: number[];
  sumSquares: number[];
  samples: number;
}

export function toDecibels(linear: number): number {
  if (!(linear > 0)) return AUDIO_LEVEL_SILENCE_DB;
  return Math.max(AUDIO_LEVEL_SILENCE_DB, 20 * Math.log10(linear));
}

export function createAudioLevelAccumulator(channels: number = AUDIO_LEVEL_MAX_CHANNELS): AudioLevelAccumulator {
  const count = Math.max(0, Math.min(AUDIO_LEVEL_MAX_CHANNELS, Math.trunc(channels)));
  return { peak: new Array<number>(count).fill(0), sumSquares: new Array<number>(count).fill(0), samples: 0 };
}

/**
 * Adds one buffer's contribution to the window. A window can span two decoded chunks, so peak and
 * the sum of squares accumulate across calls and are only turned into levels at the end.
 * Returns the number of frames actually measured, which is 0 for a range outside the buffer.
 */
export function accumulateAudioLevels(accumulator: AudioLevelAccumulator, buffer: AudioLevelBufferLike, startSample: number, endSample: number): number {
  if (typeof buffer?.getChannelData !== "function") return 0;
  const start = Math.max(0, Math.trunc(startSample)), end = Math.min(buffer.length, Math.trunc(endSample));
  if (end <= start) return 0;
  const channels = Math.min(accumulator.peak.length, buffer.numberOfChannels);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    if (!data) continue;
    let peak = accumulator.peak[channel], sumSquares = accumulator.sumSquares[channel];
    for (let index = start; index < end && index < data.length; index++) {
      const sample = data[index], magnitude = sample < 0 ? -sample : sample;
      if (magnitude > peak) peak = magnitude;
      sumSquares += sample * sample;
    }
    accumulator.peak[channel] = peak;
    accumulator.sumSquares[channel] = sumSquares;
  }
  accumulator.samples += end - start;
  return end - start;
}

export function finalizeAudioLevels(accumulator: AudioLevelAccumulator, time: number, windowSeconds: number): AudioLevels {
  const samples = Math.max(1, accumulator.samples);
  const channels: AudioChannelLevel[] = accumulator.peak.map((peak, index) => {
    const rms = Math.sqrt(accumulator.sumSquares[index] / samples);
    return { peak, rms, peakDb: toDecibels(peak), rmsDb: toDecibels(rms) };
  });
  return { time, windowSeconds, channels };
}

/** Reported when nothing is audible: paused, muted by the rate, or no audio essence at all. */
export function silentAudioLevels(time: number, windowSeconds: number, channels: number = AUDIO_LEVEL_MAX_CHANNELS): AudioLevels {
  return finalizeAudioLevels(createAudioLevelAccumulator(channels), time, windowSeconds);
}
