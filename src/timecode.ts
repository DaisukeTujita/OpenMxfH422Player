export interface MxfTimecodeInfo {
  startFrame: number;
  roundedTimecodeBase: number;
  dropFrame: boolean;
  editRateNumerator: number;
  editRateDenominator: number;
  durationFrames?: number;
  packageKind?: "material" | "source";
}

function two(value: number): string {
  return Math.floor(value).toString().padStart(2, "0");
}

/** Convert an absolute timecode frame number, wrapping at the SMPTE 24-hour boundary. */
export function formatTimecodeFrame(frame: number, base: number, dropFrame = false): string {
  if (!Number.isInteger(base) || base <= 0) throw new Error("Timecode base must be a positive integer");
  const framesPerDay = base * 60 * 60 * 24 - (dropFrame ? dropFramesPerMinute(base) * (24 * 60 - 24 * 6) : 0);
  let value = Math.trunc(frame) % framesPerDay;
  if (value < 0) value += framesPerDay;

  if (dropFrame) {
    const dropped = dropFramesPerMinute(base);
    const framesPer10Minutes = base * 60 * 10 - dropped * 9;
    const framesPerMinute = base * 60 - dropped;
    const tenMinuteBlocks = Math.floor(value / framesPer10Minutes);
    const remainder = value % framesPer10Minutes;
    // The first minute in each ten-minute block does not drop frame numbers.
    value += dropped * 9 * tenMinuteBlocks;
    if (remainder >= base * 60) value += dropped * Math.floor((remainder - base * 60) / framesPerMinute + 1);
  }

  const ff = value % base;
  const seconds = Math.floor(value / base);
  const ss = seconds % 60;
  const minutes = Math.floor(seconds / 60);
  const mm = minutes % 60;
  const hh = Math.floor(minutes / 60) % 24;
  return `${two(hh)}:${two(mm)}:${two(ss)}${dropFrame ? ";" : ":"}${two(ff)}`;
}

function dropFramesPerMinute(base: number): number {
  if (base === 30) return 2;
  if (base === 60) return 4;
  throw new Error("Drop-frame timecode is supported only for 29.97 and 59.94 fps");
}

export function timecodeAtFrame(info: MxfTimecodeInfo, playbackFrame: number): string {
  return formatTimecodeFrame(info.startFrame + Math.max(0, Math.trunc(playbackFrame)), info.roundedTimecodeBase, info.dropFrame);
}

export function timecodeAtSeconds(info: MxfTimecodeInfo, seconds: number): string {
  const frame = Math.floor(Math.max(0, seconds) * info.editRateNumerator / info.editRateDenominator);
  return timecodeAtFrame(info, frame);
}
