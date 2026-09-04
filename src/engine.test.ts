import { afterEach, describe, expect, it, vi } from "vitest";

import { loadCustomLibAV, PlayerEngine, selectTimecodeTrack } from "./engine";

function moduleUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

describe("loadCustomLibAV", () => {
  afterEach(() => vi.restoreAllMocks());

  it("adds the requested URL to network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unavailable")));

    await expect(loadCustomLibAV("/libav"))
      .rejects.toThrow("Failed to fetch custom libav.js frontend: /libav/libav-h422.mjs (network unavailable)");
  });

  it("reports an HTTP failure with the requested URL and status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404, statusText: "Not Found" })));

    await expect(loadCustomLibAV("/libav/"))
      .rejects.toThrow("Failed to fetch custom libav.js frontend: /libav/libav-h422.mjs (404 Not Found)");
  });

  it("rejects an invalid module and releases its Blob URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("export const invalid = true")));
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue(moduleUrl("export const invalid = true"));
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await expect(loadCustomLibAV("/libav"))
      .rejects.toThrow("Invalid custom libav.js frontend: /libav/libav-h422.mjs");
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe("text/javascript");
    expect(revokeObjectURL).toHaveBeenCalledWith(createObjectURL.mock.results[0].value);
  });

  it("uses the asset base for LibAV and releases the Blob URL after import", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("frontend source")));
    const loadedModule = moduleUrl("export async function LibAV(options) { return { options }; }");
    vi.spyOn(URL, "createObjectURL").mockReturnValue(loadedModule);
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await expect(loadCustomLibAV("/libav/")).resolves.toMatchObject({
      options: { base: "/libav", noworker: false },
    });
    expect(revokeObjectURL).toHaveBeenCalledWith(loadedModule);
  });
});

type DecoderMock = {
  ff_init_decoder: ReturnType<typeof vi.fn>;
  ff_decode_multi: ReturnType<typeof vi.fn>;
  ff_free_decoder: ReturnType<typeof vi.fn>;
};

function decoderHarness(av: DecoderMock) {
  const engine = Object.create(PlayerEngine.prototype) as {
    libav: DecoderMock;
    decodeVideo(chunks: Uint8Array[], codecId: number, av?: DecoderMock, mediaFrames?: number[], frameRate?: number): Promise<Array<{ time: number; mediaFrame: number }>>;
  };
  engine.libav = av;
  return engine;
}

describe("PlayerEngine decoder cleanup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("frees ctx, pkt, and frame exactly once after successful decoding", async () => {
    const [codec, ctx, pkt, frame] = [11, 22, 33, 44];
    const av = {
      ff_init_decoder: vi.fn().mockResolvedValue([codec, ctx, pkt, frame]),
      ff_decode_multi: vi.fn().mockResolvedValue([]),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    await decoderHarness(av).decodeVideo([new Uint8Array([1])], 2);

    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
    expect(av.ff_free_decoder).toHaveBeenCalledWith(ctx, pkt, frame);
    expect(av.ff_free_decoder.mock.calls[0]).not.toContain(codec);
  });

  it("frees the decoder exactly once after decoding fails", async () => {
    const decodeError = new Error("decode failed");
    const av = {
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockRejectedValue(decodeError),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    await expect(decoderHarness(av).decodeVideo([], 2)).rejects.toBe(decodeError);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("does not hide a decoding error when decoder cleanup also fails", async () => {
    const decodeError = new Error("decode failed");
    const cleanupError = new Error("cleanup failed");
    const av = {
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockRejectedValue(decodeError),
      ff_free_decoder: vi.fn().mockRejectedValue(cleanupError),
    };

    await expect(decoderHarness(av).decodeVideo([], 2)).rejects.toBe(decodeError);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("reports a cleanup error when decoding succeeded", async () => {
    const cleanupError = new Error("cleanup failed");
    const av = {
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockResolvedValue([]),
      ff_free_decoder: vi.fn().mockRejectedValue(cleanupError),
    };

    await expect(decoderHarness(av).decodeVideo([], 2)).rejects.toBe(cleanupError);
    expect(av.ff_free_decoder).toHaveBeenCalledOnce();
  });

  it("falls back to input edit-unit order when decoded PTS uses another time base", async () => {
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    const decodedFrame = (pts: number) => ({
      pts, width: 2, height: 1, format: 4,
      data: new Uint8Array([16, 16, 128, 128]),
      layout: [{ offset: 0, stride: 2 }, { offset: 2, stride: 1 }, { offset: 3, stride: 1 }],
    });
    const av = {
      AV_PIX_FMT_YUV422P: 4,
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockResolvedValue([decodedFrame(90_090), decodedFrame(180_180)]),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    const frames = await decoderHarness(av).decodeVideo(
      [new Uint8Array([1]), new Uint8Array([2])], 2, av, [100, 101], 25,
    );

    expect(frames.map(item => item.mediaFrame)).toEqual([100, 101]);
    expect(frames.map(item => item.time)).toEqual([4, 4.04]);
  });

  it("keeps valid decoded PTS so reordered MPEG-2 output retains its edit units", async () => {
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    const decodedFrame = (pts: number) => ({
      pts, width: 2, height: 1, format: 4,
      data: new Uint8Array([16, 16, 128, 128]),
      layout: [{ offset: 0, stride: 2 }, { offset: 2, stride: 1 }, { offset: 3, stride: 1 }],
    });
    const av = {
      AV_PIX_FMT_YUV422P: 4,
      ff_init_decoder: vi.fn().mockResolvedValue([11, 22, 33, 44]),
      ff_decode_multi: vi.fn().mockResolvedValue([decodedFrame(102), decodedFrame(100), decodedFrame(101)]),
      ff_free_decoder: vi.fn().mockResolvedValue(undefined),
    };

    const frames = await decoderHarness(av).decodeVideo(
      [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])], 2, av, [100, 101, 102], 25,
    );

    expect(frames.map(item => item.mediaFrame)).toEqual([102, 100, 101]);
  });
});

describe("selectTimecodeTrack unresolved package fallback", () => {
  it("uses KLV order and excludes invalid rates while package parsing is unsupported",()=>{
    const invalid={startFrame:0,roundedTimecodeBase:25,dropFrame:false,editRateNumerator:0,editRateDenominator:1,packageKind:"material" as const,packageReferenceResolved:true};
    const source={...invalid,startFrame:10,editRateNumerator:25,packageKind:"source" as const};
    const material={...source,startFrame:20,packageKind:"material" as const};
    expect(selectTimecodeTrack([invalid,source,material])).toBe(source);
  });
});

describe("selectTimecodeTrack", () => {
  const first = { startFrame: 100, roundedTimecodeBase: 30, dropFrame: false, editRateNumerator: 30000, editRateDenominator: 1001 };
  const second = { startFrame: 200, roundedTimecodeBase: 30, dropFrame: true, editRateNumerator: 30000, editRateDenominator: 1001 };

  it("logs the count, warns about ambiguity, and describes the selected first usable track", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    expect(selectTimecodeTrack([first, second], logger)).toBe(first);
    expect(logger.debug).toHaveBeenCalledWith("[H422Player] detected Timecode Tracks: 2");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("multiple Timecode Tracks detected (2)"));
    expect(logger.info).toHaveBeenCalledWith("[H422Player] selected Timecode Track: start=100 edit_rate=30000/1001 drop_frame=false");
  });

  it("skips a track without an Edit Rate but retains discovery order", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    expect(selectTimecodeTrack([{ ...first, editRateNumerator: 0 }, second], logger)).toBe(second);
  });
});

