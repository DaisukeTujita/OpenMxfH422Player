import { parseMxf, type ParsedMxf } from "./mxf";
import { parseMxfMetadataFromReader } from "./mxf-reader";
import { FileRandomAccessReader, type RandomAccessReader } from "./random-access-reader";
import { pcmS24beToFloat32, XDCAM_FRAME_RATE, yuv422pToRgba } from "./media";
import { timecodeAtSeconds, timecodeToMediaFrame, type MxfTimecodeInfo } from "./timecode";
import { findSeekPoint } from "./mxf-index";
import type { PlayerInfo, PlayerStatus } from "./types";
import { WebGlRenderer } from "./webgl";
import { essenceDecodeStart, indexMxfEssence, readEssenceRange, type EssenceIndex } from "./essence-reader";
import type { PlaybackMode, PlayerDiagnostics } from "./types";

interface Callbacks { status(s: PlayerStatus): void; ready(i: PlayerInfo): void; time(t: number): void; error(e: Error): void; mediaInfo?(i: import("./mxf-metadata").MxfMediaInfo): void; timecode?(value: string | null): void; seeking?(value: boolean): void; buffering?(value:boolean):void; diagnostics?(value:PlayerDiagnostics):void }
type LibAV = Record<string, any>;
type DecodedFrame = { data?: Uint8Array; layout?: Array<{offset:number; stride:number}>; width: number; height: number; format?: number; pts?: number };
type RenderFrame = {frame: ImageData; time: number; mediaFrame: number};
type StreamingAudioChunk = {mediaStartTime:number;mediaEndTime:number;buffer:AudioBuffer;generation:number;scheduled:boolean};
type ScheduledAudio = {mediaStartTime:number;mediaEndTime:number;contextStartTime:number;sourceNode:AudioBufferSourceNode;generation:number;started:boolean;ended:boolean};
export interface PlayerEngineDependencies {
  createReader(blob: Blob): RandomAccessReader & {destroy():void};
  parseMetadata(reader: RandomAccessReader, signal: AbortSignal): ReturnType<typeof parseMxfMetadataFromReader>;
  readWhole(blob: Blob): Promise<Uint8Array>;
  parse(bytes: Uint8Array): ParsedMxf;
  loadLibav(base: string): Promise<LibAV>;
  indexEssence: typeof indexMxfEssence;
  readRange: typeof readEssenceRange;
}
const defaultDependencies: PlayerEngineDependencies = {
  createReader: blob=>new FileRandomAccessReader(blob), parseMetadata:(reader,signal)=>parseMxfMetadataFromReader(reader,{signal}),
  readWhole:async blob=>new Uint8Array(await blob.slice(0,blob.size).arrayBuffer()), parse:parseMxf, loadLibav:loadCustomLibAV, indexEssence:indexMxfEssence, readRange:readEssenceRange,
};

export interface PlayerEngineOptions { mode?: PlaybackMode; videoAheadSeconds?:number; retainBehindSeconds?:number; refillThresholdSeconds?:number; chunkSeconds?:number; maxReadSize?:number }

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

