export interface MxfTimecodeInfo {
  startFrame: number;
  roundedTimecodeBase: number;
  dropFrame: boolean;
  editRateNumerator: number;
  editRateDenominator: number;
  durationFrames?: number;
  packageKind?: "material" | "source";
  /** True only when package ownership was resolved from structural metadata. */
  packageReferenceResolved?: boolean;
  source?: "mxf" | "inferred";
}

export type TimecodeConversionError = "invalid-format" | "invalid-frame-number" | "invalid-drop-frame-number" | "out-of-range";
export interface TimecodePosition { timecode: string; mediaFrame: number; mediaSeconds: number }

const two = (value: number) => Math.floor(value).toString().padStart(2, "0");
const droppedPerMinute = (base: number) => {
  if (base === 30) return 2;
  if (base === 60) return 4;
  throw new Error("Drop-frame timecode requires nominal 30 or 60 fps");
};
export const framesPerTimecodeDay = (base: number, drop: boolean) => base * 86400 - (drop ? droppedPerMinute(base) * 1296 : 0);

/** Format a zero-based SMPTE frame count; negative and >24-hour values wrap. */
export function formatTimecodeFrame(frame: number, base: number, dropFrame = false): string {
  if (!Number.isInteger(base) || base <= 0) throw new Error("Timecode base must be a positive integer");
  const day = framesPerTimecodeDay(base, dropFrame);
  let count = Math.trunc(frame) % day;
  if (count < 0) count += day;
  let label = count;
  if (dropFrame) {
    const drop = droppedPerMinute(base), per10 = base * 600 - drop * 9, perMinute = base * 60 - drop;
    const blocks = Math.floor(count / per10), remainder = count % per10;
    label += blocks * drop * 9;
    if (remainder >= base * 60) label += drop * (Math.floor((remainder - base * 60) / perMinute) + 1);
  }
  const ff = label % base, totalSeconds = Math.floor(label / base);
  return `${two(Math.floor(totalSeconds / 3600) % 24)}:${two(Math.floor(totalSeconds / 60) % 60)}:${two(totalSeconds % 60)}${dropFrame ? ";" : ":"}${two(ff)}`;
}

/** Parse an SMPTE label to its absolute frame count within a 24-hour day. */
export function parseTimecodeFrame(value: string, base: number, dropFrame: boolean): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/.exec(value);
  if (!match || (dropFrame ? match[4] !== ";" : match[4] !== ":")) throw new Error("invalid-format" satisfies TimecodeConversionError);
  const hh=Number(match[1]), mm=Number(match[2]), ss=Number(match[3]), ff=Number(match[5]);
  if (hh > 23 || mm > 59 || ss > 59 || ff >= base) throw new Error("invalid-frame-number" satisfies TimecodeConversionError);
  const label=((hh*60+mm)*60+ss)*base+ff;
  if (!dropFrame) return label;
  const drop=droppedPerMinute(base), totalMinutes=hh*60+mm;
  if (mm % 10 !== 0 && ss === 0 && ff < drop) throw new Error("invalid-drop-frame-number" satisfies TimecodeConversionError);
  return label-drop*(totalMinutes-Math.floor(totalMinutes/10));
}

function validate(info:MxfTimecodeInfo) {
  if (info.editRateNumerator <= 0 || info.editRateDenominator <= 0) throw new Error("invalid-edit-rate");
}
export function mediaFrameToTimecode(info:MxfTimecodeInfo, mediaFrame:number):string { validate(info); return formatTimecodeFrame(info.startFrame+Math.trunc(mediaFrame),info.roundedTimecodeBase,info.dropFrame); }
export function mediaSecondsToTimecode(info:MxfTimecodeInfo, seconds:number):string { validate(info); return mediaFrameToTimecode(info,Math.floor(Math.max(0,seconds)*info.editRateNumerator/info.editRateDenominator)); }
export function timecodeToMediaFrame(info:MxfTimecodeInfo,value:string):number {
  validate(info); const absolute=parseTimecodeFrame(value,info.roundedTimecodeBase,info.dropFrame), day=framesPerTimecodeDay(info.roundedTimecodeBase,info.dropFrame);
  const frame=(absolute-(info.startFrame%day)+day)%day;
  if (info.durationFrames !== undefined && frame >= info.durationFrames) throw new Error("out-of-range" satisfies TimecodeConversionError);
  return frame;
}
export function timecodeToMediaSeconds(info:MxfTimecodeInfo,value:string):number { return timecodeToMediaFrame(info,value)*info.editRateDenominator/info.editRateNumerator; }
export function resolveTimecodePosition(info:MxfTimecodeInfo,value:string):TimecodePosition { const mediaFrame=timecodeToMediaFrame(info,value); return {timecode:formatTimecodeFrame(parseTimecodeFrame(value,info.roundedTimecodeBase,info.dropFrame),info.roundedTimecodeBase,info.dropFrame),mediaFrame,mediaSeconds:mediaFrame*info.editRateDenominator/info.editRateNumerator}; }

// Backwards-compatible names.
export function timecodeAtFrame(info:MxfTimecodeInfo, playbackFrame:number):string { return mediaFrameToTimecode(info,Math.max(0,Math.trunc(playbackFrame))); }
export const timecodeAtSeconds=mediaSecondsToTimecode;