type Gate = { entered: Promise<void>; wait: Promise<void>; open():void; release(): void };
function gate(): Gate { let open!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{open=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});return {entered,wait,open,release}; }

function lifecycleHarness(block:"metadata"|"video"|"audio") {
  const pause=gate(),events:string[]=[],destroyedReaders:number[]=[];
  const callbacks={status:vi.fn((value:string)=>events.push(`status:${value}`)),ready:vi.fn(()=>events.push("ready")),time:vi.fn(),error:vi.fn(()=>events.push("error")),mediaInfo:vi.fn(()=>events.push("mediaInfo")),timecode:vi.fn(()=>events.push("timecode"))};
  const engine=Object.create(PlayerEngine.prototype) as any;Object.assign(engine,{callbacks,muted:false,libavBase:"/libav",renderer:{draw:vi.fn()},frames:[],loadGeneration:0,destroyed:false,dependencies:{
    createReader:(blob:Blob)=>({size:BigInt(blob.size),read:vi.fn(),destroy:()=>destroyedReaders.push(blob.size),id:blob.size}),
    parseMetadata:async(reader:{id:number})=>{if(reader.id===1&&block==="metadata"){pause.open();await pause.wait;}return {mediaInfo:{timecodeTrackCount:0,indexTableCount:0,indexEntryCount:0,durationFrames:reader.id},timecodes:[],indexTables:[],partitions:[],usedRandomIndexPack:false};},
    readWhole:async(blob:Blob)=>new Uint8Array([blob.size]),parse:(bytes:Uint8Array)=>({packets:[{kind:"video",trackNumber:1,bodyOffset:0,data:new Uint8Array([bytes[0]])},{kind:"audio",trackNumber:1,bodyOffset:0,data:new Uint8Array([bytes[0],0,0,bytes[0],0,0])}],operationalPattern:"OP1a",isXdcamHd422:true,videoCodec:{codecId:2,codecName:"mpeg2video"},audioCodec:{codecId:65549,codecName:"pcm_s24be"}}),
    loadLibav:async()=>({libavjs_with_swscale:async()=>1}),
  }});
  engine.decodeVideo=async(chunks:Uint8Array[])=>{if(chunks[0][0]===1&&block==="video"){pause.open();await pause.wait;}return [{frame:{width:2,height:2},time:0}];};
  engine.preparePcm=async(chunks:Uint8Array[])=>{if(chunks[0][0]===1&&block==="audio"){pause.open();await pause.wait;}return {audio:{close:vi.fn()},audioBuffer:{}};};
  return {engine,callbacks,events,pause,destroyedReaders};
}

