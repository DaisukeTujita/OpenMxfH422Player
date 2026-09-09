export type PlayerStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "buffering" | "ended" | "error";
/**
 * `PlayerStatus` plus the waiting states that were previously only reachable by combining it with
 * `onSeekingChange` / `onBufferingChange`. One subscribable value is what a host needs to decide
 * "spinner or not", so the library composes it instead of leaving every host to compose it again.
 */
export type PlayerState = "idle" | "loading" | "ready" | "seeking" | "buffering" | "playing" | "paused" | "ended" | "error";
export type PlaybackMode = "streaming" | "legacy";
export type VideoRenderMode = "rgba" | "yuv-webgl";
export type FrameSelection = "all-frames" | "key-frames";

/** What changed alongside the rate, so a host does not have to re-derive it from the diagnostics. */
export interface PlaybackRateChangeInfo {
  /** Signed: negative is reverse. */
  rate: number;
  /** Whether that rate is decoding every frame or only random-access frames. */
  frameSelection: FrameSelection;
  /** 0 when the rate mutes audio, which every decimated and every reverse rate does. */
  audioPlaybackRate: number;
}

/**
 * Sample peak and RMS of one channel over the measurement window. Linear values are 0..1 for
 * material that does not exceed full scale; the dB fields are dBFS, floored at
 * `AUDIO_LEVEL_SILENCE_DB` so a meter can scale them without special-casing -Infinity.
 */
export interface AudioChannelLevel {
  peak: number;
  rms: number;
  peakDb: number;
  rmsDb: number;
}

export interface AudioLevels {
  /** Media time the window starts at, in seconds. */
  time: number;
  /** Length of the measured window in media seconds. */
  windowSeconds: number;
  /** First channel first. At most two entries: channels beyond 1ch/2ch are never measured. */
  channels: AudioChannelLevel[];
}

/** One step the memory-adaptive buffer took, and the heap reading that triggered it. */
export interface MemoryBufferAdjustment {
  /** Wall-clock time the adjustment was made (`Date.now()`). */
  atMs: number;
  direction: "increased" | "decreased";
  videoAheadSeconds: number;
  videoQueueMaxBytes: number;
  retainBehindSeconds: number;
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

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
  /** Behind-playhead retention currently applied; shrinks first under memory pressure. */
  adaptiveRetainBehindSeconds?: number;
  /** Byte ceiling currently applied: `videoQueueMaxBytes` tightened by memory pressure if any. */
  adaptiveVideoQueueMaxBytes?: number;
  /** Whether `performance.memory` is available in this browser (Chrome/Edge only). */
  memoryApiAvailable?: boolean;
  /** `performance.memory` readings, or null where the API is unavailable. */
  jsHeapUsedBytes?: number | null; jsHeapLimitBytes?: number | null; jsHeapAvailableBytes?: number | null;
  /** How many times the memory-adaptive buffer target has changed this load, and a short log of them. */
  memoryBufferAdjustmentCount?: number; memoryBufferAdjustments?: MemoryBufferAdjustment[];
  /** Since the current load: how many times playback stalled waiting for a refill, and for how long in total. */
  bufferingEventCount?: number; bufferingTotalMs?: number;
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
  /** Composed playback state, including the waiting states a host shows a spinner for. */
  readonly state: PlayerState;
  /** Latest measured levels, or null while measurement is disabled. */
  getAudioLevels(): AudioLevels | null;
  /** Turns measurement on or off at runtime. Disabled means no measurement work at all. */
  setAudioLevelsEnabled(enabled: boolean): void;
  readonly audioLevelsEnabled: boolean;
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
  /**
   * Polls `performance.memory` (Chrome/Edge only) and shrinks the buffer target under memory
   * pressure, growing it back as pressure eases. Enabled by default; on a browser without the API
   * a fixed conservative target is used instead of the full default. See the individual
   * `memory*`/`min*`/`fallback*` props to tune thresholds and floors.
   */
  enableMemoryAdaptiveBuffer?: boolean;
  memoryCheckIntervalMs?: number;
  memoryHighWaterRatio?: number;
  memoryLowWaterRatio?: number;
  memoryShrinkFactor?: number;
  memoryGrowFactor?: number;
  minVideoAheadSeconds?: number;
  minVideoQueueMaxBytes?: number;
  minRetainBehindSeconds?: number;
  fallbackVideoAheadSeconds?: number;
  fallbackVideoQueueMaxBytes?: number;
  /**
   * Measures the level of the first two audio channels while playing. Off by default: metering a
   * stream nobody displays is pure overhead. Toggling this prop starts and stops the measurement
   * itself, so a host that hides its meter stops paying for it.
   */
  enableAudioLevels?: boolean;
  /**
   * How often levels are measured and reported, in milliseconds. Also the length of the measured
   * window. Read once when the player mounts; changing it afterwards has no effect. Defaults to
   * DEFAULT_AUDIO_LEVEL_INTERVAL_MS.
   */
  audioLevelIntervalMs?: number;
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
  /** Composed state, including `seeking` and `buffering`. Fires only when the value changes. */
  onStateChange?: (state: PlayerState) => void;
  /** Fires for every route that changes the rate or what that rate decodes, including a reload. */
  onPlaybackRateChange?: (rate: number, info: PlaybackRateChangeInfo) => void;
  /** Periodic levels for 1ch/2ch while `enableAudioLevels` is on. Silent when nothing is audible. */
  onAudioLevelUpdate?: (levels: AudioLevels) => void;
  onError?: (error: Error) => void;
}
