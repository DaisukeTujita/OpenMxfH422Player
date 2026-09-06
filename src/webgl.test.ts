import { afterEach, describe, expect, it, vi } from "vitest";
import { Canvas2dRenderer, createFrameRenderer, WebGlRenderer } from "./webgl";

function createWebGlMock() {
  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    COMPILE_STATUS: 0x8b81,
    FLOAT: 0x1406,
    LINK_STATUS: 0x8b82,
    LUMINANCE: 0x1909,
    FRAGMENT_SHADER: 0x8b30,
    LINEAR: 0x2601,
    RGBA: 0x1908,
    STATIC_DRAW: 0x88e4,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TRIANGLE_STRIP: 0x0005,
    UNSIGNED_BYTE: 0x1401,
    VERTEX_SHADER: 0x8b31,
    activeTexture: vi.fn(),
    attachShader: vi.fn(),
    bindBuffer: vi.fn(),
    bindTexture: vi.fn(),
    bufferData: vi.fn(),
    compileShader: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    createProgram: vi.fn(() => ({})),
    createShader: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({})),
    drawArrays: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    getAttribLocation: vi.fn((_program, name: string) => name === "p" ? 0 : 1),
    getError: vi.fn(() => 0),
    getProgramInfoLog: vi.fn(() => null),
    getProgramParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => null),
    getShaderParameter: vi.fn(() => true),
    getUniformLocation: vi.fn((_program, name:string) => name),
    linkProgram: vi.fn(),
    pixelStorei: vi.fn(),
    shaderSource: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    texParameteri: vi.fn(),
    uniform1i: vi.fn(),
    useProgram: vi.fn(),
    vertexAttribPointer: vi.fn(),
    viewport: vi.fn(),
  };

  return gl;
}

describe("WebGlRenderer", () => {
  it("configures an NPOT-safe texture and draws a 1920x1080 ImageData frame", () => {
    const gl = createWebGlMock();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => gl),
    } as unknown as HTMLCanvasElement;
    const renderer = new WebGlRenderer(canvas);

    expect(gl.texParameteri.mock.calls).toEqual(expect.arrayContaining([
      [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ]));

    const frame = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4) } as ImageData;
    expect(() => renderer.draw(frame, 1920, 1080)).not.toThrow();
    expect(gl.texImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame,
    );
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLE_STRIP, 0, 4);
    expect(gl.getError).not.toHaveBeenCalled();
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    renderer.draw(frame, 1920, 1080);
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);
    expect(gl.texSubImage2D).toHaveBeenCalledOnce();
  });
  it("caches uniform/attribute locations and skips redundant program/viewport state changes across frames",()=>{
    const gl = createWebGlMock();
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => gl) } as unknown as HTMLCanvasElement;
    const renderer = new WebGlRenderer(canvas);
    expect(gl.getUniformLocation).toHaveBeenCalledTimes(4); // tex, texY, texU, texV - once each, at construction
    const frame = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4) } as ImageData;
    renderer.draw(frame, 1920, 1080);
    expect(gl.viewport).toHaveBeenCalledTimes(1);
    expect(gl.useProgram).toHaveBeenCalledTimes(1);
    expect(gl.getAttribLocation).toHaveBeenCalledTimes(2);
    renderer.draw(frame, 1920, 1080);
    expect(gl.getUniformLocation).toHaveBeenCalledTimes(4); // still just the constructor calls
    expect(gl.viewport).toHaveBeenCalledTimes(1); // same size, no re-issue
    expect(gl.useProgram).toHaveBeenCalledTimes(1); // same program still active
    expect(gl.getAttribLocation).toHaveBeenCalledTimes(2); // cached per-program
    renderer.draw(frame, 640, 360);
    expect(gl.viewport).toHaveBeenCalledTimes(2); // size changed
  });
  it("uploads planar yuv422p without creating an RGBA image", () => {
    const gl=createWebGlMock();
    const canvas={width:0,height:0,getContext:vi.fn(()=>gl)} as unknown as HTMLCanvasElement;
    const renderer=new WebGlRenderer(canvas);
    gl.texImage2D.mockClear();
    renderer.draw({width:4,height:2,y:new Uint8Array(8),u:new Uint8Array(4),v:new Uint8Array(4)},4,2);
    expect(gl.texImage2D).toHaveBeenCalledTimes(3);
    expect(gl.texImage2D).toHaveBeenNthCalledWith(1,gl.TEXTURE_2D,0,gl.LUMINANCE,4,2,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,expect.any(Uint8Array));
    expect(gl.texImage2D).toHaveBeenNthCalledWith(2,gl.TEXTURE_2D,0,gl.LUMINANCE,2,2,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,expect.any(Uint8Array));
    expect(gl.texImage2D).toHaveBeenNthCalledWith(3,gl.TEXTURE_2D,0,gl.LUMINANCE,2,2,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,expect.any(Uint8Array));
    gl.texSubImage2D.mockClear();
    renderer.draw({width:4,height:2,y:new Uint8Array(8),u:new Uint8Array(4),v:new Uint8Array(4)},4,2);
    expect(gl.texSubImage2D).toHaveBeenCalledTimes(3);
  });

});

describe("createFrameRenderer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses WebGL when a context is available", () => {
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => createWebGlMock()) } as unknown as HTMLCanvasElement;
    expect(createFrameRenderer(canvas).backend).toBe("webgl");
  });

  it("falls back to the 2D canvas when WebGL is missing, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const context2d = { putImageData: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: vi.fn((kind: string) => kind === "2d" ? context2d : null) } as unknown as HTMLCanvasElement;

    const renderer = createFrameRenderer(canvas);

    expect(renderer.backend).toBe("canvas2d");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("WebGL is unavailable"), expect.anything());
  });

  it("throws only when neither context can be had", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;
    expect(() => createFrameRenderer(canvas)).toThrow("Neither WebGL nor a 2D canvas context is available");
  });
});

describe("Canvas2dRenderer", () => {
  function setup() {
    const context2d = { putImageData: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context2d) } as unknown as HTMLCanvasElement;
    return { canvas, context2d, renderer: new Canvas2dRenderer(canvas) };
  }

  it("puts RGBA frames straight onto the canvas and sizes it to the media", () => {
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    const { canvas, context2d, renderer } = setup();
    const frame = new ImageData(new Uint8ClampedArray(4 * 2 * 4), 4, 2);

    renderer.draw(frame, 4, 2);

    expect(context2d.putImageData).toHaveBeenCalledWith(frame, 0, 0);
    expect([canvas.width, canvas.height]).toEqual([4, 2]);
    vi.unstubAllGlobals();
  });

  it("rejects planar frames it has no way to convert", () => {
    vi.stubGlobal("ImageData", class {});
    const { renderer } = setup();
    expect(() => renderer.draw({ width: 4, height: 2, y: new Uint8Array(8), u: new Uint8Array(4), v: new Uint8Array(4) }, 4, 2)).toThrow("needs RGBA frames");
    vi.unstubAllGlobals();
  });
});
