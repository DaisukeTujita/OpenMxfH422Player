import { parseMxf, type ParsedMxf } from "./mxf";
import { parseMxfMetadataFromReader } from "./mxf-reader";
import { FileRandomAccessReader, type RandomAccessReader } from "./random-access-reader";
import { pcmS24beToFloat32, XDCAM_FRAME_RATE } from "./media";
import { timecodeAtSeconds, timecodeToMediaFrame, type MxfTimecodeInfo } from "./timecode";
import { findSeekPoint, mergeIndexTables } from "./mxf-index";
import type { AudioLevels, FrameSelection, MemoryBufferAdjustment, PlaybackRateChangeInfo, PlayerInfo, PlayerState, PlayerStatus } from "./types";
import { derivePlayerState } from "./player-state";
import { accumulateAudioLevels, createAudioLevelAccumulator, DEFAULT_AUDIO_LEVEL_INTERVAL_MS, finalizeAudioLevels, silentAudioLevels, type AudioLevelBufferLike } from "./audio-levels";
import { createFrameRenderer, type FrameRenderer, type Yuv422Frame } from "./webgl";
import { essenceDecodeStart, indexMxfEssence, isRandomAccessVideoPacket, readEssenceRange, type EssenceIndex, type ReadEssencePacket } from "./essence-reader";
import type { PlaybackMode, PlayerDiagnostics, VideoRenderMode } from "./types";
import { createWorkerVideoDecoderClient, type VideoDecoderClient } from "./video-decoder-client";
import { renderFrameBuffers, renderFrameBytes, type WorkerRenderFrame } from "./video-decode-core";

export { loadCustomLibAV } from "./libav-loader";

interface Callbacks { status(s: PlayerStatus): void; ready(i: PlayerInfo): void; time(t: number): void; error(e: Error): void; mediaInfo?(i: import("./mxf-metadata").MxfMediaInfo): void; timecode?(value: string | null): void; seeking?(value: boolean): void; buffering?(value:boolean):void; diagnostics?(value:PlayerDiagnostics):void; state?(value:PlayerState):void; playbackRate?(rate:number,info:PlaybackRateChangeInfo):void; audioLevels?(levels:AudioLevels):void }
type RenderFrame = WorkerRenderFrame;
type StreamingAudioChunk = {mediaStartTime:number;mediaEndTime:number;buffer:AudioBuffer;generation:number;scheduled:boolean};
type ScheduledAudio = {mediaStartTime:number;mediaEndTime:number;contextStartTime:number;sourceNode:AudioBufferSourceNode;generation:number;started:boolean;ended:boolean};
type VideoPrefetch = {startFrame:number; endFrame:number; loadGeneration:number; seekGeneration:number; promise:Promise<ReadEssencePacket[]>};
export interface PlayerEngineDependencies {
  createReader(blob: Blob): RandomAccessReader & {destroy():void};
  parseMetadata(reader: RandomAccessReader, signal: AbortSignal): ReturnType<typeof parseMxfMetadataFromReader>;
  readWhole(blob: Blob): Promise<Uint8Array>;
  parse(bytes: Uint8Array): ParsedMxf;
  createVideoDecoder(): VideoDecoderClient;
  indexEssence: typeof indexMxfEssence;
  readRange: typeof readEssenceRange;
}
const defaultDependencies: PlayerEngineDependencies = {
  createReader: blob=>new FileRandomAccessReader(blob,{debug:message=>console.info(`[H422Player] ${message}`)}), parseMetadata:(reader,signal)=>parseMxfMetadataFromReader(reader,{signal}),
  readWhole:async blob=>new Uint8Array(await blob.slice(0,blob.size).arrayBuffer()), parse:parseMxf, createVideoDecoder:createWorkerVideoDecoderClient, indexEssence:indexMxfEssence, readRange:readEssenceRange,
};

/**
 * Decoded frames dominate this player's footprint: one 1080-line 4:2:2 frame is ~4.15 MB, so a
 * look-ahead expressed only in seconds peaked around 1.5 GB at the 9 s the adaptive sizing settles
 * on. The floor is set by stalling, not by taste: a refill decodes a whole `chunkSeconds` chunk, so
 * the queue peaks at (look-ahead + one chunk), and the look-ahead has to outlast a chunk decode —
 * measured at ~2.7 s for a 3 s chunk of 1080i — or playback runs dry every refill.
 *
 * 1 GiB is ~258 of those frames: ~168 ahead (5.6 s at 29.97 fps) plus the 90-frame chunk that lands
 * on top. That was chosen by measurement, not arithmetic. On the reference 1080i sample this held
 * playback at ~730 MB against ~1467 MB uncapped, with no buffering stall; 768 MiB, which leaves only
 * a 3.5 s look-ahead, did stall on the same machine once decode slowed under load. Note the machine
 * matters more than the budget here: decode measured anywhere from 0.6x to 1.2x realtime depending
 * on load, and no buffer size rescues a decoder that cannot keep up.
 *
 * Hosts that know their deployment should override it. Raising it buys stall resistance. Lowering
 * it below about two chunks' worth of frames trades playback smoothness for memory, because the
 * look-ahead can no longer cover one chunk decode.
 */
export const DEFAULT_VIDEO_QUEUE_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Above this rate a forward playback decodes only random-access frames instead of every frame.
 * Decoding all frames needs throughput proportional to the rate, and this codebase measures roughly
 * 1.0-1.2x realtime for 1080i, so 2x would need ~2.4x and 4x ~4.8x — not reachable by buffering.
 * It is an option rather than a constant so a faster build (a SIMD libav, say) can raise it without
 * a code change. Reverse ignores it: MPEG-2 Long-GOP cannot be decoded backwards, so even 1.5x
 * reverse would mean decoding each GOP forwards and throwing most of it away.
 */
export const DEFAULT_FULL_DECODE_MAX_RATE = 1.5;

/**
 * How much playable media a rate change has to have queued before it may switch to decimated
 * decoding without re-seeking. Half a wall-clock second is roughly two refill decisions at the
 * 250 ms playback timer, which is enough for the first decimated refill to land; below that the
 * in-place switch would just trade a seek for a buffer underrun.
 */
const IN_PLACE_DECIMATION_MIN_SECONDS = 0.5;

/**
 * `navigator.deviceMemory` rounds every machine at 8 GB and above to "8", so it cannot tell an 8 GB
 * machine already under memory pressure from a well-provisioned one, and it is read once at startup
 * rather than tracking pressure that builds up afterward. Measured on a 5-year-old 8 GB Windows
 * machine: the browser tab alone sat at ~80% of its heap limit before any file was even chosen, and
 * ~90% once one was loaded — a static, unmeasurable guess made once at load time cannot see that.
 * Polling `performance.memory` (Chrome/Edge only) instead reacts to the real, changing constraint.
 */
export const DEFAULT_MEMORY_CHECK_INTERVAL_MS = 3000;
/** Above this fraction of `jsHeapSizeLimit` used, every memory-adaptive ceiling shrinks one step. */
export const DEFAULT_MEMORY_HIGH_WATER_RATIO = 0.75;
/** Below this fraction used, every memory-adaptive ceiling grows one step back toward its target. */
export const DEFAULT_MEMORY_LOW_WATER_RATIO = 0.55;
/** Multiplier applied to a ceiling once per check while usage stays at or above the high-water ratio. */
export const DEFAULT_MEMORY_SHRINK_FACTOR = 0.75;
/** Multiplier applied to a ceiling once per check while usage stays at or below the low-water ratio. */
export const DEFAULT_MEMORY_GROW_FACTOR = 1.2;
/** The look-ahead is never shrunk past this: below it a refill can no longer outlast a chunk decode. */
export const DEFAULT_MIN_VIDEO_AHEAD_SECONDS = 2;
/** The byte ceiling is never shrunk past this. */
export const DEFAULT_MIN_VIDEO_QUEUE_MAX_BYTES = 192 * 1024 * 1024;
/** The behind-playhead retention is never shrunk past this. */
export const DEFAULT_MIN_RETAIN_BEHIND_SECONDS = 0.25;
/**
 * Ceiling used in place of `videoAheadSeconds`/`videoQueueMaxBytes` when `performance.memory` is not
 * available (Firefox, Safari) and pressure therefore cannot be measured at all: a fixed conservative
 * target rather than assuming the full, decode-speed-tuned default fits an unmeasured machine.
 */
export const DEFAULT_FALLBACK_VIDEO_AHEAD_SECONDS = 4;
export const DEFAULT_FALLBACK_VIDEO_QUEUE_MAX_BYTES = 512 * 1024 * 1024;

export interface PlayerEngineOptions { mode?: PlaybackMode; videoRenderMode?:VideoRenderMode; videoAheadSeconds?:number; retainBehindSeconds?:number; refillThresholdSeconds?:number; chunkSeconds?:number; maxReadSize?:number; videoQueueMaxBytes?:number; fullDecodeMaxRate?:number; enableAudioLevels?:boolean; audioLevelIntervalMs?:number;
  /** Turns the memory-adaptive buffer target on or off. Enabled by default. */
  enableMemoryAdaptiveBuffer?:boolean;
  /** How often `performance.memory` is polled while enabled and available, in milliseconds. */
  memoryCheckIntervalMs?:number;
  /** Used/limit ratio at or above which the buffer target shrinks. */
  memoryHighWaterRatio?:number;
  /** Used/limit ratio at or below which the buffer target grows back. */
  memoryLowWaterRatio?:number;
  /** Per-check multiplier while shrinking. */
  memoryShrinkFactor?:number;
  /** Per-check multiplier while growing back. */
  memoryGrowFactor?:number;
  /** Floor the look-ahead target is never shrunk past. */
  minVideoAheadSeconds?:number;
  /** Floor the byte ceiling is never shrunk past. */
  minVideoQueueMaxBytes?:number;
  /** Floor the behind-playhead retention is never shrunk past. */
  minRetainBehindSeconds?:number;
  /** Ceiling used instead of `videoAheadSeconds` when `performance.memory` is unavailable. */
  fallbackVideoAheadSeconds?:number;
  /** Ceiling used instead of `videoQueueMaxBytes` when `performance.memory` is unavailable. */
  fallbackVideoQueueMaxBytes?:number;
}

type TimecodeLogger = Pick<Console, "debug" | "info" | "warn">;

/**
 * Until package references are resolved, preserve KLV discovery order and select
 * the first track that has a usable Edit Rate. The diagnostics make ambiguity visible.
 */
export function selectTimecodeTrack(timecodes: MxfTimecodeInfo[], logger: TimecodeLogger = console): MxfTimecodeInfo | undefined {
  logger.debug(`[H422Player] detected Timecode Tracks: ${timecodes.length}`);
  const usable = timecodes.filter(value => value.editRateNumerator > 0 && value.editRateDenominator > 0);
  const selected = usable[0];
  if (timecodes.length > 1) logger.warn(`[H422Player] multiple Timecode Tracks detected (${timecodes.length}); Package references are unsupported, selecting the first usable track in KLV discovery order`);
  if (selected) logger.info(`[H422Player] selected Timecode Track: start=${selected.startFrame} edit_rate=${selected.editRateNumerator}/${selected.editRateDenominator} drop_frame=${selected.dropFrame}`);
  else logger.debug("[H422Player] no Timecode Track with a usable Edit Rate was found");
  return selected;
}

