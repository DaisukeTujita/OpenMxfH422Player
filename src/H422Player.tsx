import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { PlayerEngine } from "./engine";
import type { H422PlayerHandle, H422PlayerProps } from "./types";

export const H422Player = forwardRef<H422PlayerHandle,H422PlayerProps>(function H422Player({src,autoPlay=false,controls=true,muted=false,libavBase="/libav",className,onReady,onTimeUpdate,onStatusChange,onError},ref){
  const canvas=useRef<HTMLCanvasElement>(null), engine=useRef<PlayerEngine|null>(null); const [playing,setPlaying]=useState(false); const [time,setTime]=useState(0); const [duration,setDuration]=useState(0);
  useEffect(()=>{if(!canvas.current)return;const e=new PlayerEngine(canvas.current,{status:s=>{setPlaying(s==="playing");onStatusChange?.(s);},ready:i=>{setDuration(i.duration);onReady?.(i);if(autoPlay)void e.play();},time:t=>{setTime(t);onTimeUpdate?.(t);},error:x=>onError?.(x)},muted,libavBase);engine.current=e;void e.load(src).catch(()=>{});return()=>e.destroy();},[src,muted,libavBase]);
  useImperativeHandle(ref,()=>({play:()=>engine.current?.play()??Promise.resolve(),pause:()=>engine.current?.pause(),seek:t=>engine.current?.seek(t)??Promise.resolve(),get currentTime(){return engine.current?.currentTime??0},get duration(){return engine.current?.duration??0}}),[]);
  return <div className={className} style={{background:"#000",display:"inline-block"}}><canvas ref={canvas} style={{display:"block",maxWidth:"100%"}} />{controls&&<div style={{display:"flex",gap:8,padding:8}}><button type="button" onClick={()=>playing?engine.current?.pause():void engine.current?.play()}>{playing?"Pause":"Play"}</button><input aria-label="Seek" type="range" min={0} max={duration||0} step="any" value={time} onChange={e=>void engine.current?.seek(Number(e.target.value))} style={{flex:1}}/><span style={{color:"white"}}>{time.toFixed(1)} / {duration.toFixed(1)}</span></div>}</div>;
});
