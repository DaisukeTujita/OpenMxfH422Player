export type PlayerStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "buffering" | "ended" | "error";
export type PlaybackMode = "streaming" | "legacy";
export type VideoRenderMode = "rgba" | "yuv-webgl";

export interface PlayerDiagnostics {
  mode: PlaybackMode; videoRenderMode: VideoRenderMode; fileSize: number; bytesLoaded: number; underlyingReadCount: number;
  cacheBytes: number; videoQueueFrames: number; videoQueueStart: number | null;
  videoQueueEnd: number | null; scheduledAudioRanges: number; loadGeneration: number; seekGeneration: number;
  /** Decoded video held in memory, and the ceiling it is held under. */
  videoQueueBytes?: number; videoQueueMaxBytes?: number;
  streamingAudioSupported: boolean; selectedAudioTrackNumber: number | null;
  audioSampleRate: number | null; audioChannels: number | null; audioQueueStart: number | null;
  audioQueueEnd: number | null; audioVideoDriftMs: number | null; audioBytesLoaded: number;
  audioQueuedThroughTime: number; audioExhausted: boolean; lastPlayableAudioTime: number | null;
  audioFormatBasis: "metadata-plus-xdcam-inference" | "xdcam-profile-inference" | null;
  requestedTimecode?: string | null; requestedFrame?: number | null; actualDisplayedFrame?: number | null;
  seekStartFrame?: number | null; prerollFrames?: number; seekSource?: "index" | "sequential-fallback" | null;
  seekReadBytes?: number; seekElapsedMs?: number | null; selectedTimecodeTrack?: "unresolved" | null;
  timecodeSelectionReason?: string;
  videoDecodedFrames: number; videoDecodeMs: number; videoColorConvertMs: number; videoUploadMs: number;
  decoderExecution?: "dedicated-worker"; adaptiveVideoAheadSeconds?: number; adaptiveRefillThresholdSeconds?: number;
  /** "canvas2d" means WebGL was unavailable and the player fell back to CPU colour conversion. */
  rendererBackend?: "webgl" | "canvas2d";
  /** Signed: negative is reverse. `frameSelection` says whether that rate is decoding every frame. */
  playbackRate?: number; frameSelection?: "all-frames" | "key-frames";
  /** 0 when audio is muted because the rate is decimated or reversed. */
  audioPlaybackRate?: number;
  lastChunkDecodeMs?: number; pooledVideoFrames?: number;
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
  /** Seek to an exact media frame represented by an MXF timecode label. */
  seekTimecode(timecode: string): Promise<void>;
  /** Step whole frames from the current position. Pauses first; negative steps backwards. */
  stepFrame(frames?: number): Promise<void>;
  /** Skip relative to the current position, clamped to the media. Keeps playing if it was playing. */
  seekRelative(seconds: number): Promise<void>;
  /**
   * Signed playback rate; negative plays backwards. Rejects 0 — use `pause()`. Rates above
   * `fullDecodeMaxRate`, and every reverse rate, switch to decoding only key frames.
   */
  setPlaybackRate(rate: number): Promise<void>;
  readonly playbackRate: number;
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
  /**
   * Direct planar YUV upload with GPU conversion (default), or CPU YUV-to-RGBA conversion. When
   * WebGL is unavailable the player falls back to a 2D canvas and forces "rgba" regardless of this
   * setting; check the `rendererBackend` diagnostic to see whether that happened.
   */
  videoRenderMode?: VideoRenderMode;
  /** Directory containing the libav runtime copied by copy-libav-assets.mjs. */
  libavBase?: string;
  /**
   * Ceiling on decoded video held in memory, in bytes. Applied alongside the look-ahead target in
   * seconds; whichever binds first stops the refill. Raise it on machines with memory to spare,
   * lower it to share the tab with other work. Defaults to DEFAULT_VIDEO_QUEUE_MAX_BYTES.
   */
  videoQueueMaxBytes?: number;
  /**
   * Highest forward rate that still decodes every frame. Above it, and for any reverse rate, the
   * player decodes only random-access frames and displays them decimated. Raise it if the decoder
   * gets faster. Defaults to DEFAULT_FULL_DECODE_MAX_RATE.
   */
  fullDecodeMaxRate?: number;
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