describe("PlayerEngine stale load suppression",()=>{
  for(const stage of ["metadata","video","audio"] as const) it(`suppresses an old load interrupted during ${stage}`,async()=>{const h=lifecycleHarness(stage),old=h.engine.load(new Blob([new Uint8Array(1)]));await h.pause.entered;const current=h.engine.load(new Blob([new Uint8Array(2)]));await current;h.pause.release();await old;expect(h.callbacks.ready).toHaveBeenCalledOnce();expect(h.callbacks.mediaInfo).toHaveBeenCalledOnce();expect(h.callbacks.mediaInfo.mock.calls[0][0].durationFrames).toBe(2);expect(h.callbacks.timecode).toHaveBeenCalledOnce();expect(h.callbacks.error).not.toHaveBeenCalled();expect(h.events.filter(value=>value==="status:ready")).toHaveLength(1);expect(h.destroyedReaders.sort()).toEqual([1,2]);});
  it("does not publish decoded output after destroy",async()=>{vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=lifecycleHarness("video"),loading=h.engine.load(new Blob([new Uint8Array(1)]));await h.pause.entered;h.engine.destroy();h.pause.release();await loading;expect(h.callbacks.ready).not.toHaveBeenCalled();expect(h.callbacks.mediaInfo).not.toHaveBeenCalled();expect(h.callbacks.timecode).not.toHaveBeenCalled();expect(h.callbacks.error).not.toHaveBeenCalled();expect(h.engine.renderer.draw).not.toHaveBeenCalled();});
});

