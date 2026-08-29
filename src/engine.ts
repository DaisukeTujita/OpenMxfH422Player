import LibAV from "@libav.js/variant-webcodecs";
import { parseMxf } from "./mxf";
import type { PlayerInfo, PlayerStatus } from "./types";
import { WebGlRenderer } from "./webgl";

interface Callbacks { status(s: PlayerStatus): void; ready(i: PlayerInfo): void; time(t: number): void; error(e: Error): void }
type LibAV = Record<string, (...args: any[]) => Promise<any>>;

export class PlayerEngine {
  private libav?: LibAV; private renderer: WebGlRenderer; private audio?: AudioContext;
  private status: PlayerStatus="idle"; private startedAt=0; private pausedAt=0; private durationValue=0;
  private frames: Array<{frame: ImageData; time: number}>=[]; private raf=0;
  constructor(canvas: HTMLCanvasElement, private callbacks: Callbacks, private muted=false, private libavBase="/libav") { this.renderer=new WebGlRenderer(canvas); }
  get currentTime(): number { return this.status === "playing" ? Math.min(this.durationValue,(performance.now()-this.startedAt)/1000) : this.pausedAt; }
  get duration(): number { return this.durationValue; }
  private setStatus(s: PlayerStatus) { this.status=s; this.callbacks.status(s); }
  async load(source: File|Blob|string): Promise<void> {
    this.setStatus("loading");
    try {
      const blob=typeof source === "string" ? await fetch(source).then(r=>{if(!r.ok)throw new Error(`MXF request failed (${r.status})`);return r.blob();}) : source;
      const parsed=parseMxf(new Uint8Array(await blob.arrayBuffer()));
      this.libav=await LibAV.LibAV({base:this.libavBase.replace(/\/$/, ""),noworker:false}) as unknown as LibAV;
      const video=parsed.packets.filter(p=>p.kind==="video");
      const audio=parsed.packets.filter(p=>p.kind==="audio");
      await this.decodeVideo(video.map(p=>p.data));
      if (audio.length && !this.muted) await this.queuePcm(audio.map(p=>p.data));
      const frameRate=25; this.durationValue=this.frames.length/frameRate;
      const first=this.frames[0]; if (!first) throw new Error("The MPEG-2 decoder returned no frames");
      this.renderer.draw(first.frame,first.frame.width,first.frame.height);
      this.callbacks.ready({width:first.frame.width,height:first.frame.height,frameRate,duration:this.durationValue,audioSampleRate:48000,audioChannels:audio.length?2:0});
      this.setStatus("ready");
    } catch (e) { const error=e instanceof Error?e:new Error(String(e)); this.setStatus("error"); this.callbacks.error(error); throw error; }
  }
  private async decodeVideo(chunks: Uint8Array[]): Promise<void> {
    const av=this.libav!; const [codec,ctx,pkt,frame]=await av.ff_init_decoder("mpeg2video");
    const packets=chunks.map((data,i)=>({data,pts:i,time_base_num:1,time_base_den:25}));
    const decoded=await av.ff_decode_multi(ctx,pkt,frame,packets,true);
    for (let i=0;i<decoded.length;i++) {
      const f=decoded[i];
      if (!f.data) continue;
      // variant-webcodecs emits VideoFrame when available, otherwise libavjs ImageData-compatible RGBA.
      if (typeof VideoFrame!=="undefined" && f.data instanceof VideoFrame) {
        const rgba=new Uint8ClampedArray(f.data.displayWidth*f.data.displayHeight*4); await f.data.copyTo(rgba,{format:"RGBA"});
        this.frames.push({frame:new ImageData(rgba,f.data.displayWidth,f.data.displayHeight),time:i/25}); f.data.close();
      } else if (f.data instanceof Uint8ClampedArray) this.frames.push({frame:new ImageData(f.data,f.width,f.height),time:i/25});
    }
    await av.ff_free_decoder(codec,ctx,pkt,frame);
  }
  private async queuePcm(chunks: Uint8Array[]): Promise<void> {
    this.audio=new AudioContext({sampleRate:48000});
    const bytes=chunks.reduce((n,c)=>n+c.length,0), joined=new Uint8Array(bytes); let at=0;
    for(const c of chunks){joined.set(c,at);at+=c.length;}
    const samples=Math.floor(joined.length/4), buffer=this.audio.createBuffer(2,samples,48000), view=new DataView(joined.buffer,joined.byteOffset,joined.byteLength);
    for(let i=0;i<samples;i++) for(let ch=0;ch<2;ch++) buffer.getChannelData(ch)[i]=view.getInt16((i*2+ch)*2,false)/32768;
    const node=this.audio.createBufferSource(); node.buffer=buffer; node.connect(this.audio.destination); node.start(0); await this.audio.suspend();
  }
  async play(): Promise<void> { if(this.status==="playing")return; await this.audio?.resume(); this.startedAt=performance.now()-this.pausedAt*1000; this.setStatus("playing"); this.tick(); }
  pause(): void { if(this.status!=="playing")return; this.pausedAt=this.currentTime; void this.audio?.suspend(); cancelAnimationFrame(this.raf); this.setStatus("paused"); }
  async seek(seconds:number): Promise<void> { this.pausedAt=Math.max(0,Math.min(this.durationValue,seconds)); if(this.status==="playing")this.startedAt=performance.now()-this.pausedAt*1000; this.drawAt(this.pausedAt); }
  private drawAt(t:number){const f=this.frames[Math.min(this.frames.length-1,Math.floor(t*25))];if(f)this.renderer.draw(f.frame,f.frame.width,f.frame.height);}
  private tick=()=>{const t=this.currentTime;this.drawAt(t);this.callbacks.time(t);if(t>=this.durationValue){this.pausedAt=t;this.setStatus("ended");return;}this.raf=requestAnimationFrame(this.tick);};
  destroy():void{cancelAnimationFrame(this.raf);void this.audio?.close();this.frames=[];}
}