export class PlayerEngine {
  private renderer: FrameRenderer; private audio?: AudioContext; private audioBuffer?: AudioBuffer; private audioSource?: AudioBufferSourceNode;
  private status: PlayerStatus="idle"; private playAnchorMedia=0; private playAnchorWall=0; private pausedAt=0; private durationValue=0;
  /**
   * Signed rather than a rate plus a direction flag: one value has no invalid combinations, and the
   * clock is then just anchor + elapsed * rate, with direction falling out of the arithmetic.
   * Zero is rejected because it would mean "playing but not moving"; pause() is how you stop.
   */
  private playbackRateValue=1;
  private frames: RenderFrame[]=[]; private raf=0;
  private timecodeInfo?: MxfTimecodeInfo;
  private loadController?: AbortController; private destroyed=false; private loadGeneration=0;
  private seekController?: AbortController; private seekGeneration=0;
  private requestedTimecode:string|null=null; private requestedFrame:number|null=null; private actualDisplayedFrame:number|null=null; private seekStartFrame:number|null=null; private prerollFrames=0; private seekSource:PlayerDiagnostics["seekSource"]=null; private seekReadBytes=0; private seekElapsedMs:number|null=null; private timecodeSelectionReason="Timecode Trackなし";
  private reader?: RandomAccessReader & {destroy():void}; private essenceIndex?:EssenceIndex; private indexTables:import("./mxf-index").MxfIndexTable[]=[]; private mode:PlaybackMode;
  private fileSize=0; private videoRenderMode:VideoRenderMode; private videoDecodedFrames=0; private videoDecodeMs=0; private videoColorConvertMs=0; private videoUploadMs=0; private filling?:Promise<void>; private fillController?:AbortController; private queuedThroughFrame=-1; private videoCodecId=2;
  private videoDecoderClient?:VideoDecoderClient; private streamingDecoderGeneration?:{loadGeneration:number; seekGeneration:number}; private videoPrefetch?:VideoPrefetch; private playbackCheckActive=false;
  private recyclableBuffers:ArrayBuffer[]=[]; private pooledVideoFrames=0; private keyFrameCoverage?:{from:number;to:number};
  private buffering=false; private resumeAfterBuffer=false; private seeking=false; private lastState?:PlayerState; private lastPlaybackRateInfo?:PlaybackRateChangeInfo;
  private audioLevelsOn:boolean; private readonly audioLevelIntervalMs:number; private audioLevelTimer?:number; private lastAudioLevels?:AudioLevels;
  private streamingAudioSupported=false; private audioFormatBasis:PlayerDiagnostics["audioFormatBasis"]=null; private selectedAudioTrackNumber?:number; private audioSampleRate?:number; private audioChannels?:number;
  private audioChunks:StreamingAudioChunk[]=[]; private scheduledAudio:ScheduledAudio[]=[]; private audioBytesLoaded=0; private audioMediaAnchor?:number; private audioContextAnchor?:number; private audioQueuedThroughTime=0; private audioExhausted=false; private lastAudioTime=0; private audioFillController?:AbortController; private audioFilling?:Promise<void>;
  private destroyedReaders?:WeakSet<object>;
  private readonly videoAheadSeconds:number; private readonly retainBehindSeconds:number; private readonly refillThresholdSeconds:number; private readonly chunkSeconds:number; private readonly maxReadSize:number; private readonly videoQueueMaxBytes:number; private readonly fullDecodeMaxRate:number;
  private frameBytes=0;
  private adaptiveVideoAheadSeconds:number; private adaptiveRefillThresholdSeconds:number; private lastChunkDecodeMs=0;
  private readonly memoryAdaptiveBufferEnabled:boolean; private readonly memoryCheckIntervalMs:number; private readonly memoryHighWaterRatio:number; private readonly memoryLowWaterRatio:number; private readonly memoryShrinkFactor:number; private readonly memoryGrowFactor:number;
  private readonly minVideoAheadSeconds:number; private readonly minVideoQueueMaxBytes:number; private readonly minRetainBehindSeconds:number; private readonly fallbackVideoAheadSeconds:number; private readonly fallbackVideoQueueMaxBytes:number;
  private memoryApiAvailable=false; private memoryVideoAheadCeiling=Infinity; private memoryVideoQueueMaxBytesCeiling=Infinity; private memoryRetainBehindCeiling=Infinity; private memoryCheckTimer?:number;
  private lastMemorySample?:{usedJSHeapSize:number;totalJSHeapSize:number;jsHeapSizeLimit:number}; private memoryAdjustmentLog:MemoryBufferAdjustment[]=[];
  private bufferingEventCount=0; private bufferingTotalMs=0; private bufferingStartedAtMs?:number;
  private readonly dependencies: PlayerEngineDependencies;
  constructor(canvas: HTMLCanvasElement, private callbacks: Callbacks, private muted=false, private libavBase="/libav", dependencies: Partial<PlayerEngineDependencies>={}, options:PlayerEngineOptions={}) { this.dependencies={...defaultDependencies,...dependencies};this.renderer=createFrameRenderer(canvas);this.mode=options.mode??"legacy";
    // Planar YUV has no path on a 2D canvas, so a WebGL fallback also forces CPU colour conversion.
    this.videoRenderMode=this.renderer.backend==="canvas2d"?"rgba":(options.videoRenderMode??"yuv-webgl");this.videoAheadSeconds=options.videoAheadSeconds??6;this.retainBehindSeconds=options.retainBehindSeconds??1;this.refillThresholdSeconds=options.refillThresholdSeconds??4;this.adaptiveVideoAheadSeconds=this.videoAheadSeconds;this.adaptiveRefillThresholdSeconds=this.refillThresholdSeconds;this.chunkSeconds=options.chunkSeconds??3;this.maxReadSize=options.maxReadSize??4*1024*1024;this.videoQueueMaxBytes=options.videoQueueMaxBytes??DEFAULT_VIDEO_QUEUE_MAX_BYTES;this.fullDecodeMaxRate=options.fullDecodeMaxRate??DEFAULT_FULL_DECODE_MAX_RATE;
    // A meter cannot resolve faster than it is sampled, and a sub-frame interval would sample the
    // same window twice, so the floor is one video frame rather than an arbitrary small number.
    this.audioLevelIntervalMs=Math.max(1000/XDCAM_FRAME_RATE,options.audioLevelIntervalMs??DEFAULT_AUDIO_LEVEL_INTERVAL_MS);this.audioLevelsOn=options.enableAudioLevels??false;if(this.audioLevelsOn)this.startAudioLevelSampling();
    this.memoryAdaptiveBufferEnabled=options.enableMemoryAdaptiveBuffer??true;this.memoryCheckIntervalMs=options.memoryCheckIntervalMs??DEFAULT_MEMORY_CHECK_INTERVAL_MS;this.memoryHighWaterRatio=options.memoryHighWaterRatio??DEFAULT_MEMORY_HIGH_WATER_RATIO;this.memoryLowWaterRatio=options.memoryLowWaterRatio??DEFAULT_MEMORY_LOW_WATER_RATIO;this.memoryShrinkFactor=options.memoryShrinkFactor??DEFAULT_MEMORY_SHRINK_FACTOR;this.memoryGrowFactor=options.memoryGrowFactor??DEFAULT_MEMORY_GROW_FACTOR;
    this.minVideoAheadSeconds=options.minVideoAheadSeconds??DEFAULT_MIN_VIDEO_AHEAD_SECONDS;this.minVideoQueueMaxBytes=options.minVideoQueueMaxBytes??DEFAULT_MIN_VIDEO_QUEUE_MAX_BYTES;this.minRetainBehindSeconds=options.minRetainBehindSeconds??DEFAULT_MIN_RETAIN_BEHIND_SECONDS;this.fallbackVideoAheadSeconds=options.fallbackVideoAheadSeconds??DEFAULT_FALLBACK_VIDEO_AHEAD_SECONDS;this.fallbackVideoQueueMaxBytes=options.fallbackVideoQueueMaxBytes??DEFAULT_FALLBACK_VIDEO_QUEUE_MAX_BYTES;
    this.lastMemorySample=this.getMemorySample();this.memoryApiAvailable=Boolean(this.lastMemorySample);
    this.memoryVideoAheadCeiling=this.memoryApiAvailable?this.videoAheadSeconds:Math.min(this.videoAheadSeconds,this.fallbackVideoAheadSeconds);
    this.memoryVideoQueueMaxBytesCeiling=this.memoryApiAvailable?this.videoQueueMaxBytes:Math.min(this.videoQueueMaxBytes,this.fallbackVideoQueueMaxBytes);
    this.memoryRetainBehindCeiling=this.retainBehindSeconds;
    if(this.memoryAdaptiveBufferEnabled&&this.memoryApiAvailable)this.startMemoryMonitor();
  }
  get currentTime(): number {
    if (this.status !== "playing") return this.pausedAt;
    const elapsed=(performance.now()-this.playAnchorWall)/1000*this.playbackRateValue;
    return Math.min(this.durationValue,Math.max(0,this.playAnchorMedia+elapsed));
  }
  get playbackRate(): number { return this.playbackRateValue; }
  /** `delayMs` lets the media clock start when the audio reservation does, keeping the two aligned. */
  private anchorPlayback(mediaTime:number,delayMs=0):void { this.playAnchorMedia=mediaTime; this.playAnchorWall=performance.now()+delayMs; }
  get duration(): number { return this.durationValue; }
  get state(): PlayerState { return derivePlayerState({status:this.status,seeking:this.seeking,buffering:this.buffering}); }
  private setStatus(s: PlayerStatus) { this.status=s; this.callbacks.status(s); this.emitState(); }
  /** One notification per actual change, whichever of the three inputs moved. */
  private emitState():void { const next=this.state; if(next===this.lastState)return; this.lastState=next; this.callbacks.state?.(next); }
  private setSeeking(value:boolean):void { if(this.seeking===value)return; this.seeking=value; this.callbacks.seeking?.(value); this.emitState(); }
  /**
   * Every route that changes the rate goes through here, so a subscriber sees the same value the
   * engine acts on. What the rate implies is reported with it: a host that highlights the selected
   * speed usually also wants to say whether it is decimating or has muted the audio.
   */
  private applyPlaybackRate(rate:number):void { this.playbackRateValue=rate; this.emitPlaybackRate(); }
  private emitPlaybackRate():void {
    const info:PlaybackRateChangeInfo={rate:this.playbackRateValue,frameSelection:this.frameSelection(),audioPlaybackRate:this.audioPlaybackRate()};
    const previous=this.lastPlaybackRateInfo;
    if(previous&&previous.rate===info.rate&&previous.frameSelection===info.frameSelection&&previous.audioPlaybackRate===info.audioPlaybackRate)return;
    this.lastPlaybackRateInfo=info;
    this.callbacks?.playbackRate?.(info.rate,info);
  }
  private drawFrame(frame:ImageData|Yuv422Frame):void { const started=performance.now();this.renderer.draw(frame,frame.width,frame.height);this.videoUploadMs+=(performance.now()-started); }
  getDiagnostics():PlayerDiagnostics { const stats=(this.reader as any)?.getStats?.()??{};const active=this.audio&&this.scheduledAudio.find(range=>range.contextStartTime<=this.audio!.currentTime&&range.contextStartTime+(range.mediaEndTime-range.mediaStartTime)/(this.audioPlaybackRate()||1)>=this.audio!.currentTime);const audioTime=active&&this.audio?active.mediaStartTime+(this.audio.currentTime-active.contextStartTime)*(this.audioPlaybackRate()||1):null;return {mode:this.mode,videoRenderMode:this.videoRenderMode,fileSize:this.fileSize,bytesLoaded:Number(stats.bytesLoaded??0),underlyingReadCount:stats.underlyingReadCount??0,cacheBytes:stats.cachedBytes??0,videoQueueFrames:this.frames.length,videoQueueStart:this.frames[0]?.time??null,videoQueueEnd:this.frames.at(-1)?.time??null,scheduledAudioRanges:this.mode==="streaming"?this.scheduledAudio.length:(this.audioSource?1:0),loadGeneration:this.loadGeneration,seekGeneration:this.seekGeneration,streamingAudioSupported:this.streamingAudioSupported,selectedAudioTrackNumber:this.selectedAudioTrackNumber??null,audioSampleRate:this.audioSampleRate??null,audioChannels:this.audioChannels??null,audioQueueStart:this.audioChunks?.[0]?.mediaStartTime??null,audioQueueEnd:this.audioChunks?.at(-1)?.mediaEndTime??null,audioVideoDriftMs:audioTime===null?null:(audioTime-this.currentTime)*1000,audioBytesLoaded:this.audioBytesLoaded,audioQueuedThroughTime:this.audioQueuedThroughTime,audioExhausted:this.audioExhausted,lastPlayableAudioTime:this.streamingAudioSupported?this.lastAudioTime:null,audioFormatBasis:this.audioFormatBasis,requestedTimecode:this.requestedTimecode,requestedFrame:this.requestedFrame,actualDisplayedFrame:this.actualDisplayedFrame,seekStartFrame:this.seekStartFrame,prerollFrames:this.prerollFrames,seekSource:this.seekSource,seekReadBytes:this.seekReadBytes,seekElapsedMs:this.seekElapsedMs,selectedTimecodeTrack:this.timecodeInfo?"unresolved":null,timecodeSelectionReason:this.timecodeSelectionReason,videoDecodedFrames:this.videoDecodedFrames,videoDecodeMs:this.videoDecodeMs,videoColorConvertMs:this.videoColorConvertMs,videoUploadMs:this.videoUploadMs,decoderExecution:"dedicated-worker",rendererBackend:this.renderer.backend,playbackRate:this.playbackRateValue??1,frameSelection:this.frameSelection(),audioPlaybackRate:this.audioPlaybackRate(),adaptiveVideoAheadSeconds:this.aheadSecondsTarget(),adaptiveRefillThresholdSeconds:this.refillThresholdTarget(),adaptiveRetainBehindSeconds:this.effectiveRetainBehindSeconds(),videoQueueBytes:this.videoQueueBytes(),videoQueueMaxBytes:this.videoQueueMaxBytes,adaptiveVideoQueueMaxBytes:this.effectiveVideoQueueMaxBytes(),lastChunkDecodeMs:this.lastChunkDecodeMs??0,pooledVideoFrames:this.pooledVideoFrames??0,memoryApiAvailable:this.memoryApiAvailable,jsHeapUsedBytes:this.lastMemorySample?.usedJSHeapSize??null,jsHeapLimitBytes:this.lastMemorySample?.jsHeapSizeLimit??null,jsHeapAvailableBytes:this.lastMemorySample?Math.max(0,this.lastMemorySample.jsHeapSizeLimit-this.lastMemorySample.usedJSHeapSize):null,memoryBufferAdjustmentCount:(this.memoryAdjustmentLog??[]).length,memoryBufferAdjustments:this.memoryAdjustmentLog??[],bufferingEventCount:this.bufferingEventCount??0,bufferingTotalMs:Math.round((this.bufferingTotalMs??0)+(this.bufferingStartedAtMs!==undefined?performance.now()-this.bufferingStartedAtMs:0))}; }
  private publishDiagnostics(){this.callbacks.diagnostics?.(this.getDiagnostics());}
  get audioLevelsEnabled():boolean { return this.audioLevelsOn; }
  /**
   * Measurement is opt-in and stoppable because it is pure overhead for a host that shows no meter:
   * disabled, the timer does not exist and no sample is ever read.
   */
  setAudioLevelsEnabled(enabled:boolean):void {
    if(this.audioLevelsOn===enabled)return;
    this.audioLevelsOn=enabled;
    if(enabled)this.startAudioLevelSampling(); else this.stopAudioLevelSampling();
  }
  /** Latest measurement, or null while measurement is off. Measures on demand before the first tick. */
  getAudioLevels():AudioLevels|null { return this.audioLevelsOn?this.lastAudioLevels??this.measureAudioLevels():null; }
  private startAudioLevelSampling():void {
    if(this.audioLevelTimer!==undefined||this.destroyed)return;
    // The handle is only ever passed back to clearInterval, and its type differs between the DOM and
    // Node typings this package is compiled against; a number is what both accept.
    this.audioLevelTimer=setInterval(()=>this.sampleAudioLevels(),this.audioLevelIntervalMs) as unknown as number;
  }
  private stopAudioLevelSampling():void {
    if(this.audioLevelTimer===undefined)return;
    clearInterval(this.audioLevelTimer);this.audioLevelTimer=undefined;this.lastAudioLevels=undefined;
  }
  private sampleAudioLevels():void {
    if(!this.audioLevelsOn||this.destroyed)return;
    const levels=this.measureAudioLevels();
    this.lastAudioLevels=levels;
    this.callbacks.audioLevels?.(levels);
  }
  /**
   * Measured from the decoded PCM at the playhead rather than from an AnalyserNode on the output.
   * An analyser would need a tap in the audio graph, which is the one part of this player that
   * playback timing depends on, and it would read nothing at all in the legacy path. The window
   * starts at the playhead and runs forward: frames behind it are evicted within ~100 ms, so a
   * backwards window would race the eviction it is meant to describe.
   *
   * Only the first two channels are measured, whatever the file carries.
   */
  private measureAudioLevels():AudioLevels {
    const windowSeconds=this.audioLevelIntervalMs/1000,time=this.currentTime;
    if(this.status!=="playing"||this.audioPlaybackRate()===0)return silentAudioLevels(time,windowSeconds);
    const accumulator=createAudioLevelAccumulator(),from=time,to=Math.min(this.durationValue,time+windowSeconds);
    if(this.mode==="streaming"){
      if(!this.streamingAudioSupported)return silentAudioLevels(time,windowSeconds);
      for(const chunk of this.audioChunks??[]){
        if(chunk.mediaEndTime<=from||chunk.mediaStartTime>=to)continue;
        const buffer=chunk.buffer as unknown as AudioLevelBufferLike,sampleRate=buffer.sampleRate??this.audioSampleRate??48000;
        accumulateAudioLevels(accumulator,buffer,(Math.max(from,chunk.mediaStartTime)-chunk.mediaStartTime)*sampleRate,(Math.min(to,chunk.mediaEndTime)-chunk.mediaStartTime)*sampleRate);
      }
    } else if(this.audioBuffer){
      const buffer=this.audioBuffer as unknown as AudioLevelBufferLike,sampleRate=buffer.sampleRate??this.audioSampleRate??48000;
      accumulateAudioLevels(accumulator,buffer,from*sampleRate,to*sampleRate);
    }
    return accumulator.samples?finalizeAudioLevels(accumulator,time,windowSeconds):silentAudioLevels(time,windowSeconds);
  }
  /** Undefined on Firefox/Safari, or if a future spec change drops the fields this reads. */
  private getMemorySample():{usedJSHeapSize:number;totalJSHeapSize:number;jsHeapSizeLimit:number}|undefined {
    const mem=(performance as unknown as {memory?:{usedJSHeapSize?:number;totalJSHeapSize?:number;jsHeapSizeLimit?:number}}).memory;
    if(!mem||typeof mem.usedJSHeapSize!=="number"||typeof mem.jsHeapSizeLimit!=="number")return undefined;
    return {usedJSHeapSize:mem.usedJSHeapSize,totalJSHeapSize:mem.totalJSHeapSize??mem.usedJSHeapSize,jsHeapSizeLimit:mem.jsHeapSizeLimit};
  }
  private startMemoryMonitor():void {
    if(this.memoryCheckTimer!==undefined||this.destroyed)return;
    this.memoryCheckTimer=setInterval(()=>this.checkMemoryPressure(),this.memoryCheckIntervalMs) as unknown as number;
  }
  private stopMemoryMonitor():void {
    if(this.memoryCheckTimer===undefined)return;
    clearInterval(this.memoryCheckTimer);this.memoryCheckTimer=undefined;
  }
  /**
   * One step of hysteresis toward whichever side the used/heap ratio sits on: shrink every ceiling
   * while usage stays at or above the high-water ratio, grow every ceiling back toward its configured
   * target while it stays at or below the low-water ratio, and hold between the two so a ratio that
   * hovers near one threshold does not oscillate the buffer every check. `publish` is false for the
   * check `load()` runs before the initial fill, whose own diagnostics publish follows shortly after.
   */
  private checkMemoryPressure(publish=true):void {
    if(!this.memoryAdaptiveBufferEnabled)return;
    const sample=this.getMemorySample();
    if(!sample)return;
    this.lastMemorySample=sample;
    const usedRatio=sample.jsHeapSizeLimit>0?sample.usedJSHeapSize/sample.jsHeapSizeLimit:0;
    const previousAhead=this.memoryVideoAheadCeiling,previousBytes=this.memoryVideoQueueMaxBytesCeiling,previousRetain=this.memoryRetainBehindCeiling;
    if(usedRatio>=this.memoryHighWaterRatio){
      this.memoryVideoAheadCeiling=Math.max(this.minVideoAheadSeconds,this.memoryVideoAheadCeiling*this.memoryShrinkFactor);
      this.memoryVideoQueueMaxBytesCeiling=Math.max(this.minVideoQueueMaxBytes,Math.round(this.memoryVideoQueueMaxBytesCeiling*this.memoryShrinkFactor));
      this.memoryRetainBehindCeiling=Math.max(this.minRetainBehindSeconds,this.memoryRetainBehindCeiling*this.memoryShrinkFactor);
    } else if(usedRatio<=this.memoryLowWaterRatio){
      this.memoryVideoAheadCeiling=Math.min(this.videoAheadSeconds,this.memoryVideoAheadCeiling*this.memoryGrowFactor);
      this.memoryVideoQueueMaxBytesCeiling=Math.min(this.videoQueueMaxBytes,Math.round(this.memoryVideoQueueMaxBytesCeiling*this.memoryGrowFactor));
      this.memoryRetainBehindCeiling=Math.min(this.retainBehindSeconds,this.memoryRetainBehindCeiling*this.memoryGrowFactor);
    }
    const changed=previousAhead!==this.memoryVideoAheadCeiling||previousBytes!==this.memoryVideoQueueMaxBytesCeiling||previousRetain!==this.memoryRetainBehindCeiling;
    if(changed){
      const direction=this.memoryVideoAheadCeiling<previousAhead||this.memoryVideoQueueMaxBytesCeiling<previousBytes?"decreased":"increased";
      const entry:MemoryBufferAdjustment={atMs:Date.now(),direction,videoAheadSeconds:this.memoryVideoAheadCeiling,videoQueueMaxBytes:this.memoryVideoQueueMaxBytesCeiling,retainBehindSeconds:this.memoryRetainBehindCeiling,usedJSHeapSize:sample.usedJSHeapSize,jsHeapSizeLimit:sample.jsHeapSizeLimit};
      this.memoryAdjustmentLog.push(entry);
      if(this.memoryAdjustmentLog.length>20)this.memoryAdjustmentLog.shift();
      console.info("[H422Player] memory-adaptive buffer",entry);
    }
    if(publish)this.publishDiagnostics();
  }
  /** How far behind the playhead played frames are kept before eviction; shrinks first under memory pressure. */
  private effectiveRetainBehindSeconds():number { return Math.min(this.retainBehindSeconds,this.memoryRetainBehindCeiling??Infinity); }
  private getVideoDecoder():VideoDecoderClient { return this.videoDecoderClient??=this.dependencies.createVideoDecoder(); }
  /**
   * Frames the playhead has passed are handed back to the Worker's pool with the next decode, which
   * is where their buffers get reused. Staging is capped at roughly one chunk because that is all
   * the pool will accept; anything past that is left to the collector instead of held here.
   */
  private stageForRecycling(frames:RenderFrame[]):void {
    if(this.mode!=="streaming"||!frames.length)return;
    const staged=this.recyclableBuffers??=[],limit=Math.max(16,Math.ceil((this.chunkSeconds??3)*(this.essenceIndex?.frameRate??XDCAM_FRAME_RATE))*3);
    for(const item of frames)if(staged.length<limit)staged.push(...renderFrameBuffers(item.frame));
  }
  private takeRecyclableBuffers():ArrayBuffer[] { return (this.recyclableBuffers??=[]).splice(0); }
  private clearFrames():void { this.stageForRecycling(this.frames); this.frames=[]; }
  private evictFramesBefore(time:number):void { const keep:RenderFrame[]=[],drop:RenderFrame[]=[];for(const item of this.frames)(item.time>=time?keep:drop).push(item);this.frames=keep;this.stageForRecycling(drop); }
  private evictFramesAfter(time:number):void { const keep:RenderFrame[]=[],drop:RenderFrame[]=[];for(const item of this.frames)(item.time<=time?keep:drop).push(item);this.frames=keep;this.stageForRecycling(drop); }
  /**
   * The seconds target and the byte budget are both ceilings on the queue; whichever binds first
   * wins. Seconds alone let 1080-line 4:2:2 reach well over a gigabyte at the 9 s the adaptive
   * sizing settles on.
   */
  private aheadSecondsTarget():number {
    const fps=this.essenceIndex?.frameRate??XDCAM_FRAME_RATE;
    // The memory-adaptive ceiling defaults to Infinity when unset (bypass-constructed test doubles,
    // or the feature disabled), leaving the decode-speed-adaptive target as the only ceiling.
    const ceilingSeconds=Math.min(this.adaptiveVideoAheadSeconds,this.memoryVideoAheadCeiling??Infinity);
    const minAheadSeconds=this.minVideoAheadSeconds??0;
    if(this.frameBytes<=0)return Math.max(minAheadSeconds,ceilingSeconds);
    // A refill decision always adds a whole chunk, so the target has to leave room for one.
    // Without that the queue lands a chunk past the budget every time it tops up.
    const chunkFrames=Math.ceil((this.chunkSeconds??3)*fps);
    // The floor is measured against the host's own ceiling, not the memory-shrunk one: a deliberately
    // tiny `videoQueueMaxBytes` still wins (see "still asks for one frame..."), but memory pressure
    // alone must never collapse the look-ahead below the configured floor - that is the exact
    // short-buffer stutter this floor exists to prevent.
    const hostBudgetFrames=Math.floor(this.videoQueueMaxBytes/this.frameBytes),floorSeconds=Math.min(minAheadSeconds,Math.max(1,hostBudgetFrames-chunkFrames)/fps);
    const effectiveMaxBytes=Math.min(this.videoQueueMaxBytes,this.memoryVideoQueueMaxBytesCeiling??Infinity),budgetFrames=Math.floor(effectiveMaxBytes/this.frameBytes);
    return Math.max(floorSeconds,Math.min(ceilingSeconds,Math.max(1,budgetFrames-chunkFrames)/fps));
  }
  /** The byte ceiling currently in effect: the host's hard cap, tightened by memory pressure if any. */
  private effectiveVideoQueueMaxBytes():number { return Math.min(this.videoQueueMaxBytes,this.memoryVideoQueueMaxBytesCeiling??Infinity); }
  private refillThresholdTarget():number { return Math.min(this.adaptiveRefillThresholdSeconds,Math.max(.25,this.aheadSecondsTarget()-.25)); }
  private videoQueueBytes():number { return this.frames.length*this.frameBytes; }
  /**
   * Which frames a refill decodes. Reverse is always decimated: MPEG-2 Long-GOP has no backwards
   * decode, so playing a GOP in reverse means decoding it forwards and discarding most of it.
   */
  private frameSelection():"all-frames"|"key-frames" {
    const rate=this.playbackRateValue??1;
    return rate<0||Math.abs(rate)>(this.fullDecodeMaxRate??DEFAULT_FULL_DECODE_MAX_RATE)?"key-frames":"all-frames";
  }
  private isReverse():boolean { return (this.playbackRateValue??1)<0; }
  /**
   * Audio only follows the video clock while it can be played straight through. Above the
   * full-decode rate the video is decimated, so there is no continuous timeline to play against,
   * and reverse audio has no useful meaning here. Both mute.
   */
  private audioPlaybackRate():number { const rate=this.playbackRateValue??1; return rate>0&&rate<=(this.fullDecodeMaxRate??DEFAULT_FULL_DECODE_MAX_RATE)?rate:0; }
  private adaptStreamingBuffer(processMs:number,inputFrames:number,frameRate:number):void { this.lastChunkDecodeMs=processMs;if(inputFrames<1)return;const processSeconds=processMs/1000,mediaSeconds=inputFrames/frameRate,maxAhead=Math.max(this.videoAheadSeconds,this.chunkSeconds*3);if(mediaSeconds<=0)return;const desired=this.chunkSeconds+processSeconds*2+.5;this.adaptiveVideoAheadSeconds=Math.min(maxAhead,Math.max(this.videoAheadSeconds,Math.ceil(desired/this.chunkSeconds)*this.chunkSeconds));this.adaptiveRefillThresholdSeconds=Math.min(this.adaptiveVideoAheadSeconds-.25,Math.max(this.refillThresholdSeconds,processSeconds*1.75+.75)); }
  private destroyReader(reader?:RandomAccessReader & {destroy():void}){if(!reader)return;const destroyed=this.destroyedReaders??=new WeakSet<object>();if(destroyed.has(reader))return;destroyed.add(reader);reader.destroy();}
  private releaseReader(expected?:RandomAccessReader & {destroy():void}){const reader=expected??this.reader;if(!reader)return;if(this.reader===reader)this.reader=undefined;this.destroyReader(reader);}
  private abortFill(){this.fillController?.abort();this.fillController=undefined;this.filling=undefined;this.audioFillController?.abort();this.audioFillController=undefined;this.audioFilling=undefined;this.videoPrefetch=undefined;}
  private setBuffering(value:boolean){
    if(this.buffering===value)return;
    this.buffering=value;
    // Counted from setBuffering rather than setStatus("buffering") so it only reflects a stall during
    // playback: the initial fill in load() never calls setBuffering, and a paused/seek wait is not a
    // stall either.
    if(value){this.bufferingEventCount++;this.bufferingStartedAtMs=performance.now();}
    else if(this.bufferingStartedAtMs!==undefined){this.bufferingTotalMs+=performance.now()-this.bufferingStartedAtMs;this.bufferingStartedAtMs=undefined;}
    this.callbacks.buffering?.(value);this.emitState();
  }
  /** How much media is queued in the direction of travel. */
  private bufferedAhead(t:number):number { return this.isReverse()?t-(this.frames[0]?.time??t):(this.frames.at(-1)?.time??t)-t; }
  /** Reverse runs out at the head of the media, not at its tail. */
  private fillExhausted(){ return this.isReverse()?(this.keyFrameCoverage?.from??1)<=0:this.streamExhausted(); }
  private streamExhausted(){const videos=this.essenceIndex?.packets.filter(packet=>packet.kind==="video");const last=videos?.at(-1);return Boolean(last&&this.queuedThroughFrame>=last.editUnit);}
  /**
   * An empty queue is running dry, not reaching the end. Defaulting the last frame's time to 0 made
   * any exhausted-and-drained queue read as "at the end", which cut decimated playback short the
   * moment a refill fell behind.
   */
  private streamAtEnd(t:number){
    if(!this.streamExhausted()||!this.essenceIndex)return false;
    const endOfMedia=this.durationValue-1/this.essenceIndex.frameRate,lastTime=this.frames.at(-1)?.time;
    return lastTime===undefined?t>=endOfMedia:t>=Math.min(lastTime,endOfMedia);
  }
  /** Reverse has no "ended": running back past frame 0 parks the playhead at the head, paused. */
  private finishReachedStart(){
    if(this.status==="paused")return;
    this.pausedAt=0;this.drawAt(0);this.emitTime(0);
    cancelAnimationFrame(this.raf);this.raf=0;this.resumeAfterBuffer=false;this.setBuffering(false);
    this.stopAudioSource();void this.audio?.suspend();this.setStatus("paused");
  }
  private finishEnded(){if(this.status==="ended")return;const last=this.frames.at(-1);if(last)this.drawFrame(last.frame);this.pausedAt=this.durationValue;this.emitTime(this.durationValue);cancelAnimationFrame(this.raf);this.raf=0;this.resumeAfterBuffer=false;this.setBuffering(false);this.stopAudioSource();void this.audio?.suspend();this.setStatus("ended");}
  private failStreaming(error:Error){this.abortFill();this.invalidateStreamingVideoDecoder();cancelAnimationFrame(this.raf);this.raf=0;this.resumeAfterBuffer=false;this.setBuffering(false);this.stopAudioSource();void this.audio?.suspend();this.clearFrames();this.releaseReader();this.setStatus("error");this.callbacks.error(error);}
  async load(source: File|Blob|string): Promise<void> {
    this.videoDecodedFrames=0;this.videoDecodeMs=0;this.videoColorConvertMs=0;this.videoUploadMs=0;this.lastChunkDecodeMs=0;this.frameBytes=0;this.adaptiveVideoAheadSeconds=this.videoAheadSeconds;this.adaptiveRefillThresholdSeconds=this.refillThresholdSeconds;this.clearFrames();this.stopAudioSource();this.invalidateStreamingVideoDecoder();const previousAudio=this.audio;this.audio=undefined;if(previousAudio)await previousAudio.close();this.audioBuffer=undefined;this.streamingAudioSupported=false;this.audioFormatBasis=null;this.selectedAudioTrackNumber=undefined;this.audioSampleRate=undefined;this.audioChannels=undefined;this.audioChunks=[];this.scheduledAudio=[];this.audioBytesLoaded=0;this.audioQueuedThroughTime=0;this.audioExhausted=false;this.lastAudioTime=0;this.audioMediaAnchor=undefined;this.audioContextAnchor=undefined;this.lastAudioLevels=undefined; this.abortFill();this.setBuffering(false);this.setSeeking(false); this.releaseReader(); this.seekController?.abort(); this.seekGeneration++;
    this.bufferingEventCount=0;this.bufferingTotalMs=0;this.bufferingStartedAtMs=undefined;this.memoryAdjustmentLog=[];
    this.loadController?.abort(); const controller=new AbortController(); this.loadController=controller; const {signal}=controller, generation=++this.loadGeneration;
    const current=()=>!signal.aborted&&!this.destroyed&&this.loadGeneration===generation;
    this.setStatus("loading");
    console.info("[H422Player] load:start", { generation, mode:this.mode, source:typeof source === "string" ? source : source instanceof File ? source.name : "Blob" });
    let localReader:(RandomAccessReader & {destroy():void})|undefined;try {
      const blob=typeof source === "string" ? await fetch(source,{signal}).then(r=>{if(!r.ok)throw new Error(`MXF request failed (${r.status})`);return r.blob();}) : source; this.fileSize=blob.size;
      console.info("[H422Player] load:source-ready", { generation, mode:this.mode, fileSize:blob.size, type:blob.type||"(empty)" });
      if(!current())return;
      const reader=this.dependencies.createReader(blob);localReader=reader;if(this.mode==="streaming")this.reader=reader;
      console.info("[H422Player] metadata:start", { generation, readerSize:String(reader.size) });
      let metadata;
      try { metadata=await this.dependencies.parseMetadata(reader,signal); console.info("[H422Player] metadata:complete", { generation, partitions:metadata.partitions.map(item=>({offset:String(item.offset),kind:item.kind,bodySid:item.bodySid,indexSid:item.indexSid})), operationalPattern:metadata.mediaInfo.operationalPattern??null, essenceContainer:metadata.mediaInfo.essenceContainer??null, video:metadata.mediaInfo.video??null, audio:metadata.mediaInfo.audio??null, indexTables:metadata.indexTables.length, timecodeTracks:metadata.timecodes.length }); }
      finally { if(this.mode!=="streaming"||!current())this.destroyReader(reader); }
      if(!current())return;
      const timecodeInfo=selectTimecodeTrack(metadata.timecodes);
      metadata.mediaInfo.selectedTimecode=timecodeInfo;
      this.timecodeSelectionReason=timecodeInfo?"Package参照解析は未対応のためKLV検出順で選択":"Timecode Trackなし"; metadata.mediaInfo.timecodeSelectionReason=this.timecodeSelectionReason;
      if(this.mode==="streaming") {
        console.info("[H422Player] streaming:validate-metadata", { generation, partitionCount:metadata.partitions.length });
        if(!metadata.partitions.length)throw new Error("Streaming could not locate an MXF Partition Pack within the bounded prologue scan");
        if(metadata.mediaInfo.operationalPattern!=="OP1a")throw new Error("Streaming requires OP1a operational-pattern metadata");
        const descriptor=metadata.mediaInfo.video;if(!descriptor?.width||!descriptor.height||!metadata.mediaInfo.essenceContainer)throw new Error("Streaming requires an identifiable XDCAM HD422 picture and Essence Container descriptor");
        if(!([[1920,1080],[1280,720]] as const).some(([width,height])=>descriptor.width===width&&descriptor.height===height))throw new Error(`Streaming does not support the ${descriptor.width}x${descriptor.height} picture descriptor`);
        this.reader=reader; console.info("[H422Player] streaming:index:start", { generation }); const frameRate=metadata.mediaInfo.editRateNumerator&&metadata.mediaInfo.editRateDenominator?metadata.mediaInfo.editRateNumerator/metadata.mediaInfo.editRateDenominator:XDCAM_FRAME_RATE;
        this.indexTables=metadata.indexTables; this.essenceIndex=await this.dependencies.indexEssence(reader,{partitions:metadata.partitions,indexTables:metadata.indexTables,frameRate,signal}); console.info("[H422Player] streaming:index:complete", { generation, packets:this.essenceIndex.packets.length, videoPackets:this.essenceIndex.packets.filter(packet=>packet.kind==="video").length, audioPackets:this.essenceIndex.packets.filter(packet=>packet.kind==="audio").length, frameRate }); if(!current())return;
        if(!this.essenceIndex.packets.some(packet=>packet.kind==="video"))throw new Error("Streaming requires MPEG-2 video essence");
        console.info("[H422Player] streaming:libav:start", { generation, base:this.libavBase }); await this.getVideoDecoder().init(this.libavBase);console.info("[H422Player] streaming:libav:complete", { generation });if(!current())return;
        this.timecodeInfo=timecodeInfo;this.durationValue=(metadata.mediaInfo.durationFrames??this.essenceIndex.packets.filter(p=>p.kind==="video").length)/frameRate;this.frames=[];this.queuedThroughFrame=-1;
        this.configureStreamingAudio(metadata.mediaInfo);
        // Reads current memory pressure once before deciding the initial buffer target: on a machine
        // already under pressure before any file was chosen, waiting for the first periodic check
        // would size the initial fill for a machine that is not the one actually running.
        this.checkMemoryPressure(false);
        console.info("[H422Player] streaming:initial-fill:start", { generation, targetSeconds:this.aheadSecondsTarget() }); const initialFill=new AbortController();this.fillController=initialFill;await this.fillInitialStreamingBuffer(initialFill.signal,generation,this.seekGeneration);if(this.fillController===initialFill)this.fillController=undefined;if(!current())return;const first=this.frames[0];if(!first)throw new Error("The MPEG-2 decoder returned no frames");
        this.drawFrame(first.frame);this.callbacks.mediaInfo?.(metadata.mediaInfo);this.callbacks.timecode?.(timecodeInfo?timecodeAtSeconds(timecodeInfo,0):null);this.callbacks.ready({width:first.frame.width,height:first.frame.height,frameRate,duration:this.durationValue,audioSampleRate:this.audioSampleRate??48000,audioChannels:this.streamingAudioSupported?this.audioChannels!:0});this.setStatus("ready");this.emitPlaybackRate();this.publishDiagnostics();this.requestFill(0);this.requestAudioFill(0);console.info("[H422Player] streaming:ready", { generation, duration:this.durationValue, frames:this.frames.length, diagnostics:this.getDiagnostics() });return;
      }
      // Compatibility path intentionally retains contiguous full-file decoding.
      const bytes=await this.dependencies.readWhole(blob);
      if(!current())return;
      const parsed=this.dependencies.parse(bytes);
      console.info(`[H422Player] video codec_id=${parsed.videoCodec.codecId} codec_name=${parsed.videoCodec.codecName}`);
      if (parsed.audioCodec) console.info(`[H422Player] audio codec_id=${parsed.audioCodec.codecId} codec_name=${parsed.audioCodec.codecName}`);
      await this.getVideoDecoder().init(this.libavBase); if(!current())return;
      const video=parsed.packets.filter(p=>p.kind==="video"); const audio=parsed.packets.filter(p=>p.kind==="audio");
      const frames=await this.decodeVideo(video.map(p=>p.data), parsed.videoCodec.codecId); if(!current())return;
      const prepared=audio.length&&!this.muted ? await this.preparePcm(audio.map(p=>p.data)) : undefined;
      if(!current()){if(prepared)void prepared.audio.close();return;}
      const duration=frames.length/XDCAM_FRAME_RATE, first=frames[0]; if (!first) { if(prepared)void prepared.audio.close(); throw new Error("The MPEG-2 decoder returned no frames"); }
      this.frames=frames;this.timecodeInfo=timecodeInfo;this.durationValue=duration;
      if(prepared){this.audio=prepared.audio;this.audioBuffer=prepared.audioBuffer;}
      this.drawFrame(first.frame);
      this.callbacks.mediaInfo?.(metadata.mediaInfo);this.callbacks.timecode?.(timecodeInfo ? timecodeAtSeconds(timecodeInfo,0) : null);
      this.callbacks.ready({width:first.frame.width,height:first.frame.height,frameRate:XDCAM_FRAME_RATE,duration,audioSampleRate:48000,audioChannels:audio.length?2:0});
      this.setStatus("ready");this.emitPlaybackRate();
    } catch (e) { const error=e instanceof Error?e:new Error(String(e));this.invalidateStreamingVideoDecoder(); if(error.name!=="AbortError"&&current()){this.publishDiagnostics();console.error("[H422Player] load:failed", { generation, mode:this.mode, stageStatus:this.status, error, diagnostics:this.getDiagnostics() });} if(localReader)this.releaseReader(localReader); if(error.name==="AbortError"||!current())return; this.setStatus("error"); this.callbacks.error(error); throw error; }
  }
  private async fillStreaming(targetFrame:number,signal:AbortSignal,loadGeneration:number,seekGeneration=this.seekGeneration,decodeStartFrame?:number):Promise<boolean>{
    if(!this.reader||!this.essenceIndex)return false;
    const current=()=>!signal.aborted&&!this.destroyed&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration;
    const fps=this.essenceIndex.frameRate,target=Math.max(0,Math.trunc(targetFrame));
    const canContinue=decodeStartFrame===undefined&&target===this.queuedThroughFrame+1&&this.streamingDecoderGeneration?.loadGeneration===loadGeneration&&this.streamingDecoderGeneration?.seekGeneration===seekGeneration;
    const decodeStart=canContinue?target:decodeStartFrame??essenceDecodeStart(this.essenceIndex,target);
    const end=Math.min(Math.ceil(this.durationValue*fps)-1,target+Math.ceil(this.chunkSeconds*fps)-1);
    if(end<=this.queuedThroughFrame&&target>=0)return current();
    const prefetch=this.videoPrefetch;
    const reusablePrefetch=prefetch&&prefetch.loadGeneration===loadGeneration&&prefetch.seekGeneration===seekGeneration&&prefetch.startFrame===decodeStart&&prefetch.endFrame===end?prefetch.promise:undefined;
    this.videoPrefetch=undefined;
    const packets=await (reusablePrefetch??this.dependencies.readRange(this.reader,this.essenceIndex,{startFrame:decodeStart,endFrame:end,prerollFrames:0,signal,maxReadSize:this.maxReadSize,kinds:["video"]}));
    if(!current())return false;
    const video=packets.filter(packet=>packet.kind==="video");
    if(decodeStart===0){const first=video[0]?.data;let sequence=false;if(first)for(let i=0;i+3<Math.min(first.length,256);i++)if(first[i]===0&&first[i+1]===0&&first[i+2]===1&&first[i+3]===0xb3){sequence=true;break;}if(!sequence)throw new Error("Streaming requires XDCAM HD422 MPEG-2 sequence-header essence");}
    const finalChunk=end>=Math.ceil(this.durationValue*fps)-1;
    if(!finalChunk&&this.reader&&this.essenceIndex){
      const nextStart=end+1,nextEnd=Math.min(Math.ceil(this.durationValue*fps)-1,nextStart+Math.ceil(this.chunkSeconds*fps)-1);
      if(nextStart<=nextEnd){
        const prefetchPromise=this.dependencies.readRange(this.reader,this.essenceIndex,{startFrame:nextStart,endFrame:nextEnd,prerollFrames:0,signal,maxReadSize:this.maxReadSize,kinds:["video"]});
        prefetchPromise.catch(()=>undefined);
        this.videoPrefetch={startFrame:nextStart,endFrame:nextEnd,loadGeneration,seekGeneration,promise:prefetchPromise};
      }
    }
    const decoded=await this.decodeStreamingVideo(video.map(packet=>packet.data),video.map(packet=>packet.editUnit),fps,finalChunk,loadGeneration,seekGeneration);
    if(!current())return false;
    const positioned=decoded.map((item,index)=>item.mediaFrame===undefined?{...item,mediaFrame:video[index]?.editUnit??decodeStart+index,time:(video[index]?.editUnit??decodeStart+index)/fps}:item);
    const wanted=positioned.filter(item=>(canContinue||item.mediaFrame>=target)&&item.mediaFrame<=end);
    const existing=new Set(this.frames.map(frame=>frame.mediaFrame));
    for(const item of wanted)if(!existing.has(item.mediaFrame))this.frames.push(item);
    this.frames.sort((a,b)=>a.mediaFrame-b.mediaFrame);this.queuedThroughFrame=Math.max(this.queuedThroughFrame,end);this.publishDiagnostics();return true;
  }
  /**
   * Decodes only the random-access frames covering the look-ahead, which is what makes 2x, 4x and
   * every reverse rate possible at all: an XDCAM GOP is 12-15 frames, so this is roughly an order
   * of magnitude less decode work than playing every frame. Each key frame carries its own sequence
   * header, so the batch is flushed as a self-contained decode rather than continuing a stream.
   */
  private async fillKeyFrames(anchorFrame:number,signal:AbortSignal,loadGeneration:number,seekGeneration:number):Promise<boolean>{
    if(!this.reader||!this.essenceIndex)return false;
    const current=()=>!signal.aborted&&!this.destroyed&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration;
    const fps=this.essenceIndex.frameRate,last=Math.max(0,Math.ceil(this.durationValue*fps)-1);
    const span=Math.max(1,Math.ceil(this.aheadSecondsTarget()*fps));
    const anchor=Math.min(last,Math.max(0,Math.trunc(anchorFrame)));
    const startFrame=this.isReverse()?Math.max(0,anchor-span):anchor,endFrame=this.isReverse()?anchor:Math.min(last,anchor+span);
    if(endFrame<startFrame)return current();
    const packets=await this.dependencies.readRange(this.reader,this.essenceIndex,{startFrame,endFrame,prerollFrames:0,signal,maxReadSize:this.maxReadSize,kinds:["video"]});
    if(!current())return false;
    const keys=packets.filter(packet=>packet.kind==="video"&&isRandomAccessVideoPacket(packet));
    if(!keys.length)throw new Error(`No random access point is indexed between frames ${startFrame} and ${endFrame}; this material cannot be played at a decimated rate`);
    const decoded=await this.decodeStreamingVideo(keys.map(packet=>packet.data),keys.map(packet=>packet.editUnit),fps,true,loadGeneration,seekGeneration);
    if(!current())return false;
    const existing=new Set(this.frames.map(frame=>frame.mediaFrame));
    for(const item of decoded)if(!existing.has(item.mediaFrame))this.frames.push(item);
    this.frames.sort((a,b)=>a.mediaFrame-b.mediaFrame);
    this.keyFrameCoverage=this.isReverse()?{from:startFrame,to:Math.max(this.keyFrameCoverage?.to??endFrame,endFrame)}:{from:Math.min(this.keyFrameCoverage?.from??startFrame,startFrame),to:endFrame};
    this.queuedThroughFrame=Math.max(this.queuedThroughFrame,endFrame);
    this.publishDiagnostics();return true;
  }
  private async fillInitialStreamingBuffer(signal:AbortSignal,loadGeneration:number,seekGeneration:number):Promise<void>{
    if(!this.essenceIndex)return;
    const current=()=>!signal.aborted&&!this.destroyed&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration;
    const fps=this.essenceIndex.frameRate;
    let videoStart=0,audioStart=0;
    const videoBufferedSeconds=()=>this.frames.at(-1)?.time??-1/fps;
    const target=()=>Math.min(this.durationValue,this.aheadSecondsTarget());
    while(current()&&(videoBufferedSeconds()<target()||this.streamingAudioSupported&&!this.audioExhausted&&this.audioQueuedThroughTime<target())){
      const previousVideo=this.queuedThroughFrame,previousAudio=this.audioQueuedThroughTime;
      const jobs:Promise<boolean>[]=[];
      if(videoBufferedSeconds()<target()){videoStart=Math.max(videoStart,this.queuedThroughFrame+1);jobs.push(this.fillStreaming(videoStart,signal,loadGeneration,seekGeneration));}
      if(this.streamingAudioSupported&&!this.audioExhausted&&this.audioQueuedThroughTime<target()){audioStart=Math.max(audioStart,this.audioQueuedThroughTime);jobs.push(this.fillStreamingAudio(audioStart,signal,loadGeneration,seekGeneration));}
      if(!jobs.length)break;
      await Promise.all(jobs);
      if(this.queuedThroughFrame===previousVideo&&this.audioQueuedThroughTime===previousAudio)break;
    }
    if(current()&&videoBufferedSeconds()<target()-1/fps)throw new Error("The MPEG-2 decoder did not produce the requested initial buffer");
  }
  private requestFill(t:number,force=false){if(this.mode!=="streaming"||!this.essenceIndex||this.filling||this.fillExhausted())return;const fps=this.essenceIndex.frameRate,ahead=this.bufferedAhead(t);if(!force&&ahead>=this.refillThresholdTarget())return;const controller=new AbortController();this.fillController=controller;const loadGeneration=this.loadGeneration,seekGeneration=this.seekGeneration;
    const keyFrames=this.frameSelection()==="key-frames";
    // Forward all-frames continues from the queued edge; every other mode works out from the playhead.
    const start=keyFrames?(this.isReverse()?Math.floor((this.keyFrameCoverage?.from??Math.floor(t*fps))):Math.max(Math.floor(t*fps),(this.keyFrameCoverage?.to??-1)+1)):Math.max(Math.floor(t*fps),this.queuedThroughFrame+1);
    const promise=(keyFrames?this.fillKeyFrames(start,controller.signal,loadGeneration,seekGeneration):this.fillStreaming(start,controller.signal,loadGeneration,seekGeneration)).then(applied=>{if(!applied||controller.signal.aborted||this.filling!==promise)return;const remaining=this.bufferedAhead(t);if(remaining<this.aheadSecondsTarget()&&!this.fillExhausted()){this.filling=undefined;this.fillController=undefined;this.requestFill(t,true);return;}if(this.buffering&&this.streamAtEnd(this.pausedAt)){this.finishEnded();return;}}).catch(e=>{if((e as Error).name!=="AbortError"&&this.filling===promise&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration&&!this.destroyed)this.failStreaming(e instanceof Error?e:new Error(String(e)));}).finally(()=>{if(this.filling===promise){this.filling=undefined;if(this.fillController===controller)this.fillController=undefined;this.tryResumeFromBuffering(loadGeneration,seekGeneration);}});this.filling=promise;}
  private invalidateStreamingVideoDecoder():void{ this.streamingDecoderGeneration=undefined; this.videoDecoderClient?.invalidateStreaming(); }
  private async decodeStreamingVideo(chunks:Uint8Array[],mediaFrames:number[],frameRate:number,flush:boolean,loadGeneration:number,seekGeneration:number):Promise<RenderFrame[]> {
    const maxMediaFrame=Math.ceil(this.durationValue*frameRate);
    const result=await this.getVideoDecoder().decodeStreamingVideo(chunks,mediaFrames,frameRate,flush,loadGeneration,seekGeneration,this.videoCodecId,this.videoRenderMode,maxMediaFrame,this.takeRecyclableBuffers());
    this.pooledVideoFrames=result.pooledFrames;
    // Frames of one stream are all the same size, so the first decoded frame settles the byte budget.
    if(!this.frameBytes&&result.frames[0])this.frameBytes=renderFrameBytes(result.frames[0].frame);
    // A decode started before a seek still runs to completion; its frames are dropped by the caller,
    // so its timings must not steer the adaptive buffer and its decoder must not be marked reusable.
    if(loadGeneration!==this.loadGeneration||seekGeneration!==this.seekGeneration)return result.frames;
    this.videoDecodeMs+=result.decodeMs;this.videoColorConvertMs+=result.convertMs;this.videoDecodedFrames+=result.frames.length;
    this.adaptStreamingBuffer(result.decodeMs+result.convertMs,chunks.length,frameRate);
    this.streamingDecoderGeneration=flush?undefined:{loadGeneration,seekGeneration};
    console.info("[H422Player] video performance",{renderMode:this.videoRenderMode,decoderExecution:"dedicated-worker",inputPackets:chunks.length,decodedFrames:result.frames.length,decodeMs:Number(result.decodeMs.toFixed(1)),colorConvertMs:Number(result.convertMs.toFixed(1)),adaptiveAheadSeconds:Number(this.aheadSecondsTarget().toFixed(2)),adaptiveRefillSeconds:Number(this.refillThresholdTarget().toFixed(2)),queueBytes:this.videoQueueBytes(),totalDecodeMs:Number((this.videoDecodeMs??0).toFixed(1)),totalColorConvertMs:Number((this.videoColorConvertMs??0).toFixed(1))});
    return result.frames;
  }
  private async decodeVideo(chunks: Uint8Array[], codecId: number, mediaFrames:number[]=chunks.map((_,i)=>i), frameRate=XDCAM_FRAME_RATE): Promise<RenderFrame[]> {
    const result=await this.getVideoDecoder().decodeVideo(chunks,codecId,mediaFrames,frameRate,this.videoRenderMode);
    this.videoDecodedFrames+=result.frames.length;this.videoDecodeMs+=result.decodeMs;this.videoColorConvertMs+=result.convertMs;
    console.info("[H422Player] video performance",{renderMode:this.videoRenderMode,inputPackets:chunks.length,decodedFrames:result.frames.length,decodeMs:Number(result.decodeMs.toFixed(1)),colorConvertMs:Number(result.convertMs.toFixed(1)),totalDecodeMs:Number(this.videoDecodeMs.toFixed(1)),totalColorConvertMs:Number(this.videoColorConvertMs.toFixed(1))});
    return result.frames;
  }
  private configureStreamingAudio(info:import("./mxf-metadata").MxfMediaInfo):void {
    this.stopStreamingAudioSources();const oldAudio=this.audio;this.audio=undefined;if(oldAudio)void oldAudio.close();this.audioBuffer=undefined;this.audioChunks=[];this.audioBytesLoaded=0;this.audioQueuedThroughTime=0;this.audioExhausted=false;this.lastAudioTime=0;this.audioMediaAnchor=undefined;this.audioContextAnchor=undefined;this.streamingAudioSupported=false;this.audioFormatBasis=null;this.selectedAudioTrackNumber=undefined;this.audioSampleRate=undefined;this.audioChannels=undefined;
    const tracks=[...new Set(this.essenceIndex?.packets.filter(packet=>packet.kind==="audio").map(packet=>packet.trackNumber)??[])];
    if(!tracks.length){console.info("[H422Player] streaming audio: no audio essence; video-only playback");return;}
    const descriptor=info.audio;
    const codingLooksPcm=!descriptor?.essenceCodingUl||descriptor.essenceCodingUl.startsWith("060e2b340401010104020201");
    if(descriptor?.sampleRate!==48000||descriptor.channels!==2||descriptor.bitsPerSample!==24||descriptor.blockAlign!==undefined&&descriptor.blockAlign!==6||!codingLooksPcm){console.warn(`[H422Player] streaming audio unsupported; video-only playback (requires the XDCAM PCM S24BE profile; descriptor=${descriptor?.sampleRate??"unknown"} Hz/${descriptor?.channels??"unknown"} ch/${descriptor?.bitsPerSample??"unknown"} bit, BlockAlign=${descriptor?.blockAlign??"unknown"}, EssenceCodingUL=${descriptor?.essenceCodingUl??"unknown"})`);return;}
    if(this.muted){console.info("[H422Player] streaming audio disabled because the player is muted");return;}
    this.selectedAudioTrackNumber=tracks[0];const first=this.essenceIndex?.packets.find(packet=>packet.kind==="audio"&&packet.trackNumber===tracks[0]);console.info(`[H422Player] selected audio essence: trackNumber=${tracks[0]} BodySID=${first?.bodySID??"unknown"} editUnit=${first?.editUnit??"unknown"} presentationTime=${first?.presentationTime??"unknown"} valueOffset=${first?.valueOffset?.toString()??"unknown"} valueLength=${first?.valueLength?.toString()??"unknown"}`);this.audioSampleRate=48000;this.audioChannels=2;this.streamingAudioSupported=true;this.audioFormatBasis=descriptor.essenceCodingUl||descriptor.blockAlign!==undefined?"metadata-plus-xdcam-inference":"xdcam-profile-inference";this.audio=new AudioContext({sampleRate:48000});void this.audio.suspend();
    console.info(`[H422Player] streaming audio supported: trackNumber=${tracks[0]} (first stereo track in KLV discovery order), PCM S24BE, 48000 Hz, 2 ch, QuantizationBits=24, BlockAlign=6, byteOrder=big-endian, formatBasis=${this.audioFormatBasis} (signedness/byte order are inferred from the supported XDCAM HD422 OP1a profile when not explicit in metadata)`);
  }
  private async fillStreamingAudio(mediaTime:number,signal:AbortSignal,loadGeneration:number,seekGeneration:number):Promise<boolean>{
    if(!this.streamingAudioSupported||!this.reader||!this.essenceIndex||!this.audio)return true;const current=()=>!signal.aborted&&!this.destroyed&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration;
    const fps=this.essenceIndex.frameRate,startFrame=Math.max(0,Math.floor(mediaTime*fps)),endFrame=Math.min(Math.ceil(this.durationValue*fps)-1,startFrame+Math.ceil(3*fps)-1);
    const packets=await this.dependencies.readRange(this.reader,this.essenceIndex,{startFrame,endFrame,prerollFrames:0,signal,maxReadSize:this.maxReadSize,kinds:["audio"],trackNumbers:[this.selectedAudioTrackNumber!]});if(!current())return false;
    const fresh:StreamingAudioChunk[]=[];let group:typeof packets=[],groupStart=0;const flush=()=>{if(!group.length)return;let bytes=group.reduce((sum,p)=>sum+p.data.length,0),skip=0;const packetStart=group[0].editUnit/fps;if(mediaTime>packetStart)skip=Math.floor((mediaTime-packetStart)*48000)*6;skip=Math.min(bytes,skip-skip%6);bytes-=skip;bytes-=bytes%6;if(bytes<=0){group=[];return;}const joined=new Uint8Array(bytes);let at=0,sourceAt=skip;for(const packet of group){const available=packet.data.length-sourceAt;if(available>0){const take=Math.min(available,bytes-at);joined.set(packet.data.subarray(sourceAt,sourceAt+take),at);at+=take;}sourceAt=0;if(at===bytes)break;}const channels=pcmS24beToFloat32(joined,2),buffer=this.audio!.createBuffer(2,channels[0].length,48000);channels.forEach((samples,index)=>buffer.copyToChannel(new Float32Array(samples),index));const start=Math.max(mediaTime,packetStart),end=Math.min(this.durationValue,start+buffer.duration);fresh.push({mediaStartTime:start,mediaEndTime:end,buffer,generation:seekGeneration,scheduled:false});group=[];};
    for(const packet of packets){if(!group.length)groupStart=packet.presentationTime;group.push(packet);if(packet.presentationTime+1/fps-groupStart>=.75)flush();}flush();if(!current())return false;this.audioBytesLoaded+=packets.reduce((sum,p)=>sum+p.data.length,0);const selectedIndex=this.essenceIndex.packets.filter(packet=>packet.kind==="audio"&&packet.trackNumber===this.selectedAudioTrackNumber),lastPacket=selectedIndex.at(-1);this.audioQueuedThroughTime=Math.max(this.audioQueuedThroughTime,(endFrame+1)/fps);this.lastAudioTime=lastPacket?Math.min(this.durationValue,(lastPacket.editUnit+1)/fps):mediaTime;if(!lastPacket||endFrame>=lastPacket.editUnit)this.audioExhausted=true;const known=new Set(this.audioChunks.map(chunk=>chunk.mediaStartTime.toFixed(6)));for(const chunk of fresh)if(!known.has(chunk.mediaStartTime.toFixed(6)))this.audioChunks.push(chunk);this.audioChunks.sort((a,b)=>a.mediaStartTime-b.mediaStartTime);this.publishDiagnostics();return true;
  }
  private stopStreamingAudioSources():void{for(const range of this.scheduledAudio??[]){try{range.sourceNode.stop();}catch{/* already stopped */}try{range.sourceNode.disconnect();}catch{/* disconnected */}range.ended=true;}this.scheduledAudio=[];for(const chunk of this.audioChunks??[])chunk.scheduled=false;this.audioMediaAnchor=undefined;this.audioContextAnchor=undefined;}
  private scheduleStreamingChunk(chunk:StreamingAudioChunk,mediaTime:number):void{const rate=this.audioPlaybackRate();if(!rate)return;if(!this.audio||this.audioMediaAnchor===undefined||this.audioContextAnchor===undefined||chunk.scheduled||chunk.generation!==this.seekGeneration||chunk.mediaEndTime<=mediaTime||chunk.mediaStartTime>=this.durationValue)return;const start=Math.max(mediaTime,chunk.mediaStartTime),offset=start-chunk.mediaStartTime,end=Math.min(chunk.mediaEndTime,this.durationValue);if(end<=start)return;
    // Media seconds compress into context seconds by the rate; the buffer offsets stay in media time.
    let contextStart=this.audioContextAnchor+(start-this.audioMediaAnchor)/rate;const previous=this.scheduledAudio.at(-1);if(previous){const previousEnd=previous.contextStartTime+(previous.mediaEndTime-previous.mediaStartTime)/rate;if(Math.abs(contextStart-previousEnd)<.002)contextStart=previousEnd;if(contextStart<previousEnd-.002)return;}const node=this.audio.createBufferSource();node.buffer=chunk.buffer;if(rate!==1&&node.playbackRate)node.playbackRate.value=rate;node.connect(this.audio.destination);const range:ScheduledAudio={mediaStartTime:start,mediaEndTime:end,contextStartTime:contextStart,sourceNode:node,generation:this.seekGeneration,started:true,ended:false};node.onended=()=>{range.ended=true;try{node.disconnect();}catch{/* harmless */}};node.start(contextStart,offset,end-start);chunk.scheduled=true;this.scheduledAudio.push(range);}
  private resetAndScheduleStreamingAudio(mediaTime:number):void{if(!this.streamingAudioSupported||!this.audio)return;this.stopStreamingAudioSources();this.audioMediaAnchor=mediaTime;this.audioContextAnchor=this.audio.currentTime+.03;for(const chunk of this.audioChunks)this.scheduleStreamingChunk(chunk,mediaTime);}
  private appendStreamingAudioSchedule():void{if(!this.streamingAudioSupported||this.audioMediaAnchor===undefined)return;for(const chunk of this.audioChunks)this.scheduleStreamingChunk(chunk,this.audioMediaAnchor);}
  /** A muted rate never queues audio, so waiting on the audio queue there would stall forever. */
  private audioReadyAt(time:number):boolean{return !this.streamingAudioSupported||this.audioPlaybackRate()===0||this.audioChunks.some(chunk=>chunk.mediaStartTime<=time+.05&&chunk.mediaEndTime>time)||this.audioExhausted&&time>=this.lastAudioTime-.002;}
  private tryResumeFromBuffering(load=this.loadGeneration,seek=this.seekGeneration):void{if(this.destroyed||this.status==="error"||!this.buffering||!this.resumeAfterBuffer||load!==this.loadGeneration||seek!==this.seekGeneration||this.filling||this.audioFilling)return;if(!this.frames.some(frame=>frame.time>=this.pausedAt)||!this.audioReadyAt(this.pausedAt))return;this.drawAt(this.pausedAt);this.resetAndScheduleStreamingAudio(this.pausedAt);void this.resumeAudioIfAudible();const delay=this.audio&&this.audioContextAnchor!==undefined?Math.max(0,this.audioContextAnchor-this.audio.currentTime)*1000:0;this.anchorPlayback(this.pausedAt,delay);this.setBuffering(false);this.setStatus("playing");this.tick();this.schedulePlaybackCheck();}
  private requestAudioFill(t:number):void{if(!this.streamingAudioSupported||this.audioFilling||this.audioExhausted||this.audioPlaybackRate()===0)return;const end=this.audioChunks?.at(-1)?.mediaEndTime??t;if(end-t>=1.25)return;const controller=new AbortController();this.audioFillController=controller;const load=this.loadGeneration,seek=this.seekGeneration;const promise=this.fillStreamingAudio(end,controller.signal,load,seek).then(applied=>{if(applied&&this.status==="playing")this.appendStreamingAudioSchedule();}).catch(error=>{if((error as Error).name!=="AbortError"&&load===this.loadGeneration&&seek===this.seekGeneration)this.failStreaming(error instanceof Error?error:new Error(String(error)));}).finally(()=>{if(this.audioFilling===promise){this.audioFilling=undefined;this.audioFillController=undefined;this.tryResumeFromBuffering(load,seek);}});this.audioFilling=promise;}
  private async preparePcm(chunks: Uint8Array[]): Promise<{audio:AudioContext;audioBuffer:AudioBuffer}> {
    const audio=new AudioContext({sampleRate:48000});
    const bytes=chunks.reduce((n,c)=>n+c.length,0), joined=new Uint8Array(bytes); let at=0;
    for(const c of chunks){joined.set(c,at);at+=c.length;}
    const channels=pcmS24beToFloat32(joined,2), audioBuffer=audio.createBuffer(2,channels[0].length,48000);
    channels.forEach((samples,index)=>audioBuffer.copyToChannel(new Float32Array(samples),index)); await audio.suspend(); return {audio,audioBuffer};
  }
  /**
   * A muted rate has nothing to hear, and resuming an AudioContext needs a user gesture — waiting on
   * that would make fast and reverse playback refuse to start until the page had been clicked.
   */
  private async resumeAudioIfAudible():Promise<void>{
    if(!this.audio)return;
    if(this.audioPlaybackRate()>0)await this.audio.resume(); else await this.audio.suspend();
  }
  private stopAudioSource():void { this.stopStreamingAudioSources();const source=this.audioSource;this.audioSource=undefined;if(!source)return;try{source.stop();}catch{/* An AudioBufferSourceNode can only be stopped once on some implementations. */}try{source.disconnect();}catch{/* A disconnected node is already harmless. */} }
  private startAudio(offset:number):void { if(!this.audio||!this.audioBuffer)return; this.stopAudioSource(); const node=this.audio.createBufferSource(); node.buffer=this.audioBuffer; node.connect(this.audio.destination); node.start(0,Math.min(offset,this.audioBuffer.duration)); this.audioSource=node; }
  /**
   * Releases everything the playhead has passed. A decoded 1080-line 4:2:2 frame is ~4 MB, so this
   * must not be tied to rAF: a hidden tab stops rAF while the refill timer keeps queueing frames.
   */
  private evictPlayedMedia(t:number):void{
    const retainBehind=this.effectiveRetainBehindSeconds();
    // In reverse the playhead moves down, so the frames behind it are the ones above t.
    if(this.isReverse())this.evictFramesAfter(t+retainBehind); else this.evictFramesBefore(t-retainBehind);
    this.audioChunks=(this.audioChunks??[]).filter(chunk=>chunk.mediaEndTime>=t-.1);
    this.scheduledAudio=(this.scheduledAudio??[]).filter(range=>!range.ended&&range.mediaEndTime>=t-.1);
  }
  /**
   * Everything playback owes the outside world on a fixed interval rather than through rAF: reaching
   * the end, releasing played frames, and topping the buffer up. A hidden tab pauses rAF, so a clip
   * that ran to its end there stayed `playing` until the tab was shown again, and the queue grew
   * because nothing evicted. Self-terminates once playback stops.
   */
  private schedulePlaybackCheck():void{
    if(this.playbackCheckActive)return;
    this.playbackCheckActive=true;
    setTimeout(()=>{
      this.playbackCheckActive=false;
      if(this.destroyed||this.status!=="playing")return;
      const t=this.currentTime;
      if(this.isReverse()&&t<=0){this.finishReachedStart();return;}
      if(this.mode==="streaming"){
        this.evictPlayedMedia(t);
        if(!this.isReverse()&&this.streamAtEnd(t)){this.finishEnded();return;}
        this.requestFill(t);this.requestAudioFill(t);
      }
      if(!this.isReverse()&&t>=this.durationValue){this.finishEnded();return;}
      this.schedulePlaybackCheck();
    },250);
  }
  async play(): Promise<void> { if(this.status==="playing")return;if(this.status==="buffering"){this.resumeAfterBuffer=true;return;} if(this.mode==="streaming")this.resetAndScheduleStreamingAudio(this.pausedAt);else this.startAudio(this.pausedAt); await this.resumeAudioIfAudible(); const delay=this.mode==="streaming"&&this.audio&&this.audioContextAnchor!==undefined?Math.max(0,this.audioContextAnchor-this.audio.currentTime)*1000:0;this.anchorPlayback(this.pausedAt,delay); this.setStatus("playing"); this.tick(); this.schedulePlaybackCheck(); }
  pause(): void { if(this.status!=="playing"&&this.status!=="buffering")return;if(this.status==="playing")this.pausedAt=this.currentTime;this.resumeAfterBuffer=false;this.abortFill();this.setBuffering(false); this.stopAudioSource(); void this.audio?.suspend(); cancelAnimationFrame(this.raf);this.raf=0; this.setStatus("paused"); }
  async seek(seconds:number,strict=false): Promise<void> { const seekStarted=performance.now(); this.requestedTimecode=null;this.actualDisplayedFrame=null;this.seekElapsedMs=null;this.seekReadBytes=0; const wasPlaying=this.status==="playing"||this.status==="buffering"&&this.resumeAfterBuffer;if(this.status==="playing")this.pausedAt=this.currentTime;cancelAnimationFrame(this.raf);this.raf=0;this.abortFill();this.invalidateStreamingVideoDecoder();this.stopAudioSource();this.setBuffering(false);this.seekController?.abort();const controller=new AbortController();this.seekController=controller;const generation=++this.seekGeneration,loadGeneration=this.loadGeneration,isCurrent=()=>!controller.signal.aborted&&!this.destroyed&&generation===this.seekGeneration&&loadGeneration===this.loadGeneration;this.setSeeking(true); try { if(!isCurrent())return;this.pausedAt=Math.max(0,Math.min(this.durationValue,seconds)); const fps=this.essenceIndex?.frameRate??XDCAM_FRAME_RATE; this.requestedFrame=Math.min(Math.max(0,Math.round(this.pausedAt*fps)),Math.max(0,Math.ceil(this.durationValue*fps)-1)); this.pausedAt=this.requestedFrame/fps; this.seekStartFrame=this.requestedFrame; this.prerollFrames=0; this.seekSource=this.mode==="streaming"?"sequential-fallback":null; if(this.mode==="streaming"&&this.essenceIndex){ const point=findSeekPoint(mergeIndexTables(this.indexTables??[]),this.requestedFrame); this.seekStartFrame=point.editUnit; this.prerollFrames=this.requestedFrame-point.editUnit; this.seekSource=point.source; const before=(this.reader as any)?.getStats?.().bytesLoaded??0;this.resumeAfterBuffer=wasPlaying;this.setStatus("buffering");this.setBuffering(true);this.clearFrames();this.audioChunks=[];this.queuedThroughFrame=-1;this.keyFrameCoverage=undefined;const decimated=this.frameSelection()==="key-frames";await Promise.all([decimated?this.fillKeyFrames(this.requestedFrame,controller.signal,loadGeneration,generation):this.fillStreaming(this.requestedFrame,controller.signal,loadGeneration,generation,this.seekStartFrame),this.fillStreamingAudio(this.pausedAt,controller.signal,loadGeneration,generation)]);if(!isCurrent())return; this.seekReadBytes=Math.max(0,Number((this.reader as any)?.getStats?.().bytesLoaded??0)-Number(before));} const displayed=this.landOnFrame(); if(!displayed)throw new Error(`Requested frame ${this.requestedFrame} was not decoded`); this.actualDisplayedFrame=displayed.mediaFrame; this.seekElapsedMs=performance.now()-seekStarted; this.publishDiagnostics(); this.emitTime(this.pausedAt);if(wasPlaying){if(this.mode==="streaming")this.resetAndScheduleStreamingAudio(this.pausedAt);else this.startAudio(this.pausedAt);await this.resumeAudioIfAudible();const delay=this.mode==="streaming"&&this.audio&&this.audioContextAnchor!==undefined?Math.max(0,this.audioContextAnchor-this.audio.currentTime)*1000:0;this.anchorPlayback(this.pausedAt,delay);this.setStatus("playing");this.tick();this.schedulePlaybackCheck();}else if(this.mode==="streaming")this.setStatus("paused"); } catch(error){if((error as Error).name==="AbortError"||!isCurrent())return;const failure=error instanceof Error?error:new Error(String(error));this.failStreaming(failure);if(strict)throw failure;return;} finally { if(isCurrent()){this.setBuffering(false);this.setSeeking(false);} } }
  /** Media frame currently displayed, or the one the playhead sits on when paused. */
  /**
   * Rate is signed: negative plays backwards. A single value has no invalid combinations the way a
   * rate plus a direction flag would, and the media clock is then just anchor + elapsed * rate.
   * Zero would mean "playing but not moving", so it is rejected; pause() is how playback stops.
   */
  async setPlaybackRate(rate:number):Promise<void>{
    if(!Number.isFinite(rate)||rate===0)throw new RangeError("playbackRate must be a non-zero finite number; call pause() to stop");
    if(rate===this.playbackRateValue)return;
    const before=this.frameSelection(),wasReverse=this.isReverse(),at=this.currentTime,wasPlaying=this.status==="playing";
    this.applyPlaybackRate(rate);
    // A changed selection mode or direction makes the queue the wrong shape: it holds every frame
    // when only key frames are wanted, or covers the side the playhead is moving away from. Re-seek
    // to refill it, unless the queue happens to already hold what the new rate needs. A rate change
    // within one mode only needs the clock re-anchored.
    if(this.mode==="streaming"&&(this.frameSelection()!==before||this.isReverse()!==wasReverse)){
      if(this.canDecimateInPlace(before,wasReverse,at))this.decimateInPlace(at,wasPlaying);
      else { this.keyFrameCoverage=undefined; await this.seek(at); }
    } else if(this.status==="playing"){
      this.anchorPlayback(at);
      if(this.mode==="streaming")this.resetAndScheduleStreamingAudio(at); else this.startAudio(at);
    }
    this.publishDiagnostics();
  }
  /**
   * Speeding past the threshold in the same forward direction is the one selection change that does
   * not need new frames: an all-frames queue already contains every key frame the decimated rate
   * will display, so playback can carry straight on while the next refill decimates. Slowing back
   * down needs the frames between the key frames, and reversing needs the other side of the
   * playhead; neither is in the queue, so both still re-seek.
   */
  private canDecimateInPlace(before:FrameSelection,wasReverse:boolean,at:number):boolean {
    if(wasReverse||this.isReverse()||before!=="all-frames"||this.frameSelection()!=="key-frames")return false;
    if(this.mode!=="streaming"||!this.essenceIndex||this.status==="error")return false;
    if(!this.frames.some(frame=>frame.time>=at))return false;
    // A queue is consumed rate-times faster at the new rate, so the cover is measured in wall time.
    return this.status!=="playing"||this.bufferedAhead(at)>=IN_PLACE_DECIMATION_MIN_SECONDS*Math.abs(this.playbackRateValue);
  }
  private decimateInPlace(at:number,wasPlaying:boolean):void {
    const fps=this.essenceIndex?.frameRate??XDCAM_FRAME_RATE,playhead=Math.floor(at*fps);
    // The queue is the coverage the decimated refill continues from, so the next fill starts after
    // the frames already decoded instead of decoding that span a second time.
    this.keyFrameCoverage={from:Math.min(playhead,this.frames[0]?.mediaFrame??playhead),to:Math.max(playhead,this.queuedThroughFrame)};
    // Key-frame batches are self-contained decodes, so the streaming decoder must not continue the
    // all-frames stream it was left in the middle of.
    this.invalidateStreamingVideoDecoder();
    // The new rate mutes audio, so the nodes reserved at the old rate have to be released.
    this.stopStreamingAudioSources();
    void this.resumeAudioIfAudible();
    if(wasPlaying){ this.anchorPlayback(at); this.requestFill(at); }
  }
  private currentMediaFrame():number { const fps=this.essenceIndex?.frameRate??XDCAM_FRAME_RATE; return Math.round(this.currentTime*fps); }
  /**
   * Frame stepping is a paused-inspection gesture, so it pauses first rather than fighting the
   * clock: without that the playhead advances past the requested frame before the seek lands.
   */
  async stepFrame(frames=1):Promise<void>{
    if(this.status==="playing"||this.status==="buffering")this.pause();
    const fps=this.essenceIndex?.frameRate??XDCAM_FRAME_RATE,last=Math.max(0,Math.ceil(this.durationValue*fps)-1);
    await this.seek(Math.min(last,Math.max(0,this.currentMediaFrame()+Math.trunc(frames)))/fps);
  }
  /** Relative skip. Clamped to the media, and it keeps playing if it was playing. */
  async seekRelative(seconds:number):Promise<void>{ await this.seek(Math.min(this.durationValue,Math.max(0,this.currentTime+seconds))); }
  async seekTimecode(value:string):Promise<void>{ if(!this.timecodeInfo) throw new Error("timecode-track-unavailable"); this.requestedTimecode=null; const fps=this.essenceIndex?.frameRate??this.timecodeInfo.editRateNumerator/this.timecodeInfo.editRateDenominator,maxFrames=Math.ceil(this.durationValue*fps); const frame=timecodeToMediaFrame({...this.timecodeInfo,durationFrames:this.timecodeInfo.durationFrames===undefined?maxFrames:Math.min(this.timecodeInfo.durationFrames,maxFrames)},value), expectedGeneration=this.seekGeneration+1; await this.seek(frame/fps,true); if(expectedGeneration!==this.seekGeneration||this.destroyed)return; this.requestedTimecode=value; this.requestedFrame=frame; this.publishDiagnostics(); }
  /**
   * Where a seek actually lands. Decoding every frame lands on the requested frame or fails, but a
   * decimated rate can only land on a key frame, so it takes the nearest one and moves the playhead
   * there rather than reporting a miss.
   */
  private landOnFrame():RenderFrame|undefined{
    if(this.mode!=="streaming"||this.frameSelection()==="all-frames"){
      const exact=this.drawAt(this.pausedAt,true);
      return exact&&exact.mediaFrame===this.requestedFrame?exact:undefined;
    }
    let nearest:RenderFrame|undefined;
    for(const item of this.frames)if(!nearest||Math.abs(item.time-this.pausedAt)<Math.abs(nearest.time-this.pausedAt))nearest=item;
    if(!nearest)return undefined;
    this.pausedAt=nearest.time;this.drawFrame(nearest.frame);
    return nearest;
  }
  private emitTime(t:number){this.callbacks.time(t);this.callbacks.timecode?.(this.timecodeInfo ? timecodeAtSeconds(this.timecodeInfo,t) : null);}
  private drawAt(t:number,exact=false):RenderFrame|undefined{const requested=Math.round(t*(this.essenceIndex?.frameRate??XDCAM_FRAME_RATE));let f:RenderFrame|undefined;if(this.mode==="streaming"){if(exact)f=this.frames.find(item=>item.mediaFrame===requested);else if(this.isReverse())f=this.frames.find(item=>item.time>=t-.001);else for(let i=this.frames.length-1;i>=0;i--){if(this.frames[i].time<=t+.001){f=this.frames[i];break;}}}else f=this.frames[Math.min(this.frames.length-1,Math.floor(t*XDCAM_FRAME_RATE))];if(f)this.drawFrame(f.frame);return f;}
  private tick():void{if(this.destroyed||this.status!=="playing")return;const t=this.currentTime;if(this.mode==="streaming"){this.evictPlayedMedia(t);if(this.isReverse()){if(t<=0){this.finishReachedStart();return;}}else if(this.streamAtEnd(t)){this.finishEnded();return;}const hasFuture=this.isReverse()?this.frames.some(frame=>frame.time<=t)||this.fillExhausted():this.frames.some(frame=>frame.time>=t),hasAudio=this.audioReadyAt(t);if((!hasFuture||!hasAudio)&&t<this.durationValue){this.pausedAt=Math.min(t,this.durationValue);this.resumeAfterBuffer=true;cancelAnimationFrame(this.raf);this.raf=0;this.stopStreamingAudioSources();void this.audio?.suspend();this.setStatus("buffering");this.setBuffering(true);this.requestFill(this.pausedAt,true);this.requestAudioFill(this.pausedAt);return;}this.requestFill(t);this.requestAudioFill(t);}this.drawAt(t);this.emitTime(t);if(!this.isReverse()&&t>=this.durationValue){this.finishEnded();return;}this.raf=requestAnimationFrame(()=>this.tick());}
  destroy():void{this.destroyed=true;this.stopAudioLevelSampling();this.stopMemoryMonitor();this.loadGeneration++;this.seekGeneration++;this.abortFill();this.invalidateStreamingVideoDecoder();this.setBuffering(false);this.loadController?.abort();this.seekController?.abort();cancelAnimationFrame(this.raf);this.raf=0;this.stopAudioSource();this.releaseReader();void this.audio?.close();this.audio=undefined;this.audioChunks=[];this.scheduledAudio=[];this.audioMediaAnchor=undefined;this.audioContextAnchor=undefined;this.clearFrames();this.videoDecoderClient?.dispose();}
}
