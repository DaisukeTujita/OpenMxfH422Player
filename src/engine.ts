import { parseMxf } from "./mxf";
import { parseMxfMetadata } from "./mxf-metadata";
import { pcmS24beToFloat32, XDCAM_FRAME_RATE, yuv422pToRgba } from "./media";
import { timecodeAtSeconds, type MxfTimecodeInfo } from "./timecode";
import type { PlayerInfo, PlayerStatus } from "./types";
import { WebGlRenderer } from "./webgl";

interface Callbacks { status(s: PlayerStatus): void; ready(i: PlayerInfo): void; time(t: number): void; error(e: Error): void; mediaInfo?(i: import("./mxf-metadata").MxfMediaInfo): void; timecode?(value: string | null): void; seeking?(value: boolean): void }
type LibAV = Record<string, any>;
type DecodedFrame = { data?: Uint8Array; layout?: Array<{offset:number; stride:number}>; width: number; height: number; format?: number; pts?: number };

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
  constructor(canvas: HTMLCanvasElement, private callbacks: Callbacks, private muted=false, private libavBase="/libav") { this.renderer=new WebGlRenderer(canvas); }
  get currentTime(): number { return this.status === "playing" ? Math.min(this.durationValue,(performance.now()-this.startedAt)/1000) : this.pausedAt; }
  get duration(): number { return this.durationValue; }
  private setStatus(s: PlayerStatus) { this.status=s; this.callbacks.status(s); }
  async load(source: File|Blob|string): Promise<void> {
    this.setStatus("loading");
    try {
      const blob=typeof source === "string" ? await fetch(source).then(r=>{if(!r.ok)throw new Error(`MXF request failed (${r.status})`);return r.blob();}) : source;
      const bytes=new Uint8Array(await blob.arrayBuffer());
      const metadata=parseMxfMetadata(bytes); this.callbacks.mediaInfo?.(metadata.mediaInfo);
      this.timecodeInfo=metadata.timecodes.find(value=>value.editRateNumerator>0&&value.editRateDenominator>0);
      this.callbacks.timecode?.(this.timecodeInfo ? timecodeAtSeconds(this.timecodeInfo,0) : null);
      const parsed=parseMxf(bytes);
      console.info(`[H422Player] video codec_id=${parsed.videoCodec.codecId} codec_name=${parsed.videoCodec.codecName}`);
      if (parsed.audioCodec) console.info(`[H422Player] audio codec_id=${parsed.audioCodec.codecId} codec_name=${parsed.audioCodec.codecName}`);
      this.libav=await loadCustomLibAV(this.libavBase);
      if (await this.libav.libavjs_with_swscale?.() !== 1) throw new Error("Custom libav.js was built without swscale");
      const video=parsed.packets.filter(p=>p.kind==="video"); const audio=parsed.packets.filter(p=>p.kind==="audio");
      await this.decodeVideo(video.map(p=>p.data), parsed.videoCodec.codecId);
      if (audio.length && !this.muted) await this.preparePcm(audio.map(p=>p.data));
      this.durationValue=this.frames.length/XDCAM_FRAME_RATE;
      const first=this.frames[0]; if (!first) throw new Error("The MPEG-2 decoder returned no frames");
      this.renderer.draw(first.frame,first.frame.width,first.frame.height);
      this.callbacks.ready({width:first.frame.width,height:first.frame.height,frameRate:XDCAM_FRAME_RATE,duration:this.durationValue,audioSampleRate:48000,audioChannels:audio.length?2:0});
      this.setStatus("ready");
    } catch (e) { const error=e instanceof Error?e:new Error(String(e)); this.setStatus("error"); this.callbacks.error(error); throw error; }
  }
  private async decodeVideo(chunks: Uint8Array[], codecId: number): Promise<void> {
    const av=this.libav!;
    // ff_init_decoder receives the codec_id detected for the MXF essence (AV_CODEC_ID_MPEG2VIDEO=2).
    const [,ctx,pkt,frame]=await av.ff_init_decoder(codecId);
    let decodeFailure: { error: unknown }|undefined;
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
        this.frames.push({frame:new ImageData(new Uint8ClampedArray(rgba),f.width,f.height),time:i/XDCAM_FRAME_RATE});
      }
    } catch (error) {
      decodeFailure={error};
    }
    try { await av.ff_free_decoder(ctx,pkt,frame); }
    catch (error) { if (!decodeFailure) throw error; }
    if (decodeFailure) throw decodeFailure.error;
  }
  private async preparePcm(chunks: Uint8Array[]): Promise<void> {
    this.audio=new AudioContext({sampleRate:48000});
    const bytes=chunks.reduce((n,c)=>n+c.length,0), joined=new Uint8Array(bytes); let at=0;
    for(const c of chunks){joined.set(c,at);at+=c.length;}
    const channels=pcmS24beToFloat32(joined,2); this.audioBuffer=this.audio.createBuffer(2,channels[0].length,48000);
    channels.forEach((samples,index)=>this.audioBuffer!.copyToChannel(new Float32Array(samples),index)); await this.audio.suspend();
  }
  private startAudio(offset:number):void { if(!this.audio||!this.audioBuffer)return; this.audioSource?.stop(); const node=this.audio.createBufferSource(); node.buffer=this.audioBuffer; node.connect(this.audio.destination); node.start(0,Math.min(offset,this.audioBuffer.duration)); this.audioSource=node; }
  async play(): Promise<void> { if(this.status==="playing")return; this.startAudio(this.pausedAt); await this.audio?.resume(); this.startedAt=performance.now()-this.pausedAt*1000; this.setStatus("playing"); this.tick(); }
  pause(): void { if(this.status!=="playing")return; this.pausedAt=this.currentTime; this.audioSource?.stop(); this.audioSource=undefined; void this.audio?.suspend(); cancelAnimationFrame(this.raf); this.setStatus("paused"); }
  async seek(seconds:number): Promise<void> { this.callbacks.seeking?.(true); try { this.pausedAt=Math.max(0,Math.min(this.durationValue,seconds)); if(this.status==="playing"){this.startedAt=performance.now()-this.pausedAt*1000;this.startAudio(this.pausedAt);} this.drawAt(this.pausedAt); this.emitTime(this.pausedAt); } finally { this.callbacks.seeking?.(false); } }
  private emitTime(t:number){this.callbacks.time(t);this.callbacks.timecode?.(this.timecodeInfo ? timecodeAtSeconds(this.timecodeInfo,t) : null);}
  private drawAt(t:number){const f=this.frames[Math.min(this.frames.length-1,Math.floor(t*XDCAM_FRAME_RATE))];if(f)this.renderer.draw(f.frame,f.frame.width,f.frame.height);}
  private tick=()=>{const t=this.currentTime;this.drawAt(t);this.emitTime(t);if(t>=this.durationValue){this.pausedAt=t;this.setStatus("ended");return;}this.raf=requestAnimationFrame(this.tick);};
  destroy():void{cancelAnimationFrame(this.raf);this.audioSource?.stop();void this.audio?.close();this.frames=[];}
}
