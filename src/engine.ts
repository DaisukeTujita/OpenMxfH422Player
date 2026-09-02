import { parseMxf, type ParsedMxf } from "./mxf";
import { parseMxfMetadataFromReader } from "./mxf-reader";
import { FileRandomAccessReader, type RandomAccessReader } from "./random-access-reader";
import { pcmS24beToFloat32, XDCAM_FRAME_RATE, yuv422pToRgba } from "./media";
import { timecodeAtSeconds, type MxfTimecodeInfo } from "./timecode";
import type { PlayerInfo, PlayerStatus } from "./types";
import { WebGlRenderer } from "./webgl";
import { indexMxfEssence, readEssenceRange, type EssenceIndex } from "./essence-reader";
import type { PlaybackMode, PlayerDiagnostics } from "./types";

interface Callbacks { status(s: PlayerStatus): void; ready(i: PlayerInfo): void; time(t: number): void; error(e: Error): void; mediaInfo?(i: import("./mxf-metadata").MxfMediaInfo): void; timecode?(value: string | null): void; seeking?(value: boolean): void; buffering?(value:boolean):void; diagnostics?(value:PlayerDiagnostics):void }
type LibAV = Record<string, any>;
type DecodedFrame = { data?: Uint8Array; layout?: Array<{offset:number; stride:number}>; width: number; height: number; format?: number; pts?: number };
type RenderFrame = {frame: ImageData; time: number};
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
  if (timecodes.length > 1) logger.warn(`[H422Player] multiple Timecode Tracks detected (${timecodes.length}); selecting the first usable track in KLV discovery order`);
  const selected = timecodes.find(value => value.editRateNumerator > 0 && value.editRateDenominator > 0);
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
  private frames: Array<{frame: ImageData; time: number}>=[]; private raf=0;
  private timecodeInfo?: MxfTimecodeInfo;
  private loadController?: AbortController; private destroyed=false; private loadGeneration=0;
  private seekController?: AbortController; private seekGeneration=0;
  private reader?: RandomAccessReader & {destroy():void}; private essenceIndex?:EssenceIndex; private mode:PlaybackMode;
  private fileSize=0; private filling?:Promise<void>; private fillController?:AbortController; private queuedThroughFrame=-1; private videoCodecId=2;
  private buffering=false; private resumeAfterBuffer=false;
  private streamingAudioSupported=false; private selectedAudioTrackNumber?:number; private audioSampleRate?:number; private audioChannels?:number;
  private audioChunks:StreamingAudioChunk[]=[]; private scheduledAudio:ScheduledAudio[]=[]; private audioBytesLoaded=0; private audioFillController?:AbortController; private audioFilling?:Promise<void>;
  private destroyedReaders?:WeakSet<object>;
  private readonly videoAheadSeconds:number; private readonly retainBehindSeconds:number; private readonly refillThresholdSeconds:number; private readonly chunkSeconds:number; private readonly maxReadSize:number;
  private readonly dependencies: PlayerEngineDependencies;
  constructor(canvas: HTMLCanvasElement, private callbacks: Callbacks, private muted=false, private libavBase="/libav", dependencies: Partial<PlayerEngineDependencies>={}, options:PlayerEngineOptions={}) { this.renderer=new WebGlRenderer(canvas);this.dependencies={...defaultDependencies,...dependencies};this.mode=options.mode??"legacy";this.videoAheadSeconds=options.videoAheadSeconds??4;this.retainBehindSeconds=options.retainBehindSeconds??1;this.refillThresholdSeconds=options.refillThresholdSeconds??2;this.chunkSeconds=options.chunkSeconds??3;this.maxReadSize=options.maxReadSize??4*1024*1024; }
  get currentTime(): number { return this.status === "playing" ? Math.min(this.durationValue,(performance.now()-this.startedAt)/1000) : this.pausedAt; }
  get duration(): number { return this.durationValue; }
  private setStatus(s: PlayerStatus) { this.status=s; this.callbacks.status(s); }
  getDiagnostics():PlayerDiagnostics { const stats=(this.reader as any)?.getStats?.()??{};const active=this.audio&&this.scheduledAudio.find(range=>range.contextStartTime<=this.audio!.currentTime&&range.contextStartTime+range.mediaEndTime-range.mediaStartTime>=this.audio!.currentTime);const audioTime=active&&this.audio?active.mediaStartTime+this.audio.currentTime-active.contextStartTime:null;return {mode:this.mode,fileSize:this.fileSize,bytesLoaded:Number(stats.bytesLoaded??0),underlyingReadCount:stats.underlyingReadCount??0,cacheBytes:stats.cachedBytes??0,videoQueueFrames:this.frames.length,videoQueueStart:this.frames[0]?.time??null,videoQueueEnd:this.frames.at(-1)?.time??null,scheduledAudioRanges:this.mode==="streaming"?this.scheduledAudio.length:(this.audioSource?1:0),loadGeneration:this.loadGeneration,seekGeneration:this.seekGeneration,streamingAudioSupported:this.streamingAudioSupported,selectedAudioTrackNumber:this.selectedAudioTrackNumber??null,audioSampleRate:this.audioSampleRate??null,audioChannels:this.audioChannels??null,audioQueueStart:this.audioChunks?.[0]?.mediaStartTime??null,audioQueueEnd:this.audioChunks?.at(-1)?.mediaEndTime??null,audioVideoDriftMs:audioTime===null?null:(audioTime-this.currentTime)*1000,audioBytesLoaded:this.audioBytesLoaded}; }
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
    this.stopAudioSource(); this.abortFill();this.setBuffering(false); this.releaseReader(); this.seekController?.abort(); this.seekGeneration++;
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
      if(this.mode==="streaming") {
        if(metadata.mediaInfo.operationalPattern!=="OP1a")throw new Error("Streaming requires an MXF OP1a Partition Pack");
        const descriptor=metadata.mediaInfo.video;if(!descriptor?.width||!descriptor.height||!metadata.mediaInfo.essenceContainer)throw new Error("Streaming requires an identifiable XDCAM HD422 picture and Essence Container descriptor");
        if(!([[1920,1080],[1280,720]] as const).some(([width,height])=>descriptor.width===width&&descriptor.height===height))throw new Error(`Streaming does not support the ${descriptor.width}x${descriptor.height} picture descriptor`);
        this.reader=reader; const frameRate=metadata.mediaInfo.editRateNumerator&&metadata.mediaInfo.editRateDenominator?metadata.mediaInfo.editRateNumerator/metadata.mediaInfo.editRateDenominator:XDCAM_FRAME_RATE;
        this.essenceIndex=await this.dependencies.indexEssence(reader,{partitions:metadata.partitions,indexTables:metadata.indexTables,frameRate,signal}); if(!current())return;
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
  private async fillStreaming(startFrame:number,signal:AbortSignal,loadGeneration:number,seekGeneration=this.seekGeneration):Promise<boolean>{if(!this.reader||!this.essenceIndex||!this.libav)return false;const current=()=>!signal.aborted&&!this.destroyed&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration;const fps=this.essenceIndex.frameRate,end=Math.min(Math.ceil(this.durationValue*fps)-1,startFrame+Math.ceil(this.chunkSeconds*fps)-1);if(end<=this.queuedThroughFrame&&startFrame>=0)return current();const packets=await this.dependencies.readRange(this.reader,this.essenceIndex,{startFrame,endFrame:end,signal,maxReadSize:this.maxReadSize,kinds:["video"]});if(!current())return false;const video=packets.filter(p=>p.kind==="video");if(startFrame===0){const first=video[0]?.data;let sequence=false;if(first)for(let i=0;i+3<Math.min(first.length,256);i++)if(first[i]===0&&first[i+1]===0&&first[i+2]===1&&first[i+3]===0xb3){sequence=true;break;}if(!sequence)throw new Error("Streaming requires XDCAM HD422 MPEG-2 sequence-header essence");}const decoded=await this.decodeVideo(video.map(p=>p.data),this.videoCodecId,this.libav);if(!current())return false;const firstEdit=video[0]?.editUnit??startFrame;const wanted=decoded.map((item,i)=>({...item,time:(firstEdit+i)/fps})).filter(item=>item.time>=startFrame/fps&&item.time<=(end+1)/fps);if(!current())return false;const existing=new Set(this.frames.map(f=>Math.round(f.time*fps)));for(const item of wanted)if(!existing.has(Math.round(item.time*fps)))this.frames.push(item);this.frames.sort((a,b)=>a.time-b.time);this.queuedThroughFrame=Math.max(this.queuedThroughFrame,end);this.publishDiagnostics();return true;}
  private requestFill(t:number,force=false){if(this.mode!=="streaming"||!this.essenceIndex||this.filling||this.streamExhausted())return;const fps=this.essenceIndex.frameRate,ahead=(this.frames.at(-1)?.time??t)-t;if(!force&&ahead>=this.refillThresholdSeconds)return;const controller=new AbortController();this.fillController=controller;const loadGeneration=this.loadGeneration,seekGeneration=this.seekGeneration,start=Math.max(Math.floor(t*fps),this.queuedThroughFrame+1);const promise=this.fillStreaming(start,controller.signal,loadGeneration,seekGeneration).then(applied=>{if(!applied||controller.signal.aborted||this.filling!==promise)return;const remaining=(this.frames.at(-1)?.time??t)-t;if(remaining<this.videoAheadSeconds&&!this.streamExhausted()){this.filling=undefined;this.fillController=undefined;this.requestFill(t,true);return;}if(this.buffering){if(this.streamAtEnd(this.pausedAt)){this.finishEnded();return;}this.drawAt(this.pausedAt);const resume=this.resumeAfterBuffer;this.setBuffering(false);if(resume){this.scheduleStreamingAudio(this.pausedAt);void this.audio?.resume();this.startedAt=performance.now()-this.pausedAt*1000;this.setStatus("playing");this.tick();}}}).catch(e=>{if((e as Error).name!=="AbortError"&&this.filling===promise&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration&&!this.destroyed)this.failStreaming(e instanceof Error?e:new Error(String(e)));}).finally(()=>{if(this.filling===promise){this.filling=undefined;if(this.fillController===controller)this.fillController=undefined;}});this.filling=promise;}
  private async decodeVideo(chunks: Uint8Array[], codecId: number, av: LibAV=this.libav!): Promise<RenderFrame[]> {
    // ff_init_decoder receives the codec_id detected for the MXF essence (AV_CODEC_ID_MPEG2VIDEO=2).
    const [,ctx,pkt,frame]=await av.ff_init_decoder(codecId);
    let decodeFailure: { error: unknown }|undefined; const frames: RenderFrame[]=[];
    try {
      const packets=chunks.map((data,i)=>({data,pts:i,time_base_num:1001,time_base_den:30000}));
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
        frames.push({frame:new ImageData(new Uint8ClampedArray(rgba),f.width,f.height),time:i/XDCAM_FRAME_RATE});
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
    this.stopStreamingAudioSources();this.audioChunks=[];this.audioBytesLoaded=0;this.streamingAudioSupported=false;this.selectedAudioTrackNumber=undefined;
    const tracks=[...new Set(this.essenceIndex?.packets.filter(packet=>packet.kind==="audio").map(packet=>packet.trackNumber)??[])];
    if(!tracks.length){console.info("[H422Player] streaming audio: no audio essence; video-only playback");return;}
    const descriptor=info.audio;
    if(descriptor?.sampleRate!==48000||descriptor.channels!==2||descriptor.bitsPerSample!==24){console.warn(`[H422Player] streaming audio unsupported; video-only playback (requires PCM S24BE 48000 Hz stereo; descriptor=${descriptor?.sampleRate??"unknown"} Hz/${descriptor?.channels??"unknown"} ch/${descriptor?.bitsPerSample??"unknown"} bit)`);return;}
    if(this.muted){console.info("[H422Player] streaming audio disabled because the player is muted");return;}
    this.selectedAudioTrackNumber=tracks[0];const first=this.essenceIndex?.packets.find(packet=>packet.kind==="audio"&&packet.trackNumber===tracks[0]);console.info(`[H422Player] selected audio essence: trackNumber=${tracks[0]} BodySID=${first?.bodySID??"unknown"} editUnit=${first?.editUnit??"unknown"} presentationTime=${first?.presentationTime??"unknown"} valueOffset=${first?.valueOffset?.toString()??"unknown"} valueLength=${first?.valueLength?.toString()??"unknown"}`);this.audioSampleRate=48000;this.audioChannels=2;this.streamingAudioSupported=true;this.audio=new AudioContext({sampleRate:48000});void this.audio.suspend();
    console.info(`[H422Player] streaming audio supported: trackNumber=${tracks[0]} (first stereo track in KLV discovery order), PCM S24BE, 48000 Hz, 2 ch, QuantizationBits=24, BlockAlign=6, byteOrder=big-endian`);
  }
  private async fillStreamingAudio(mediaTime:number,signal:AbortSignal,loadGeneration:number,seekGeneration:number):Promise<boolean>{
    if(!this.streamingAudioSupported||!this.reader||!this.essenceIndex||!this.audio)return true;const current=()=>!signal.aborted&&!this.destroyed&&loadGeneration===this.loadGeneration&&seekGeneration===this.seekGeneration;
    const fps=this.essenceIndex.frameRate,startFrame=Math.max(0,Math.floor(mediaTime*fps)),endFrame=Math.min(Math.ceil(this.durationValue*fps)-1,startFrame+Math.ceil(3*fps)-1);
    const packets=await this.dependencies.readRange(this.reader,this.essenceIndex,{startFrame,endFrame,prerollFrames:0,signal,maxReadSize:this.maxReadSize,kinds:["audio"],trackNumbers:[this.selectedAudioTrackNumber!]});if(!current())return false;
    const fresh:StreamingAudioChunk[]=[];let group:typeof packets=[],groupStart=0;const flush=()=>{if(!group.length)return;let bytes=group.reduce((sum,p)=>sum+p.data.length,0),skip=0;const packetStart=group[0].editUnit/fps;if(mediaTime>packetStart)skip=Math.floor((mediaTime-packetStart)*48000)*6;skip=Math.min(bytes,skip-skip%6);bytes-=skip;bytes-=bytes%6;if(bytes<=0){group=[];return;}const joined=new Uint8Array(bytes);let at=0,sourceAt=skip;for(const packet of group){const available=packet.data.length-sourceAt;if(available>0){const take=Math.min(available,bytes-at);joined.set(packet.data.subarray(sourceAt,sourceAt+take),at);at+=take;}sourceAt=0;if(at===bytes)break;}const channels=pcmS24beToFloat32(joined,2),buffer=this.audio!.createBuffer(2,channels[0].length,48000);channels.forEach((samples,index)=>buffer.copyToChannel(new Float32Array(samples),index));const start=Math.max(mediaTime,packetStart),end=Math.min(this.durationValue,start+buffer.duration);fresh.push({mediaStartTime:start,mediaEndTime:end,buffer,generation:seekGeneration,scheduled:false});group=[];};
    for(const packet of packets){if(!group.length)groupStart=packet.presentationTime;group.push(packet);if(packet.presentationTime+1/fps-groupStart>=.75)flush();}flush();if(!current())return false;this.audioBytesLoaded+=packets.reduce((sum,p)=>sum+p.data.length,0);const known=new Set(this.audioChunks.map(chunk=>chunk.mediaStartTime.toFixed(6)));for(const chunk of fresh)if(!known.has(chunk.mediaStartTime.toFixed(6)))this.audioChunks.push(chunk);this.audioChunks.sort((a,b)=>a.mediaStartTime-b.mediaStartTime);this.publishDiagnostics();return true;
  }
  private stopStreamingAudioSources():void{for(const range of this.scheduledAudio??[]){try{range.sourceNode.stop();}catch{/* already stopped */}try{range.sourceNode.disconnect();}catch{/* disconnected */}range.ended=true;}this.scheduledAudio=[];for(const chunk of this.audioChunks??[])chunk.scheduled=false;}
  private scheduleStreamingAudio(mediaTime:number):void{if(!this.streamingAudioSupported||!this.audio)return;this.stopStreamingAudioSources();let contextAt=this.audio.currentTime+.03;for(const chunk of this.audioChunks){if(chunk.generation!==this.seekGeneration||chunk.mediaEndTime<=mediaTime||chunk.mediaStartTime>=this.durationValue)continue;const offset=Math.max(0,mediaTime-chunk.mediaStartTime),duration=Math.min(chunk.mediaEndTime,this.durationValue)-chunk.mediaStartTime-offset;if(duration<=0)continue;const node=this.audio.createBufferSource();node.buffer=chunk.buffer;node.connect(this.audio.destination);const range:ScheduledAudio={mediaStartTime:chunk.mediaStartTime+offset,mediaEndTime:chunk.mediaStartTime+offset+duration,contextStartTime:contextAt,sourceNode:node,generation:this.seekGeneration,started:true,ended:false};node.onended=()=>{range.ended=true;try{node.disconnect();}catch{/* harmless */}};node.start(contextAt,offset,duration);chunk.scheduled=true;this.scheduledAudio.push(range);contextAt+=duration;}}
  private requestAudioFill(t:number):void{if(!this.streamingAudioSupported||this.audioFilling)return;const end=this.audioChunks?.at(-1)?.mediaEndTime??t;if(end-t>=1.25||end>=this.durationValue)return;const controller=new AbortController();this.audioFillController=controller;const load=this.loadGeneration,seek=this.seekGeneration;const promise=this.fillStreamingAudio(end,controller.signal,load,seek).then(applied=>{if(!applied)return;if(this.status==="playing")this.scheduleStreamingAudio(t);else if(this.buffering&&this.frames.some(frame=>frame.time>=this.pausedAt)){this.drawAt(this.pausedAt);const resume=this.resumeAfterBuffer;this.setBuffering(false);if(resume){this.scheduleStreamingAudio(this.pausedAt);void this.audio?.resume();this.startedAt=performance.now()-this.pausedAt*1000;this.setStatus("playing");this.tick();}}}).catch(error=>{if((error as Error).name!=="AbortError"&&load===this.loadGeneration&&seek===this.seekGeneration)this.failStreaming(error instanceof Error?error:new Error(String(error)));}).finally(()=>{if(this.audioFilling===promise){this.audioFilling=undefined;this.audioFillController=undefined;}});this.audioFilling=promise;}
  private async preparePcm(chunks: Uint8Array[]): Promise<{audio:AudioContext;audioBuffer:AudioBuffer}> {
    const audio=new AudioContext({sampleRate:48000});
    const bytes=chunks.reduce((n,c)=>n+c.length,0), joined=new Uint8Array(bytes); let at=0;
    for(const c of chunks){joined.set(c,at);at+=c.length;}
    const channels=pcmS24beToFloat32(joined,2), audioBuffer=audio.createBuffer(2,channels[0].length,48000);
    channels.forEach((samples,index)=>audioBuffer.copyToChannel(new Float32Array(samples),index)); await audio.suspend(); return {audio,audioBuffer};
  }
  private stopAudioSource():void { this.stopStreamingAudioSources();const source=this.audioSource;this.audioSource=undefined;if(!source)return;try{source.stop();}catch{/* An AudioBufferSourceNode can only be stopped once on some implementations. */}try{source.disconnect();}catch{/* A disconnected node is already harmless. */} }
  private startAudio(offset:number):void { if(!this.audio||!this.audioBuffer)return; this.stopAudioSource(); const node=this.audio.createBufferSource(); node.buffer=this.audioBuffer; node.connect(this.audio.destination); node.start(0,Math.min(offset,this.audioBuffer.duration)); this.audioSource=node; }
  async play(): Promise<void> { if(this.status==="playing")return;if(this.status==="buffering"){this.resumeAfterBuffer=true;return;} if(this.mode==="streaming")this.scheduleStreamingAudio(this.pausedAt);else this.startAudio(this.pausedAt); await this.audio?.resume(); this.startedAt=performance.now()-this.pausedAt*1000; this.setStatus("playing"); this.tick(); }
  pause(): void { if(this.status!=="playing"&&this.status!=="buffering")return;if(this.status==="playing")this.pausedAt=this.currentTime;this.resumeAfterBuffer=false;this.abortFill();this.setBuffering(false); this.stopAudioSource(); void this.audio?.suspend(); cancelAnimationFrame(this.raf);this.raf=0; this.setStatus("paused"); }
  async seek(seconds:number): Promise<void> { const wasPlaying=this.status==="playing"||this.status==="buffering"&&this.resumeAfterBuffer;if(this.status==="playing")this.pausedAt=this.currentTime;cancelAnimationFrame(this.raf);this.raf=0;this.abortFill();this.stopAudioSource();this.setBuffering(false);this.seekController?.abort();const controller=new AbortController();this.seekController=controller;const generation=++this.seekGeneration,loadGeneration=this.loadGeneration,isCurrent=()=>!controller.signal.aborted&&!this.destroyed&&generation===this.seekGeneration&&loadGeneration===this.loadGeneration;this.callbacks.seeking?.(true); try { if(!isCurrent())return;this.pausedAt=Math.max(0,Math.min(this.durationValue,seconds));if(this.mode==="streaming"&&this.essenceIndex){this.resumeAfterBuffer=wasPlaying;this.setStatus("buffering");this.setBuffering(true);this.frames=[];this.audioChunks=[];this.queuedThroughFrame=-1;await Promise.all([this.fillStreaming(Math.floor(this.pausedAt*this.essenceIndex.frameRate),controller.signal,loadGeneration,generation),this.fillStreamingAudio(this.pausedAt,controller.signal,loadGeneration,generation)]);if(!isCurrent())return;} this.drawAt(this.pausedAt); this.emitTime(this.pausedAt);if(wasPlaying){if(this.mode==="streaming")this.scheduleStreamingAudio(this.pausedAt);else this.startAudio(this.pausedAt);await this.audio?.resume();this.startedAt=performance.now()-this.pausedAt*1000;this.setStatus("playing");this.tick();}else if(this.mode==="streaming")this.setStatus("paused"); } catch(error){if((error as Error).name==="AbortError"||!isCurrent())return;this.failStreaming(error instanceof Error?error:new Error(String(error)));return;} finally { if(isCurrent()){this.setBuffering(false);this.callbacks.seeking?.(false);} } }
  private emitTime(t:number){this.callbacks.time(t);this.callbacks.timecode?.(this.timecodeInfo ? timecodeAtSeconds(this.timecodeInfo,t) : null);}
  private drawAt(t:number){const f=this.mode==="streaming"?[...this.frames].reverse().find(item=>item.time<=t+.001):this.frames[Math.min(this.frames.length-1,Math.floor(t*XDCAM_FRAME_RATE))];if(f)this.renderer.draw(f.frame,f.frame.width,f.frame.height);}
  private tick():void{if(this.destroyed||this.status!=="playing")return;const t=this.currentTime;if(this.mode==="streaming"){this.frames=this.frames.filter(f=>f.time>=t-this.retainBehindSeconds);this.audioChunks=(this.audioChunks??[]).filter(chunk=>chunk.mediaEndTime>=t-.1);this.scheduledAudio=(this.scheduledAudio??[]).filter(range=>!range.ended&&range.mediaEndTime>=t-.1);if(this.streamAtEnd(t)){this.finishEnded();return;}const hasFuture=this.frames.some(frame=>frame.time>=t),hasAudio=!this.streamingAudioSupported||this.audioChunks.some(chunk=>chunk.mediaEndTime>t);if((!hasFuture||!hasAudio)&&t<this.durationValue){this.pausedAt=Math.min(t,this.durationValue);this.resumeAfterBuffer=true;cancelAnimationFrame(this.raf);this.raf=0;this.stopStreamingAudioSources();void this.audio?.suspend();this.setStatus("buffering");this.setBuffering(true);this.requestFill(this.pausedAt,true);this.requestAudioFill(this.pausedAt);return;}this.requestFill(t);this.requestAudioFill(t);}this.drawAt(t);this.emitTime(t);if(t>=this.durationValue){this.finishEnded();return;}this.raf=requestAnimationFrame(()=>this.tick());}
  destroy():void{this.destroyed=true;this.loadGeneration++;this.seekGeneration++;this.abortFill();this.setBuffering(false);this.loadController?.abort();this.seekController?.abort();cancelAnimationFrame(this.raf);this.raf=0;this.stopAudioSource();this.releaseReader();void this.audio?.close();this.frames=[];}
}