describe("PlayerEngine streaming mode",()=>{
  afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
  it("keeps the reader, avoids readWhole, and starts background prefetch after the initial range",async()=>{
    const readWhole=vi.fn(),destroy=vi.fn(),readRange=vi.fn().mockResolvedValue([{kind:"video",data:new Uint8Array([0,0,1,0xb3]),editUnit:0}]);
    const callbacks={status:vi.fn(),ready:vi.fn(),time:vi.fn(),error:vi.fn(),mediaInfo:vi.fn(),timecode:vi.fn(),diagnostics:vi.fn()};
    const engine=Object.create(PlayerEngine.prototype) as any;
    Object.assign(engine,{callbacks,renderer:{draw:vi.fn()},mode:"streaming",frames:[],loadGeneration:0,seekGeneration:0,destroyed:false,videoAheadSeconds:4,retainBehindSeconds:1,refillThresholdSeconds:2,chunkSeconds:3,maxReadSize:1024,dependencies:{
      createReader:()=>({size:1000n,read:vi.fn(),destroy,getStats:()=>({bytesLoaded:20n,underlyingReadCount:2,cachedBytes:10})}),
      parseMetadata:async()=>({mediaInfo:{operationalPattern:"OP1a",essenceContainer:"060e2b34",video:{width:1920,height:1080},durationFrames:300,timecodeTrackCount:0,indexTableCount:0,indexEntryCount:0},timecodes:[],indexTables:[],partitions:[{offset:0n,kind:"header"}]}),
      indexEssence:async()=>({frameRate:30,partitions:[],packets:[{kind:"video",editUnit:0}]}),readRange,readWhole,parse:vi.fn(),loadLibav:async()=>({libavjs_with_swscale:async()=>1})
    }});
    engine.decodeVideo=async()=>[{frame:{width:2,height:2},time:0}];
    engine.requestFill=vi.fn();engine.requestAudioFill=vi.fn();
    await engine.load(new Blob([new Uint8Array(1000)]));
    expect(readWhole).not.toHaveBeenCalled();
    expect(readRange).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({startFrame:0,endFrame:89,maxReadSize:1024,kinds:["video"]}));
    expect(destroy).not.toHaveBeenCalled();
    expect(callbacks.ready).toHaveBeenCalledOnce();
    expect(engine.requestFill).toHaveBeenCalledWith(0,true);
    expect(engine.requestAudioFill).toHaveBeenCalledWith(0);
    expect(callbacks.timecode).toHaveBeenCalledWith(null);
    expect(callbacks.error).not.toHaveBeenCalled();
    engine.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  function streamingPlaybackHarness(){
    const callbacks={status:vi.fn(),ready:vi.fn(),time:vi.fn(),error:vi.fn(),seeking:vi.fn(),buffering:vi.fn(),diagnostics:vi.fn(),timecode:vi.fn()};
    const engine=Object.create(PlayerEngine.prototype) as any;
    Object.assign(engine,{callbacks,renderer:{draw:vi.fn()},mode:"streaming",status:"playing",frames:[],loadGeneration:1,seekGeneration:1,destroyed:false,videoAheadSeconds:4,retainBehindSeconds:1,refillThresholdSeconds:2,chunkSeconds:3,maxReadSize:1024,durationValue:200,startedAt:0,pausedAt:0,queuedThroughFrame:-1,essenceIndex:{frameRate:10,packets:[]},reader:{},libav:{},raf:0,buffering:false,resumeAfterBuffer:false});
    return {engine,callbacks};
  }

  it("deduplicates background fills and uses the four-second ahead target",async()=>{
    const h=streamingPlaybackHarness(),release=gate();let calls=0;
    h.engine.fillStreaming=vi.fn(async()=>{calls++;release.open();await release.wait;h.engine.frames=[{frame:{width:2,height:2},time:5}];h.engine.queuedThroughFrame=50;return true;});
    h.engine.requestFill(0);h.engine.requestFill(0);await release.entered;expect(calls).toBe(1);release.release();await Promise.resolve();await Promise.resolve();
    expect(h.engine.fillStreaming).toHaveBeenCalledTimes(1);
  });

  it("evicts played frames according to retainBehindSeconds without growing the queue",()=>{
    vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.spyOn(performance,"now").mockReturnValue(5000);
    const h=streamingPlaybackHarness();h.engine.frames=Array.from({length:70},(_,i)=>({frame:{width:2,height:2},time:i/10}));h.engine.requestFill=vi.fn();h.engine.tick();
    expect(h.engine.frames[0].time).toBeGreaterThanOrEqual(4);expect(h.engine.frames.length).toBeLessThanOrEqual(30);
  });

  it("enters buffering on exhaustion and freezes the media clock",()=>{
    vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.spyOn(performance,"now").mockReturnValue(5000);
    const h=streamingPlaybackHarness();h.engine.frames=[{frame:{width:2,height:2},time:3}];h.engine.requestFill=vi.fn();h.engine.tick();
    expect(h.engine.status).toBe("buffering");expect(h.engine.pausedAt).toBe(5);expect(h.callbacks.buffering).toHaveBeenCalledWith(true);vi.spyOn(performance,"now").mockReturnValue(9000);expect(h.engine.currentTime).toBe(5);
  });

  it("aborts a normal fill when seeking and only resumes from the seek target",async()=>{
    vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.spyOn(performance,"now").mockReturnValue(1000);
    const h=streamingPlaybackHarness(),old=new AbortController();h.engine.fillController=old;h.engine.filling=new Promise(()=>{});h.engine.fillStreaming=vi.fn(async(start:number)=>{h.engine.frames=[{frame:{width:2,height:2},time:start/10,mediaFrame:start}];h.engine.queuedThroughFrame=start+29;return true;});
    await h.engine.seek(100);expect(old.signal.aborted).toBe(true);expect(h.engine.fillStreaming.mock.calls[0][0]).toBe(1000);expect(h.engine.renderer.draw).toHaveBeenCalledWith(expect.objectContaining({width:2}),2,2);expect(h.engine.frames.every((frame:any)=>frame.time>=100)).toBe(true);expect(h.engine.status).toBe("playing");expect(h.callbacks.seeking).toHaveBeenLastCalledWith(false);
  });

  it("decodes from RAP, retains only target-and-later frames, and derives the displayed frame",async()=>{
    vi.stubGlobal("cancelAnimationFrame",vi.fn());
    const h=streamingPlaybackHarness();h.engine.status="paused";h.engine.durationValue=10;h.engine.essenceIndex={frameRate:30,packets:[]};
    h.engine.indexTables=[{editRateNumerator:30,editRateDenominator:1,startPosition:0,duration:300,entries:[{editUnit:90,streamOffset:0n,isRandomAccessPoint:true}]}];
    h.engine.timecodeInfo={startFrame:0,roundedTimecodeBase:30,dropFrame:false,editRateNumerator:30,editRateDenominator:1};h.engine.reader={destroy:vi.fn(),getStats:()=>({bytesLoaded:123n})};
    const packets=Array.from({length:41},(_,i)=>({kind:"video",editUnit:90+i,data:new Uint8Array([i]),valueOffset:0n,valueLength:1n,offset:0n,trackNumber:1,presentationTime:(90+i)/30}));
    h.engine.dependencies={readRange:vi.fn(async(_reader:any,_index:any,options:any)=>{expect(options).toMatchObject({startFrame:90,prerollFrames:0});expect(options.endFrame).toBeGreaterThanOrEqual(100);return packets.filter(packet=>packet.editUnit<=options.endFrame);})};
    const decodedInputs:number[][]=[];h.engine.decodeVideo=vi.fn(async(_chunks:any,_codec:any,_av:any,mediaFrames:number[])=>{decodedInputs.push(mediaFrames);return mediaFrames.map(mediaFrame=>({frame:{width:2,height:2},time:mediaFrame/30,mediaFrame}));});
    h.engine.fillStreamingAudio=vi.fn(async(mediaTime:number)=>{expect(mediaTime).toBe(100/30);return true;});
    await h.engine.seekTimecode("00:00:03:10");
    expect(decodedInputs[0][0]).toBe(90);expect(decodedInputs[0]).toContain(100);expect(h.engine.frames[0].mediaFrame).toBe(100);expect(h.engine.frames.some((frame:any)=>frame.mediaFrame<100)).toBe(false);
    expect(h.engine.renderer.draw).toHaveBeenCalledWith(packets[10]&&expect.objectContaining({width:2}),2,2);expect(h.engine.actualDisplayedFrame).toBe(100);expect(h.engine.seekStartFrame).toBe(90);expect(h.engine.prerollFrames).toBe(10);expect(h.engine.seekSource).toBe("index");
  });

  it("fails strict timecode seek when the requested decoded frame is absent",async()=>{
    vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=streamingPlaybackHarness();h.engine.status="paused";h.engine.durationValue=10;h.engine.essenceIndex={frameRate:30,packets:[]};h.engine.indexTables=[];h.engine.reader={destroy:vi.fn()};h.engine.timecodeInfo={startFrame:0,roundedTimecodeBase:30,dropFrame:false,editRateNumerator:30,editRateDenominator:1};
    h.engine.fillStreaming=vi.fn(async()=>{h.engine.frames=[{frame:{width:2,height:2},time:99/30,mediaFrame:99}];return true;});h.engine.fillStreamingAudio=vi.fn(async()=>true);
    await expect(h.engine.seekTimecode("00:00:03:10")).rejects.toThrow("Requested frame 100 was not decoded");expect(h.engine.requestedTimecode).not.toBe("00:00:03:10");expect(h.callbacks.error).toHaveBeenCalled();
  });

  it("does not apply an older timecode result after a newer seek generation",async()=>{
    const h=streamingPlaybackHarness(),first=gate();h.engine.publishDiagnostics=vi.fn();h.engine.durationValue=20;h.engine.essenceIndex={frameRate:30,packets:[]};h.engine.timecodeInfo={startFrame:0,roundedTimecodeBase:30,dropFrame:false,editRateNumerator:30,editRateDenominator:1};
    h.engine.seek=vi.fn(async(seconds:number)=>{const generation=++h.engine.seekGeneration;if(seconds===1){first.open();await first.wait;}if(generation!==h.engine.seekGeneration)return;});
    const old=h.engine.seekTimecode("00:00:01:00");await first.entered;await h.engine.seekTimecode("00:00:02:00");first.release();await old;
    expect(h.engine.requestedTimecode).toBe("00:00:02:00");expect(h.engine.requestedFrame).toBe(60);
  });

  it("rejects timecode outside engine duration when track duration is absent",async()=>{
    const h=streamingPlaybackHarness();h.engine.durationValue=2;h.engine.essenceIndex={frameRate:30,packets:[]};h.engine.timecodeInfo={startFrame:0,roundedTimecodeBase:30,dropFrame:false,editRateNumerator:30,editRateDenominator:1};
    await expect(h.engine.seekTimecode("00:00:02:00")).rejects.toThrow("out-of-range");expect(h.callbacks.seeking).not.toHaveBeenCalled();
  });

  it("uses sequential fallback decode start when no Index Table exists",async()=>{
    vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=streamingPlaybackHarness();h.engine.status="paused";h.engine.indexTables=[];h.engine.fillStreaming=vi.fn(async(target:number,_signal:any,_load:any,_seek:any,start:number)=>{expect(target).toBe(100);expect(start).toBe(0);h.engine.frames=[{frame:{width:2,height:2},time:10,mediaFrame:100}];return true;});h.engine.fillStreamingAudio=vi.fn(async()=>true);
    await h.engine.seek(10);expect(h.engine.seekSource).toBe("sequential-fallback");expect(h.engine.actualDisplayedFrame).toBe(100);
  });

  it("does not auto-resume after pause while buffering",()=>{
    vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=streamingPlaybackHarness();h.engine.status="buffering";h.engine.buffering=true;h.engine.resumeAfterBuffer=true;h.engine.abortFill=vi.fn();h.engine.pause();expect(h.engine.resumeAfterBuffer).toBe(false);expect(h.engine.status).toBe("paused");expect(h.callbacks.buffering).toHaveBeenLastCalledWith(false);
  });

  it("ends once when the last frame is one frame before duration",()=>{
    vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.spyOn(performance,"now").mockReturnValue(9967);
    const h=streamingPlaybackHarness();h.engine.durationValue=10;h.engine.essenceIndex={frameRate:30,packets:[{kind:"video",editUnit:299}]};h.engine.queuedThroughFrame=299;h.engine.frames=[{frame:{width:2,height:2},time:299/30}];h.engine.requestFill=vi.fn();h.engine.tick();h.engine.tick();
    expect(h.engine.status).toBe("ended");expect(h.engine.pausedAt).toBe(10);expect(h.engine.requestFill).not.toHaveBeenCalled();expect(h.callbacks.status.mock.calls.filter((call:any[])=>call[0]==="ended")).toHaveLength(1);expect(h.callbacks.time).toHaveBeenLastCalledWith(10);expect(h.callbacks.timecode).toHaveBeenLastCalledWith(null);expect(h.callbacks.buffering).not.toHaveBeenCalledWith(true);
  });

  it("moves the current generation to error when a background fill fails",async()=>{
    vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=streamingPlaybackHarness(),destroy=vi.fn();h.engine.reader={destroy};h.engine.frames=[{frame:{width:2,height:2},time:0}];h.engine.buffering=true;h.engine.fillStreaming=vi.fn().mockRejectedValue(new Error("read failed"));h.engine.requestFill(0);await Promise.resolve();await Promise.resolve();
    expect(h.engine.status).toBe("error");expect(h.callbacks.error).toHaveBeenCalledWith(expect.objectContaining({message:"read failed"}));expect(h.callbacks.buffering).toHaveBeenCalledWith(false);expect(h.engine.resumeAfterBuffer).toBe(false);expect(destroy).toHaveBeenCalledOnce();expect(h.engine.reader).toBeUndefined();expect(h.engine.frames).toEqual([]);
  });

  it("ignores stale and post-destroy fill failures",async()=>{
    vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=streamingPlaybackHarness(),failure=gate();h.engine.fillStreaming=vi.fn(async()=>{failure.open();await failure.wait;throw new Error("late decode failure");});h.engine.requestFill(0);await failure.entered;h.engine.seekGeneration++;h.engine.destroyed=true;failure.release();await Promise.resolve();await Promise.resolve();
    expect(h.callbacks.error).not.toHaveBeenCalled();expect(h.callbacks.status).not.toHaveBeenCalledWith("error");
  });

  it("an old load cleanup cannot destroy the replacement reader",()=>{
    const h=streamingPlaybackHarness(),a={destroy:vi.fn()},b={destroy:vi.fn()};h.engine.reader=a;h.engine.releaseReader(a);h.engine.reader=b;h.engine.releaseReader(a);
    expect(a.destroy).toHaveBeenCalledOnce();expect(b.destroy).not.toHaveBeenCalled();expect(h.engine.reader).toBe(b);
  });

  it("treats an aborted stale seek as a successful cancellation",async()=>{
    vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=streamingPlaybackHarness(),firstEntered=gate();h.engine.status="paused";
    h.engine.fillStreaming=vi.fn(async(start:number,signal:AbortSignal)=>{if(start===100){firstEntered.open();await firstEntered.wait;if(signal.aborted)throw new DOMException("aborted","AbortError");}h.engine.frames=[{frame:{width:2,height:2},time:start/10,mediaFrame:start}];return true;});
    const first=h.engine.seek(10);await firstEntered.entered;const second=h.engine.seek(100);firstEntered.release();await expect(first).resolves.toBeUndefined();await expect(second).resolves.toBeUndefined();
    expect(h.callbacks.error).not.toHaveBeenCalled();expect(h.callbacks.status).not.toHaveBeenCalledWith("error");expect(h.engine.renderer.draw).toHaveBeenLastCalledWith(expect.objectContaining({width:2}),2,2);expect(h.engine.frames[0].time).toBe(100);
  });

  it("treats destroy during seek as a successful cancellation",async()=>{
    vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=streamingPlaybackHarness(),entered=gate();h.engine.releaseReader=vi.fn();h.engine.fillStreaming=vi.fn(async(_start:number,signal:AbortSignal)=>{entered.open();await entered.wait;if(signal.aborted)throw new DOMException("aborted","AbortError");return false;});
    const seeking=h.engine.seek(10);await entered.entered;h.engine.destroy();entered.release();await expect(seeking).resolves.toBeUndefined();expect(h.callbacks.error).not.toHaveBeenCalled();expect(h.callbacks.status).not.toHaveBeenCalledWith("error");
  });
});

function playbackHarness() {
  const sources:Array<{stop:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>;connect:ReturnType<typeof vi.fn>;start:ReturnType<typeof vi.fn>;buffer?:unknown}>=[];
  const audio={destination:{},resume:vi.fn(),suspend:vi.fn(),close:vi.fn(),createBufferSource:vi.fn(()=>{const source={stop:vi.fn(),disconnect:vi.fn(),connect:vi.fn(),start:vi.fn(),buffer:undefined};sources.push(source);return source;})};
  const callbacks={status:vi.fn(),ready:vi.fn(),time:vi.fn(),error:vi.fn(),timecode:vi.fn(),seeking:vi.fn()};
  const engine=Object.create(PlayerEngine.prototype) as any;
  Object.assign(engine,{callbacks,renderer:{draw:vi.fn()},audio,audioBuffer:{duration:20},status:"ready",pausedAt:0,durationValue:1,frames:[{frame:{width:2,height:2},time:0}],destroyed:false,loadGeneration:0,seekGeneration:0,raf:0});
  return {engine,audio,callbacks,sources};
}

describe("PlayerEngine audio lifecycle",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("stops longer audio exactly when video playback ends",async()=>{vi.stubGlobal("requestAnimationFrame",vi.fn(()=>7));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.spyOn(performance,"now").mockReturnValue(0);const h=playbackHarness();expect(h.engine.audioBuffer.duration).toBeGreaterThan(h.engine.durationValue);await h.engine.play();vi.spyOn(performance,"now").mockReturnValue(2000);h.engine.tick();h.engine.tick();expect(h.sources[0].stop).toHaveBeenCalledOnce();expect(h.sources[0].disconnect).toHaveBeenCalledOnce();expect(h.audio.suspend).toHaveBeenCalledOnce();expect(h.engine.status).toBe("ended");expect(h.engine.pausedAt).toBe(1);expect(h.callbacks.time).toHaveBeenLastCalledWith(1);expect(h.callbacks.status.mock.calls.filter((call:any[])=>call[0]==="ended")).toHaveLength(1);});
  it("stops and disconnects on pause and destroy even when stop throws",async()=>{vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=playbackHarness();await h.engine.play();h.sources[0].stop.mockImplementation(()=>{throw new DOMException("already stopped");});expect(()=>h.engine.pause()).not.toThrow();expect(h.sources[0].disconnect).toHaveBeenCalledOnce();await h.engine.play();h.engine.destroy();expect(h.sources[1].stop).toHaveBeenCalledOnce();expect(h.sources[1].disconnect).toHaveBeenCalledOnce();});
  it("creates a fresh source when replaying after ended and seeking to zero",async()=>{vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.spyOn(performance,"now").mockReturnValueOnce(0).mockReturnValue(2000);const h=playbackHarness();await h.engine.play();h.engine.tick();await h.engine.seek(0);await h.engine.play();expect(h.sources).toHaveLength(2);expect(h.sources[1]).not.toBe(h.sources[0]);expect(h.sources[1].start).toHaveBeenCalledWith(0,0);});
});

