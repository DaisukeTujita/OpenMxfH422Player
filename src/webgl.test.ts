import { describe, expect, it, vi } from "vitest";
import { WebGlRenderer } from "./webgl";

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
