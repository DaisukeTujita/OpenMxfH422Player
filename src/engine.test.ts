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
    decodeVideo(chunks: Uint8Array[], codecId: number): Promise<void>;
  };
  engine.libav = av;
  return engine;
}

describe("PlayerEngine decoder cleanup", () => {
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
  it("stops and disconnects audio exactly when video playback ends",async()=>{vi.stubGlobal("requestAnimationFrame",vi.fn(()=>7));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.spyOn(performance,"now").mockReturnValue(0);const h=playbackHarness();await h.engine.play();vi.spyOn(performance,"now").mockReturnValue(2000);h.engine.tick();h.engine.tick();expect(h.sources[0].stop).toHaveBeenCalledOnce();expect(h.sources[0].disconnect).toHaveBeenCalledOnce();expect(h.audio.suspend).toHaveBeenCalledOnce();expect(h.engine.status).toBe("ended");expect(h.engine.pausedAt).toBe(1);expect(h.callbacks.time).toHaveBeenLastCalledWith(1);expect(h.callbacks.status.mock.calls.filter((call:any[])=>call[0]==="ended")).toHaveLength(1);});
  it("stops and disconnects on pause and destroy even when stop throws",async()=>{vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());const h=playbackHarness();await h.engine.play();h.sources[0].stop.mockImplementation(()=>{throw new DOMException("already stopped");});expect(()=>h.engine.pause()).not.toThrow();expect(h.sources[0].disconnect).toHaveBeenCalledOnce();await h.engine.play();h.engine.destroy();expect(h.sources[1].stop).toHaveBeenCalledOnce();expect(h.sources[1].disconnect).toHaveBeenCalledOnce();});
  it("creates a fresh source when replaying after ended and seeking to zero",async()=>{vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.spyOn(performance,"now").mockReturnValueOnce(0).mockReturnValue(2000);const h=playbackHarness();await h.engine.play();h.engine.tick();await h.engine.seek(0);await h.engine.play();expect(h.sources).toHaveLength(2);expect(h.sources[1]).not.toBe(h.sources[0]);expect(h.sources[1].start).toHaveBeenCalledWith(0,0);});
});