describe("PlayerEngine streaming audio",()=>{
  function audioHarness(){
    const sources:any[]=[];
    const audio={currentTime:10,destination:{},suspend:vi.fn(),resume:vi.fn(),close:vi.fn(),createBuffer:vi.fn((_channels:number,length:number,rate:number)=>({duration:length/rate,copyToChannel:vi.fn()})),createBufferSource:vi.fn(()=>{const node={buffer:undefined,connect:vi.fn(),start:vi.fn(),stop:vi.fn(),disconnect:vi.fn(),onended:null};sources.push(node);return node;})};
    const readRange=vi.fn().mockResolvedValue([{kind:"audio",trackNumber:7,bodySID:2,editUnit:10,presentationTime:1,valueOffset:100n,valueLength:12n,data:new Uint8Array([0x7f,0xff,0xff,0x80,0,0,0,0,0,0,0,0])}]);
    const engine=Object.create(PlayerEngine.prototype) as any;Object.assign(engine,{callbacks:{status:vi.fn(),ready:vi.fn(),time:vi.fn(),error:vi.fn(),diagnostics:vi.fn()},mode:"streaming",audio,reader:{},essenceIndex:{frameRate:10,packets:[]},dependencies:{readRange},streamingAudioSupported:true,selectedAudioTrackNumber:7,audioChunks:[],scheduledAudio:[],audioBytesLoaded:0,durationValue:20,loadGeneration:2,seekGeneration:3,destroyed:false,status:"paused",pausedAt:1,frames:[]});
    return {engine,audio,readRange,sources};
  }
  it("reads only the selected three-second audio range without video preroll and converts a bounded chunk",async()=>{const h=audioHarness();await h.engine.fillStreamingAudio(1,new AbortController().signal,2,3);expect(h.readRange).toHaveBeenCalledWith(h.engine.reader,h.engine.essenceIndex,expect.objectContaining({startFrame:10,endFrame:39,prerollFrames:0,kinds:["audio"],trackNumbers:[7]}));expect(h.audio.createBuffer).toHaveBeenCalledWith(2,2,48000);expect(h.engine.audioBytesLoaded).toBe(12);expect(h.engine.audioChunks).toHaveLength(1);});
  it("schedules adjacent chunks with fresh nodes and never past duration",()=>{const h=audioHarness();h.engine.durationValue=2;h.engine.audioChunks=[{mediaStartTime:1,mediaEndTime:1.5,buffer:{duration:.5},generation:3,scheduled:false},{mediaStartTime:1.5,mediaEndTime:2.5,buffer:{duration:1},generation:3,scheduled:false}];h.engine.resetAndScheduleStreamingAudio(1);expect(h.sources).toHaveLength(2);expect(h.sources[0].start).toHaveBeenCalledWith(10.03,0,.5);expect(h.sources[1].start).toHaveBeenCalledWith(10.53,0,.5);});
  it("stops and disconnects every scheduled node on pause",()=>{vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=audioHarness();h.engine.status="playing";h.engine.startedAt=performance.now()-1000;h.engine.audioChunks=[{mediaStartTime:1,mediaEndTime:2,buffer:{duration:1},generation:3,scheduled:false}];h.engine.resetAndScheduleStreamingAudio(1);h.engine.pause();expect(h.sources[0].stop).toHaveBeenCalledOnce();expect(h.sources[0].disconnect).toHaveBeenCalledOnce();});
});