export async function loadCustomLibAV(base: string): Promise<LibAV> {
  const normalizedBase = base.replace(/\/$/, "");
  const url = `${normalizedBase}/libav-h422.mjs`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch custom libav.js frontend: ${url} (${reason})`, { cause: error });
  }
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    throw new Error(`Failed to fetch custom libav.js frontend: ${url} (${status})`);
  }

  const source = await response.text();
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    // Import the fetched deployment asset indirectly so bundlers do not resolve publicDir at build time.
    const module = await import(/* @vite-ignore */ moduleUrl) as { default?: { LibAV(options: object): Promise<unknown> }; LibAV?: (options: object) => Promise<unknown> };
    const factory = module.default?.LibAV ?? module.LibAV;
    if (!factory) throw new Error(`Invalid custom libav.js frontend: ${url}`);
    // Keep the real asset directory as base; the blob URL only loads the frontend module.
    return await factory({ base: normalizedBase, noworker: false }) as LibAV;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

export class PlayerEngine {
  private libav?: LibAV; private renderer: WebGlRenderer; private audio?: AudioContext; private audioBuffer?: AudioBuffer; private audioSource?: AudioBufferSourceNode;
  private status: PlayerStatus="idle"; private startedAt=0; private pausedAt=0; private durationValue=0;
  private frames: RenderFrame[]=[]; private raf=0;
  private timecodeInfo?: MxfTimecodeInfo;
  private loadController?: AbortController; private destroyed=false; private loadGeneration=0;
  private seekController?: AbortController; private seekGeneration=0;
  private requestedTimecode:string|null=null; private requestedFrame:number|null=null; private actualDisplayedFrame:number|null=null; private seekStartFrame:number|null=null; private prerollFrames=0; private seekSource:PlayerDiagnostics["seekSource"]=null; private seekReadBytes=0; private seekElapsedMs:number|null=null; private timecodeSelectionReason="Timecode Trackなし";
  private reader?: RandomAccessReader & {destroy():void}; private essenceIndex?:EssenceIndex; private indexTables:import("./mxf-index").MxfIndexTable[]=[]; private mode:PlaybackMode;
  private fileSize=0; private filling?:Promise<void>; private fillController?:AbortController; private queuedThroughFrame=-1; private videoCodecId=2;
  private buffering=false; private resumeAfterBuffer=false;
  private streamingAudioSupported=false; private audioFormatBasis:PlayerDiagnostics["audioFormatBasis"]=null; private selectedAudioTrackNumber?:number; private audioSampleRate?:number; private audioChannels?:number;
  private audioChunks:StreamingAudioChunk[]=[]; private scheduledAudio:ScheduledAudio[]=[]; private audioBytesLoaded=0; private audioMediaAnchor?:number; private audioContextAnchor?:number; private audioQueuedThroughTime=0; private audioExhausted=false; private lastAudioTime=0; private audioFillController?:AbortController; private audioFilling?:Promise<void>;
  private destroyedReaders?:WeakSet<object>;
  private readonly videoAheadSeconds:number; private readonly retainBehindSeconds:number; private readonly refillThresholdSeconds:number; private readonly chunkSeconds:number; private readonly maxReadSize:number;
  private readonly dependencies: PlayerEngineDependencies;
  constructor(canvas: HTMLCanvasElement, private callbacks: Callbacks, private muted=false, private libavBase="/libav", dependencies: Partial<PlayerEngineDependencies>={}, options:PlayerEngineOptions={}) { this.renderer=new WebGlRenderer(canvas);this.dependencies={...defaultDependencies,...dependencies};this.mode=options.mode??"legacy";this.videoAheadSeconds=options.videoAheadSeconds??4;this.retainBehindSeconds=options.retainBehindSeconds??1;this.refillThresholdSeconds=options.refillThresholdSeconds??2;this.chunkSeconds=options.chunkSeconds??3;this.maxReadSize=options.maxReadSize??4*1024*1024; }
  get currentTime(): number { return this.status === "playing" ? Math.min(this.durationValue,(performance.now()-this.startedAt)/1000) : this.pausedAt; }
  get duration(): number { return this.durationValue; }
  private setStatus(s: PlayerStatus) { this.status=s; this.callbacks.status(s); }
  getDiagnostics():PlayerDiagnostics { const stats=(this.reader as any)?.getStats?.()??{};const active=this.audio&&this.scheduledAudio.find(range=>range.contextStartTime<=this.audio!.currentTime&&range.contextStartTime+range.mediaEndTime-range.mediaStartTime>=this.audio!.currentTime);const audioTime=active&&this.audio?active.mediaStartTime+this.audio.currentTime-active.contextStartTime:null;return {mode:this.mode,fileSize:this.fileSize,bytesLoaded:Number(stats.bytesLoaded??0),underlyingReadCount:stats.underlyingReadCount??0,cacheBytes:stats.cachedBytes??0,videoQueueFrames:this.frames.length,videoQueueStart:this.frames[0]?.time??null,videoQueueEnd:this.frames.at(-1)?.time??null,scheduledAudioRanges:this.mode==="streaming"?this.scheduledAudio.length:(this.audioSource?1:0),loadGeneration:this.loadGeneration,seekGeneration:this.seekGeneration,streamingAudioSupported:this.streamingAudioSupported,selectedAudioTrackNumber:this.selectedAudioTrackNumber??null,audioSampleRate:this.audioSampleRate??null,audioChannels:this.audioChannels??null,audioQueueStart:this.audioChunks?.[0]?.mediaStartTime??null,audioQueueEnd:this.audioChunks?.at(-1)?.mediaEndTime??null,audioVideoDriftMs:audioTime===null?null:(audioTime-this.currentTime)*1000,audioBytesLoaded:this.audioBytesLoaded,audioQueuedThroughTime:this.audioQueuedThroughTime,audioExhausted:this.audioExhausted,lastPlayableAudioTime:this.streamingAudioSupported?this.lastAudioTime:null,audioFormatBasis:this.audioFormatBasis,requestedTimecode:this.requestedTimecode,requestedFrame:this.requestedFrame,actualDisplayedFrame:this.actualDisplayedFrame,seekStartFrame:this.seekStartFrame,prerollFrames:this.prerollFrames,seekSource:this.seekSource,seekReadBytes:this.seekReadBytes,seekElapsedMs:this.seekElapsedMs,selectedTimecodeTrack:this.timecodeInfo?"unresolved":null,timecodeSelectionReason:this.timecodeSelectionReason}; }
  private publishDiagnostics(){this.callbacks.diagnostics?.(this.getDiagnostics());}
  private destroyReader(reader?:RandomAccessReader & {destroy():void}){if(!reader)return;const destroyed=this.destroyedReaders??=new WeakSet<object>();if(destroyed.has(reader))return;destroyed.add(reader);reader.destroy();}
  private releaseReader(expected?:RandomAccessReader & {destroy():void}){const reader=expected??this.reader;if(!reader)return;if(this.reader===reader)this.reader=undefined;this.destroyReader(reader);}
  private abortFill(){this.fillController?.abort();this.fillController=undefined;this.filling=undefined;this.audioFillController?.abort();this.audioFillController=undefined;this.audioFilling=undefined;}
  private setBuffering(value:boolean){if(this.buffering===value)return;this.buffering=value;this.callbacks.buffering?.(value);}
  private streamExhausted(){const videos=this.essenceIndex?.packets.filter(packet=>packet.kind==="video");const last=videos?.at(-1);return Boolean(last&&this.queuedThroughFrame>=last.editUnit);}
  private streamAtEnd(t:number){if(!this.streamExhausted()||!this.essenceIndex)return false;const lastTime=this.frames.at(-1)?.time??0;return t>=Math.min(lastTime,this.durationValue-1/this.essenceIndex.frameRate);}
  private finishEnded(){if(this.status==="ended")return;const last=this.frames.at(-1);if(last)this.renderer.draw(last.frame,last.frame.width,last.frame.height);this.pausedAt=this.durationValue;this.emitTime(this.durationValue);cancelAnimationFrame(this.raf);this.raf=0;this.resumeAfterBuffer=false;this.setBuffering(false);this.stopAudioSource();void this.audio?.suspend();this.setStatus("ended");}
  private failStreaming(error:Error){this.abortFill();cancelAnimationFrame(this.raf);this.raf=0;this.resumeAfterBuffer=false;this.setBuffering(false);this.stopAudioSource();void this.audio?.suspend();this.frames=[];this.releaseReader();this.setStatus("error");this.callbacks.error(error);}
  async load(source: File|Blob|string): Promise<void> {
    this.stopAudioSource();const previousAudio=this.audio;this.audio=undefined;if(previousAudio)await previousAudio.close();this.audioBuffer=undefined;this.streamingAudioSupported=false;this.audioFormatBasis=null;this.selectedAudioTrackNumber=undefined;this.audioSampleRate=undefined;this.audioChannels=undefined;this.audioChunks=[];this.scheduledAudio=[];this.audioBytesLoaded=0;this.audioQueuedThroughTime=0;this.audioExhausted=false;this.lastAudioTime=0;this.audioMediaAnchor=undefined;this.audioContextAnchor=undefined; this.abortFill();this.setBuffering(false); this.releaseReader(); this.seekController?.abort(); this.seekGeneration++;
    this.loadController?.abort(); const controller=new AbortController(); this.loadController=controller; const {signal}=controller, generation=++this.loadGeneration;
    const current=()=>!signal.aborted&&!this.destroyed&&this.loadGeneration===generation;
    this.setStatus("loading");
    let localReader:(RandomAccessReader & {destroy():void})|undefined;try {
      const blob=typeof source === "string" ? await fetch(source,{signal}).then(r=>{if(!r.ok)throw new Error(`MXF request failed (${r.status})`);return r.blob();}) : source; this.fileSize=blob.size;
      if(!current())return;
      const reader=this.dependencies.createReader(blob);localReader=reader;
      let metadata;
      try { metadata=await this.dependencies.parseMetadata(reader,signal); }
      finally { if(this.mode!=="streaming"||!current())this.destroyReader(reader); }
      if(!current())return;
      const timecodeInfo=selectTimecodeTrack(metadata.timecodes);
      metadata.mediaInfo.selectedTimecode=timecodeInfo;
      this.timecodeSelectionReason=timecodeInfo?"Package参照解析は未対応のためKLV検出順で選択":"Timecode Trackなし"; metadata.mediaInfo.timecodeSelectionReason=this.timecodeSelectionReason;
      if(this.mode==="streaming") {
        if(metadata.mediaInfo.operationalPattern!=="OP1a")throw new Error("Streaming requires an MXF OP1a Partition Pack");
        const descriptor=metadata.mediaInfo.video;if(!descriptor?.width||!descriptor.height||!metadata.mediaInfo.essenceContainer)throw new Error("Streaming requires an identifiable XDCAM HD422 picture and Essence Container descriptor");
        if(!([[1920,1080],[1280,720]] as const).some(([width,height])=>descriptor.width===width&&descriptor.height===height))throw new Error(`Streaming does not support the ${descriptor.width}x${descriptor.height} picture descriptor`);
        this.reader=reader; const frameRate=metadata.mediaInfo.editRateNumerator&&metadata.mediaInfo.editRateDenominator?metadata.mediaInfo.editRateNumerator/metadata.mediaInfo.editRateDenominator:XDCAM_FRAME_RATE;
        this.indexTables=metadata.indexTables; this.essenceIndex=await this.dependencies.indexEssence(reader,{partitions:metadata.partitions,indexTables:metadata.indexTables,frameRate,signal}); if(!current())return;
        if(!this.essenceIndex.packets.some(packet=>packet.kind==="video"))throw new Error("Streaming requires MPEG-2 video essence");
        const libav=await this.dependencies.loadLibav(this.libavBase);if(!current())return;if(await libav.libavjs_with_swscale?.()!==1)throw new Error("Custom libav.js was built without swscale");
        this.libav=libav;this.timecodeInfo=timecodeInfo;this.durationValue=(metadata.mediaInfo.durationFrames??this.essenceIndex.packets.filter(p=>p.kind==="video").length)/frameRate;this.frames=[];this.queuedThroughFrame=-1;
        this.configureStreamingAudio(metadata.mediaInfo);
        const initialFill=new AbortController();this.fillController=initialFill;await Promise.all([this.fillStreaming(0,initialFill.signal,generation,this.seekGeneration),this.fillStreamingAudio(0,initialFill.signal,generation,this.seekGeneration)]);if(this.fillController===initialFill)this.fillController=undefined;if(!current())return;const first=this.frames[0];if(!first)throw new Error("The MPEG-2 decoder returned no frames");
        this.renderer.draw(first.frame,first.frame.width,first.frame.height);this.callbacks.mediaInfo?.(metadata.mediaInfo);this.callbacks.timecode?.(timecodeInfo?timecodeAtSeconds(timecodeInfo,0):null);this.callbacks.ready({width:first.frame.width,height:first.frame.height,frameRate,duration:this.durationValue,audioSampleRate:this.audioSampleRate??48000,audioChannels:this.streamingAudioSupported?this.audioChannels!:0});this.setStatus("ready");this.publishDiagnostics();return;
      }
      // Compatibility path intentionally retains contiguous full-file decoding.
      const bytes=await this.dependencies.readWhole(blob);
      if(!current())return;
      const parsed=this.dependencies.parse(bytes);
      console.info(`[H422Player] video codec_id=${parsed.videoCodec.codecId} codec_name=${parsed.videoCodec.codecName}`);
      if (parsed.audioCodec) console.info(`[H422Player] audio codec_id=${parsed.audioCodec.codecId} codec_name=${parsed.audioCodec.codecName}`);
      const libav=await this.dependencies.loadLibav(this.libavBase); if(!current())return;
      if (await libav.libavjs_with_swscale?.() !== 1) throw new Error("Custom libav.js was built without swscale"); if(!current())return;
      const video=parsed.packets.filter(p=>p.kind==="video"); const audio=parsed.packets.filter(p=>p.kind==="audio");
      const frames=await this.decodeVideo(video.map(p=>p.data), parsed.videoCodec.codecId,libav); if(!current())return;
      const prepared=audio.length&&!this.muted ? await this.preparePcm(audio.map(p=>p.data)) : undefined;
      if(!current()){if(prepared)void prepared.audio.close();return;}
      const duration=frames.length/XDCAM_FRAME_RATE, first=frames[0]; if (!first) { if(prepared)void prepared.audio.close(); throw new Error("The MPEG-2 decoder returned no frames"); }
      this.libav=libav;this.frames=frames;this.timecodeInfo=timecodeInfo;this.durationValue=duration;
      if(prepared){this.audio=prepared.audio;this.audioBuffer=prepared.audioBuffer;}
      this.renderer.draw(first.frame,first.frame.width,first.frame.height);
      this.callbacks.mediaInfo?.(metadata.mediaInfo);this.callbacks.timecode?.(timecodeInfo ? timecodeAtSeconds(timecodeInfo,0) : null);
      this.callbacks.ready({width:first.frame.width,height:first.frame.height,frameRate:XDCAM_FRAME_RATE,duration,audioSampleRate:48000,audioChannels:audio.length?2:0});
      this.setStatus("ready");
    } catch (e) { const error=e instanceof Error?e:new Error(String(e)); if(localReader)this.releaseReader(localReader); if(error.name==="AbortError"||!current())return; this.setStatus("error"); this.callbacks.error(error); throw error; }
  }
  private async fillStreaming(targetFrame:number,signal:AbortSignal,loadGeneration:number,seekGeneration=this.seekGeneration,decodeStartFrame?:number):Promise<boolean>{
    if(!this.reader||!this.essenceIndex||!this.libav)return false;
    const current=()=>!signal.aborted&&!this.destroyed&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration;
    const fps=this.essenceIndex.frameRate,target=Math.max(0,Math.trunc(targetFrame));
    const decodeStart=decodeStartFrame??essenceDecodeStart(this.essenceIndex,target);
    const end=Math.min(Math.ceil(this.durationValue*fps)-1,target+Math.ceil(this.chunkSeconds*fps)-1);
    if(end<=this.queuedThroughFrame&&target>=0)return current();
    const packets=await this.dependencies.readRange(this.reader,this.essenceIndex,{startFrame:decodeStart,endFrame:end,prerollFrames:0,signal,maxReadSize:this.maxReadSize,kinds:["video"]});
    if(!current())return false;
    const video=packets.filter(packet=>packet.kind==="video");
    if(decodeStart===0){const first=video[0]?.data;let sequence=false;if(first)for(let i=0;i+3<Math.min(first.length,256);i++)if(first[i]===0&&first[i+1]===0&&first[i+2]===1&&first[i+3]===0xb3){sequence=true;break;}if(!sequence)throw new Error("Streaming requires XDCAM HD422 MPEG-2 sequence-header essence");}
    const decoded=await this.decodeVideo(video.map(packet=>packet.data),this.videoCodecId,this.libav,video.map(packet=>packet.editUnit),fps);
    if(!current())return false;
    const positioned=decoded.map((item,index)=>item.mediaFrame===undefined?{...item,mediaFrame:video[index]?.editUnit??decodeStart+index,time:(video[index]?.editUnit??decodeStart+index)/fps}:item);
    const wanted=positioned.filter(item=>item.mediaFrame>=target&&item.mediaFrame<=end);
    const existing=new Set(this.frames.map(frame=>frame.mediaFrame));
    for(const item of wanted)if(!existing.has(item.mediaFrame))this.frames.push(item);
    this.frames.sort((a,b)=>a.mediaFrame-b.mediaFrame);this.queuedThroughFrame=Math.max(this.queuedThroughFrame,end);this.publishDiagnostics();return true;
  }
  private requestFill(t:number,force=false){if(this.mode!=="streaming"||!this.essenceIndex||this.filling||this.streamExhausted())return;const fps=this.essenceIndex.frameRate,ahead=(this.frames.at(-1)?.time??t)-t;if(!force&&ahead>=this.refillThresholdSeconds)return;const controller=new AbortController();this.fillController=controller;const loadGeneration=this.loadGeneration,seekGeneration=this.seekGeneration,start=Math.max(Math.floor(t*fps),this.queuedThroughFrame+1);const promise=this.fillStreaming(start,controller.signal,loadGeneration,seekGeneration).then(applied=>{if(!applied||controller.signal.aborted||this.filling!==promise)return;const remaining=(this.frames.at(-1)?.time??t)-t;if(remaining<this.videoAheadSeconds&&!this.streamExhausted()){this.filling=undefined;this.fillController=undefined;this.requestFill(t,true);return;}if(this.buffering&&this.streamAtEnd(this.pausedAt)){this.finishEnded();return;}}).catch(e=>{if((e as Error).name!=="AbortError"&&this.filling===promise&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration&&!this.destroyed)this.failStreaming(e instanceof Error?e:new Error(String(e)));}).finally(()=>{if(this.filling===promise){this.filling=undefined;if(this.fillController===controller)this.fillController=undefined;this.tryResumeFromBuffering(loadGeneration,seekGeneration);}});this.filling=promise;}
  private async decodeVideo(chunks: Uint8Array[], codecId: number, av: LibAV=this.libav!, mediaFrames:number[]=chunks.map((_,i)=>i), frameRate=XDCAM_FRAME_RATE): Promise<RenderFrame[]> {
    // ff_init_decoder receives the codec_id detected for the MXF essence (AV_CODEC_ID_MPEG2VIDEO=2).
    const [,ctx,pkt,frame]=await av.ff_init_decoder(codecId);
    let decodeFailure: { error: unknown }|undefined; const frames: RenderFrame[]=[];
    try {
      const rateScale=Number.isInteger(frameRate)?1:1001,rateDenominator=Math.round(frameRate*rateScale);
      const packets=chunks.map((data,i)=>({data,pts:mediaFrames[i]??i,time_base_num:rateScale,time_base_den:rateDenominator}));
      const decoded=await av.ff_decode_multi(ctx,pkt,frame,packets,true) as DecodedFrame[];
      for (let i=0;i<decoded.length;i++) {
        const f=decoded[i]; if (!f.data) continue;
        if (f.format !== av.AV_PIX_FMT_YUV422P || !f.layout || f.layout.length < 3)
          throw new Error(`Expected yuv422p planes from MPEG-2 decoder (pixel format ${f.format ?? "unknown"})`);
        const plane=(index:number,width:number) => {
          const output=new Uint8Array(width*f.height), layout=f.layout![index];
          for(let row=0;row<f.height;row++) output.set(f.data!.subarray(layout.offset+row*layout.stride,layout.offset+row*layout.stride+width),row*width);
          return output;
        };
        const chromaWidth=Math.ceil(f.width/2);
        const rgba=yuv422pToRgba(plane(0,f.width),plane(1,chromaWidth),plane(2,chromaWidth),f.width,f.height);
        const decodedPts=f.pts===undefined?Number.NaN:Number(f.pts),mediaFrame=Number.isSafeInteger(decodedPts)?decodedPts:mediaFrames[i]??i;frames.push({frame:new ImageData(new Uint8ClampedArray(rgba),f.width,f.height),time:mediaFrame/frameRate,mediaFrame});
      }
    } catch (error) {
      decodeFailure={error};
    }
    try { await av.ff_free_decoder(ctx,pkt,frame); }
    catch (error) { if (!decodeFailure) throw error; }
    if (decodeFailure) throw decodeFailure.error;
    return frames;
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
  private scheduleStreamingChunk(chunk:StreamingAudioChunk,mediaTime:number):void{if(!this.audio||this.audioMediaAnchor===undefined||this.audioContextAnchor===undefined||chunk.scheduled||chunk.generation!==this.seekGeneration||chunk.mediaEndTime<=mediaTime||chunk.mediaStartTime>=this.durationValue)return;const start=Math.max(mediaTime,chunk.mediaStartTime),offset=start-chunk.mediaStartTime,end=Math.min(chunk.mediaEndTime,this.durationValue);if(end<=start)return;let contextStart=this.audioContextAnchor+(start-this.audioMediaAnchor);const previous=this.scheduledAudio.at(-1);if(previous){const previousEnd=previous.contextStartTime+previous.mediaEndTime-previous.mediaStartTime;if(Math.abs(contextStart-previousEnd)<.002)contextStart=previousEnd;if(contextStart<previousEnd-.002)return;}const node=this.audio.createBufferSource();node.buffer=chunk.buffer;node.connect(this.audio.destination);const range:ScheduledAudio={mediaStartTime:start,mediaEndTime:end,contextStartTime:contextStart,sourceNode:node,generation:this.seekGeneration,started:true,ended:false};node.onended=()=>{range.ended=true;try{node.disconnect();}catch{/* harmless */}};node.start(contextStart,offset,end-start);chunk.scheduled=true;this.scheduledAudio.push(range);}
  private resetAndScheduleStreamingAudio(mediaTime:number):void{if(!this.streamingAudioSupported||!this.audio)return;this.stopStreamingAudioSources();this.audioMediaAnchor=mediaTime;this.audioContextAnchor=this.audio.currentTime+.03;for(const chunk of this.audioChunks)this.scheduleStreamingChunk(chunk,mediaTime);}
  private appendStreamingAudioSchedule():void{if(!this.streamingAudioSupported||this.audioMediaAnchor===undefined)return;for(const chunk of this.audioChunks)this.scheduleStreamingChunk(chunk,this.audioMediaAnchor);}
  private audioReadyAt(time:number):boolean{return !this.streamingAudioSupported||this.audioChunks.some(chunk=>chunk.mediaStartTime<=time+.05&&chunk.mediaEndTime>time)||this.audioExhausted&&time>=this.lastAudioTime-.002;}
  private tryResumeFromBuffering(load=this.loadGeneration,seek=this.seekGeneration):void{if(this.destroyed||this.status==="error"||!this.buffering||!this.resumeAfterBuffer||load!==this.loadGeneration||seek!==this.seekGeneration||this.filling||this.audioFilling)return;if(!this.frames.some(frame=>frame.time>=this.pausedAt)||!this.audioReadyAt(this.pausedAt))return;this.drawAt(this.pausedAt);this.resetAndScheduleStreamingAudio(this.pausedAt);void this.audio?.resume();const delay=this.audio&&this.audioContextAnchor!==undefined?Math.max(0,this.audioContextAnchor-this.audio.currentTime)*1000:0;this.startedAt=performance.now()+delay-this.pausedAt*1000;this.setBuffering(false);this.setStatus("playing");this.tick();}
  private requestAudioFill(t:number):void{if(!this.streamingAudioSupported||this.audioFilling||this.audioExhausted)return;const end=this.audioChunks?.at(-1)?.mediaEndTime??t;if(end-t>=1.25)return;const controller=new AbortController();this.audioFillController=controller;const load=this.loadGeneration,seek=this.seekGeneration;const promise=this.fillStreamingAudio(end,controller.signal,load,seek).then(applied=>{if(applied&&this.status==="playing")this.appendStreamingAudioSchedule();}).catch(error=>{if((error as Error).name!=="AbortError"&&load===this.loadGeneration&&seek===this.seekGeneration)this.failStreaming(error instanceof Error?error:new Error(String(error)));}).finally(()=>{if(this.audioFilling===promise){this.audioFilling=undefined;this.audioFillController=undefined;this.tryResumeFromBuffering(load,seek);}});this.audioFilling=promise;}
  private async preparePcm(chunks: Uint8Array[]): Promise<{audio:AudioContext;audioBuffer:AudioBuffer}> {
    const audio=new AudioContext({sampleRate:48000});
    const bytes=chunks.reduce((n,c)=>n+c.length,0), joined=new Uint8Array(bytes); let at=0;
    for(const c of chunks){joined.set(c,at);at+=c.length;}
    const channels=pcmS24beToFloat32(joined,2), audioBuffer=audio.createBuffer(2,channels[0].length,48000);
    channels.forEach((samples,index)=>audioBuffer.copyToChannel(new Float32Array(samples),index)); await audio.suspend(); return {audio,audioBuffer};
  }
  private stopAudioSource():void { this.stopStreamingAudioSources();const source=this.audioSource;this.audioSource=undefined;if(!source)return;try{source.stop();}catch{/* An AudioBufferSourceNode can only be stopped once on some implementations. */}try{source.disconnect();}catch{/* A disconnected node is already harmless. */} }
  private startAudio(offset:number):void { if(!this.audio||!this.audioBuffer)return; this.stopAudioSource(); const node=this.audio.createBufferSource(); node.buffer=this.audioBuffer; node.connect(this.audio.destination); node.start(0,Math.min(offset,this.audioBuffer.duration)); this.audioSource=node; }
  async play(): Promise<void> { if(this.status==="playing")return;if(this.status==="buffering"){this.resumeAfterBuffer=true;return;} if(this.mode==="streaming")this.resetAndScheduleStreamingAudio(this.pausedAt);else this.startAudio(this.pausedAt); await this.audio?.resume(); const delay=this.mode==="streaming"&&this.audio&&this.audioContextAnchor!==undefined?Math.max(0,this.audioContextAnchor-this.audio.currentTime)*1000:0;this.startedAt=performance.now()+delay-this.pausedAt*1000; this.setStatus("playing"); this.tick(); }
  pause(): void { if(this.status!=="playing"&&this.status!=="buffering")return;if(this.status==="playing")this.pausedAt=this.currentTime;this.resumeAfterBuffer=false;this.abortFill();this.setBuffering(false); this.stopAudioSource(); void this.audio?.suspend(); cancelAnimationFrame(this.raf);this.raf=0; this.setStatus("paused"); }
  async seek(seconds:number,strict=false): Promise<void> { const seekStarted=performance.now(); this.requestedTimecode=null;this.actualDisplayedFrame=null;this.seekElapsedMs=null;this.seekReadBytes=0; const wasPlaying=this.status==="playing"||this.status==="buffering"&&this.resumeAfterBuffer;if(this.status==="playing")this.pausedAt=this.currentTime;cancelAnimationFrame(this.raf);this.raf=0;this.abortFill();this.stopAudioSource();this.setBuffering(false);this.seekController?.abort();const controller=new AbortController();this.seekController=controller;const generation=++this.seekGeneration,loadGeneration=this.loadGeneration,isCurrent=()=>!controller.signal.aborted&&!this.destroyed&&generation===this.seekGeneration&&loadGeneration===this.loadGeneration;this.callbacks.seeking?.(true); try { if(!isCurrent())return;this.pausedAt=Math.max(0,Math.min(this.durationValue,seconds)); const fps=this.essenceIndex?.frameRate??XDCAM_FRAME_RATE; this.requestedFrame=Math.min(Math.max(0,Math.round(this.pausedAt*fps)),Math.max(0,Math.ceil(this.durationValue*fps)-1)); this.pausedAt=this.requestedFrame/fps; this.seekStartFrame=this.requestedFrame; this.prerollFrames=0; this.seekSource=this.mode==="streaming"?"sequential-fallback":null; if(this.mode==="streaming"&&this.essenceIndex){ const point=findSeekPoint(this.indexTables?.[0],this.requestedFrame); this.seekStartFrame=point.editUnit; this.prerollFrames=this.requestedFrame-point.editUnit; this.seekSource=point.source; const before=(this.reader as any)?.getStats?.().bytesLoaded??0;this.resumeAfterBuffer=wasPlaying;this.setStatus("buffering");this.setBuffering(true);this.frames=[];this.audioChunks=[];this.queuedThroughFrame=-1;await Promise.all([this.fillStreaming(this.requestedFrame,controller.signal,loadGeneration,generation,this.seekStartFrame),this.fillStreamingAudio(this.pausedAt,controller.signal,loadGeneration,generation)]);if(!isCurrent())return; this.seekReadBytes=Math.max(0,Number((this.reader as any)?.getStats?.().bytesLoaded??0)-Number(before));} const displayed=this.drawAt(this.pausedAt,true); if(!displayed||displayed.mediaFrame!==this.requestedFrame)throw new Error(`Requested frame ${this.requestedFrame} was not decoded`); this.actualDisplayedFrame=displayed.mediaFrame; this.seekElapsedMs=performance.now()-seekStarted; this.emitTime(this.pausedAt);if(wasPlaying){if(this.mode==="streaming")this.resetAndScheduleStreamingAudio(this.pausedAt);else this.startAudio(this.pausedAt);await this.audio?.resume();const delay=this.mode==="streaming"&&this.audio&&this.audioContextAnchor!==undefined?Math.max(0,this.audioContextAnchor-this.audio.currentTime)*1000:0;this.startedAt=performance.now()+delay-this.pausedAt*1000;this.setStatus("playing");this.tick();}else if(this.mode==="streaming")this.setStatus("paused"); } catch(error){if((error as Error).name==="AbortError"||!isCurrent())return;const failure=error instanceof Error?error:new Error(String(error));this.failStreaming(failure);if(strict)throw failure;return;} finally { if(isCurrent()){this.setBuffering(false);this.callbacks.seeking?.(false);} } }
  async seekTimecode(value:string):Promise<void>{ if(!this.timecodeInfo) throw new Error("timecode-track-unavailable"); this.requestedTimecode=null; const fps=this.essenceIndex?.frameRate??this.timecodeInfo.editRateNumerator/this.timecodeInfo.editRateDenominator,maxFrames=Math.ceil(this.durationValue*fps); const frame=timecodeToMediaFrame({...this.timecodeInfo,durationFrames:this.timecodeInfo.durationFrames===undefined?maxFrames:Math.min(this.timecodeInfo.durationFrames,maxFrames)},value), expectedGeneration=this.seekGeneration+1; await this.seek(frame/fps,true); if(expectedGeneration!==this.seekGeneration||this.destroyed)return; this.requestedTimecode=value; this.requestedFrame=frame; this.publishDiagnostics(); }
  private emitTime(t:number){this.callbacks.time(t);this.callbacks.timecode?.(this.timecodeInfo ? timecodeAtSeconds(this.timecodeInfo,t) : null);}
  private drawAt(t:number,exact=false):RenderFrame|undefined{const requested=Math.round(t*(this.essenceIndex?.frameRate??XDCAM_FRAME_RATE));const f=this.mode==="streaming"?(exact?this.frames.find(item=>item.mediaFrame===requested):[...this.frames].reverse().find(item=>item.time<=t+.001)):this.frames[Math.min(this.frames.length-1,Math.floor(t*XDCAM_FRAME_RATE))];if(f)this.renderer.draw(f.frame,f.frame.width,f.frame.height);return f;}
  private tick():void{if(this.destroyed||this.status!=="playing")return;const t=this.currentTime;if(this.mode==="streaming"){this.frames=this.frames.filter(f=>f.time>=t-this.retainBehindSeconds);this.audioChunks=(this.audioChunks??[]).filter(chunk=>chunk.mediaEndTime>=t-.1);this.scheduledAudio=(this.scheduledAudio??[]).filter(range=>!range.ended&&range.mediaEndTime>=t-.1);if(this.streamAtEnd(t)){this.finishEnded();return;}const hasFuture=this.frames.some(frame=>frame.time>=t),hasAudio=this.audioReadyAt(t);if((!hasFuture||!hasAudio)&&t<this.durationValue){this.pausedAt=Math.min(t,this.durationValue);this.resumeAfterBuffer=true;cancelAnimationFrame(this.raf);this.raf=0;this.stopStreamingAudioSources();void this.audio?.suspend();this.setStatus("buffering");this.setBuffering(true);this.requestFill(this.pausedAt,true);this.requestAudioFill(this.pausedAt);return;}this.requestFill(t);this.requestAudioFill(t);}this.drawAt(t);this.emitTime(t);if(t>=this.durationValue){this.finishEnded();return;}this.raf=requestAnimationFrame(()=>this.tick());}
  destroy():void{this.destroyed=true;this.loadGeneration++;this.seekGeneration++;this.abortFill();this.setBuffering(false);this.loadController?.abort();this.seekController?.abort();cancelAnimationFrame(this.raf);this.raf=0;this.stopAudioSource();this.releaseReader();void this.audio?.close();this.audio=undefined;this.audioChunks=[];this.scheduledAudio=[];this.audioMediaAnchor=undefined;this.audioContextAnchor=undefined;this.frames=[];}
}
