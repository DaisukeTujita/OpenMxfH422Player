export type PlayerStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "buffering" | "ended" | "error";
export type PlaybackMode = "streaming" | "legacy";

export interface PlayerDiagnostics {
  mode: PlaybackMode; fileSize: number; bytesLoaded: number; underlyingReadCount: number;
  cacheBytes: number; videoQueueFrames: number; videoQueueStart: number | null;
  videoQueueEnd: number | null; scheduledAudioRanges: number; loadGeneration: number; seekGeneration: number;
  streamingAudioSupported: boolean; selectedAudioTrackNumber: number | null;
  audioSampleRate: number | null; audioChannels: number | null; audioQueueStart: number | null;
  audioQueueEnd: number | null; audioVideoDriftMs: number | null; audioBytesLoaded: number;
  audioQueuedThroughTime: number; audioExhausted: boolean; lastPlayableAudioTime: number | null;
  audioFormatBasis: "metadata-plus-xdcam-inference" | "xdcam-profile-inference" | null;
}

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
  getDiagnostics(): PlayerDiagnostics;
}

export interface H422PlayerProps {
  src: File | Blob | string;
  autoPlay?: boolean;
  controls?: boolean;
  muted?: boolean;
  /** Reader-backed bounded playback. Legacy remains the conservative default. */
  mode?: PlaybackMode;
  /** Directory containing the libav runtime copied by copy-libav-assets.mjs. */
  libavBase?: string;
  className?: string;
  onReady?: (info: PlayerInfo) => void;
  /** Structural MXF metadata. Missing fields remain undefined rather than receiving playback fallbacks. */
  onMediaInfo?: (info: import("./mxf-metadata").MxfMediaInfo) => void;
  /** Current MXF timecode, or null when no usable Timecode Track exists. */
  onTimecode?: (timecode: string | null) => void;
  onBufferingChange?: (buffering: boolean) => void;
  onDiagnostics?: (diagnostics: PlayerDiagnostics) => void;
  onSeekingChange?: (seeking: boolean) => void;
  onTimeUpdate?: (seconds: number) => void;
  onStatusChange?: (status: PlayerStatus) => void;
  onError?: (error: Error) => void;
}