// Regression coverage for gap-preserving append scheduling and coordinated recovery.
describe("PlayerEngine streaming audio scheduling regressions",()=>{
  const chunk=(start:number,end:number,generation=3)=>({mediaStartTime:start,mediaEndTime:end,buffer:{duration:end-start},generation,scheduled:false});
  function harness(){const sources:any[]=[];const audio={currentTime:5,destination:{},resume:vi.fn(),suspend:vi.fn(),close:vi.fn(),createBufferSource:vi.fn(()=>{const node={buffer:undefined,connect:vi.fn(),start:vi.fn(),stop:vi.fn(),disconnect:vi.fn(),onended:null};sources.push(node);return node;})};const callbacks={status:vi.fn(),ready:vi.fn(),time:vi.fn(),error:vi.fn(),buffering:vi.fn(),timecode:vi.fn()};const engine=Object.create(PlayerEngine.prototype) as any;Object.assign(engine,{audio,sources,callbacks,renderer:{draw:vi.fn()},mode:"streaming",streamingAudioSupported:true,audioChunks:[],scheduledAudio:[],audioExhausted:false,lastAudioTime:0,frames:[],durationValue:20,pausedAt:1,retainBehindSeconds:1,loadGeneration:2,seekGeneration:3,destroyed:false,status:"playing",buffering:false,resumeAfterBuffer:false,raf:0});return {engine,audio,sources,callbacks};}
  afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
  it("appends only new chunks without stopping nodes or changing existing reservation times",()=>{const h=harness();h.engine.audioChunks=[chunk(1,2)];h.engine.resetAndScheduleStreamingAudio(1);const first=h.engine.scheduledAudio[0],firstTime=first.contextStartTime;h.engine.audioChunks.push(chunk(2,3));h.engine.appendStreamingAudioSchedule();expect(h.sources).toHaveLength(2);expect(first.sourceNode.stop).not.toHaveBeenCalled();expect(first.contextStartTime).toBe(firstTime);expect(h.engine.scheduledAudio[1].contextStartTime).toBeCloseTo(firstTime+1);h.engine.appendStreamingAudioSchedule();expect(h.sources).toHaveLength(2);});
  it("preserves real media gaps instead of packing chunks together",()=>{const h=harness();h.engine.audioChunks=[chunk(1,2),chunk(4,5)];h.engine.resetAndScheduleStreamingAudio(1);expect(h.engine.scheduledAudio[1].contextStartTime-h.engine.scheduledAudio[0].contextStartTime).toBeCloseTo(3);});
  it("does not leave buffering until both video and audio fills complete",()=>{vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.spyOn(performance,"now").mockReturnValue(1000);const h=harness();h.engine.status="buffering";h.engine.buffering=true;h.engine.resumeAfterBuffer=true;h.engine.frames=[{frame:{width:2,height:2},time:1}];h.engine.audioChunks=[chunk(1,2)];h.engine.filling=Promise.resolve();h.engine.tryResumeFromBuffering();expect(h.engine.status).toBe("buffering");h.engine.filling=undefined;h.engine.audioFilling=Promise.resolve();h.engine.tryResumeFromBuffering();expect(h.engine.status).toBe("buffering");h.engine.audioFilling=undefined;h.engine.tryResumeFromBuffering();expect(h.engine.status).toBe("playing");});
  it("treats an earlier audio ending as silence and never requests another fill",()=>{const h=harness();h.engine.audioExhausted=true;h.engine.lastAudioTime=4;h.engine.audioChunks=[];h.engine.fillStreamingAudio=vi.fn();expect(h.engine.audioReadyAt(8)).toBe(true);h.engine.requestAudioFill(8);expect(h.engine.fillStreamingAudio).not.toHaveBeenCalled();});
  it("rebuilds sources after pause and resume",async()=>{vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=harness();h.engine.audioChunks=[chunk(1,2)];h.engine.resetAndScheduleStreamingAudio(1);h.engine.pause();h.engine.pausedAt=1;await h.engine.play();expect(h.sources).toHaveLength(2);expect(h.sources[0].stop).toHaveBeenCalledOnce();expect(h.sources[1]).not.toBe(h.sources[0]);});
});

describe("PlayerEngine streaming audio format validation",()=>{
  it("falls back to video-only when explicit BlockAlign or coding UL contradicts the profile",()=>{const warn=vi.spyOn(console,"warn").mockImplementation(()=>undefined),close=vi.fn();const engine=Object.create(PlayerEngine.prototype) as any;Object.assign(engine,{audio:{close},audioChunks:[],scheduledAudio:[],essenceIndex:{packets:[{kind:"audio",trackNumber:4}]},muted:false});engine.configureStreamingAudio({audio:{sampleRate:48000,channels:2,bitsPerSample:24,blockAlign:4,essenceCodingUl:"ffffffffffffffffffffffffffffffff"}});expect(engine.streamingAudioSupported).toBe(false);expect(engine.selectedAudioTrackNumber).toBeUndefined();expect(engine.audio).toBeUndefined();expect(close).toHaveBeenCalledOnce();expect(warn).toHaveBeenCalledWith(expect.stringContaining("BlockAlign=4"));});
});
