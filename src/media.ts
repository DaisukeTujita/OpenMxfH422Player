export const MPEG2VIDEO_CODEC_ID = 2;
export const PCM_S24BE_CODEC_ID = 0x1000d;
export const XDCAM_FRAME_RATE = 30000 / 1001;

export interface DetectedCodec { codecId: number; codecName: string }

export function yuv422pToRgba(y: Uint8Array, u: Uint8Array, v: Uint8Array, width: number, height: number): Uint8ClampedArray {
  if (y.length < width * height || u.length < Math.ceil(width / 2) * height || v.length < Math.ceil(width / 2) * height)
    throw new Error("Truncated yuv422p frame");
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const yy = y[row * width + col] - 16;
    const chroma = row * Math.ceil(width / 2) + (col >> 1);
    const cb = u[chroma] - 128, cr = v[chroma] - 128;
    const out = (row * width + col) * 4;
    rgba[out] = (298 * yy + 409 * cr + 128) >> 8;
    rgba[out + 1] = (298 * yy - 100 * cb - 208 * cr + 128) >> 8;
    rgba[out + 2] = (298 * yy + 516 * cb + 128) >> 8;
    rgba[out + 3] = 255;
  }
  return rgba;
}

/** Convert interleaved signed 24-bit big-endian PCM into Web Audio planar floats. */
export function pcmS24beToFloat32(data: Uint8Array, channels: number): Float32Array[] {
  if (channels < 1) throw new Error("PCM must have at least one channel");
  const sampleFrames = Math.floor(data.length / (channels * 3));
  const output = Array.from({ length: channels }, () => new Float32Array(sampleFrames));
  for (let frame = 0; frame < sampleFrames; frame++) for (let channel = 0; channel < channels; channel++) {
    const at = (frame * channels + channel) * 3;
    let value = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
    if (value & 0x800000) value -= 0x1000000;
    output[channel][frame] = value / 0x800000;
  }
  return output;
}
