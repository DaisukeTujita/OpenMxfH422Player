export type PlayerStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "error";

export interface PlayerInfo {
  width: number;
  height: number;
  frameRate: number;
  duration: number;
  audioSampleRate: number;
  audioChannels: number;
}

export interface H422PlayerHandle {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
  readonly currentTime: number;
  readonly duration: number;
}

export interface H422PlayerProps {
  src: File | Blob | string;
  autoPlay?: boolean;
  controls?: boolean;
  muted?: boolean;
  /** Directory containing the libav runtime copied by copy-libav-assets.mjs. */
  libavBase?: string;
  className?: string;
  onReady?: (info: PlayerInfo) => void;
  /** Structural MXF metadata. Missing fields remain undefined rather than receiving playback fallbacks. */
  onMediaInfo?: (info: import("./mxf-metadata").MxfMediaInfo) => void;
  /** Current MXF timecode, or null when no usable Timecode Track exists. */
  onTimecode?: (timecode: string | null) => void;
  onBufferingChange?: (buffering: boolean) => void;
  onSeekingChange?: (seeking: boolean) => void;
  onTimeUpdate?: (seconds: number) => void;
  onStatusChange?: (status: PlayerStatus) => void;
  onError?: (error: Error) => void;
}
