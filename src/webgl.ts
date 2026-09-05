const VERTEX = `attribute vec2 p; attribute vec2 t; varying vec2 uv; void main(){gl_Position=vec4(p,0.,1.);uv=t;}`;
const RGBA_FRAGMENT = `precision mediump float; varying vec2 uv; uniform sampler2D tex; void main(){gl_FragColor=texture2D(tex,uv);}`;
const YUV_FRAGMENT = `precision mediump float; varying vec2 uv; uniform sampler2D texY; uniform sampler2D texU; uniform sampler2D texV; void main(){float y=1.1640625*(texture2D(texY,uv).r-0.0625);float u=texture2D(texU,uv).r-0.5;float v=texture2D(texV,uv).r-0.5;gl_FragColor=vec4(y+1.59765625*v,y-0.390625*u-0.8125*v,y+2.015625*u,1.0);}`;

export interface Yuv422Frame {
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

function isYuv422Frame(frame: TexImageSource | Yuv422Frame): frame is Yuv422Frame {
  return "u" in frame && "v" in frame && frame.y instanceof Uint8Array && frame.u instanceof Uint8Array && frame.v instanceof Uint8Array;
}

function shader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const value = gl.createShader(type)!;
  gl.shaderSource(value, source); gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) ?? "WebGL shader error");
  return value;
}

function program(gl:WebGLRenderingContext,fragment:string):WebGLProgram {
  const value=gl.createProgram()!;
  gl.attachShader(value,shader(gl,gl.VERTEX_SHADER,VERTEX));
  gl.attachShader(value,shader(gl,gl.FRAGMENT_SHADER,fragment));
  gl.linkProgram(value);
  if(!gl.getProgramParameter(value,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(value)??"WebGL program link error");
  return value;
}

function texture(gl:WebGLRenderingContext):WebGLTexture {
  const value=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,value);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  return value;
}

export class WebGlRenderer {
  private gl: WebGLRenderingContext;
  private rgbaProgram:WebGLProgram;
  private yuvProgram:WebGLProgram;
  private rgbaTexture:WebGLTexture;
  private yuvTextures:[WebGLTexture,WebGLTexture,WebGLTexture];
  private rgbaTextureSize?:{width:number;height:number};
  private yuvTextureSize?:{width:number;height:number};
  private rgbaUniform:WebGLUniformLocation|null;
  private yuvUniforms:[WebGLUniformLocation|null,WebGLUniformLocation|null,WebGLUniformLocation|null];
  private attribLocations=new Map<WebGLProgram,[number,number]>();
  private activeProgram?:WebGLProgram;
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false });
    if (!gl) throw new Error("WebGL is not available");
    this.gl=gl;this.rgbaProgram=program(gl,RGBA_FRAGMENT);this.yuvProgram=program(gl,YUV_FRAGMENT);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,1,1,-1,1,1,-1,1,0,0,1,1,1,0]),gl.STATIC_DRAW);
    this.rgbaTexture=texture(gl);this.yuvTextures=[texture(gl),texture(gl),texture(gl)];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    this.rgbaUniform=gl.getUniformLocation(this.rgbaProgram,"tex");
    this.yuvUniforms=[gl.getUniformLocation(this.yuvProgram,"texY"),gl.getUniformLocation(this.yuvProgram,"texU"),gl.getUniformLocation(this.yuvProgram,"texV")];
  }
  private use(programValue:WebGLProgram):void {
    if(this.activeProgram===programValue)return;
    const gl=this.gl;gl.useProgram(programValue);this.activeProgram=programValue;
    let locations=this.attribLocations.get(programValue);
    if(!locations){locations=[gl.getAttribLocation(programValue,"p"),gl.getAttribLocation(programValue,"t")];this.attribLocations.set(programValue,locations);}
    const [p,t]=locations;
    gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,2,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(t);gl.vertexAttribPointer(t,2,gl.FLOAT,false,16,2*4);
  }
  draw(frame: TexImageSource|Yuv422Frame, width: number, height: number): void {
    const gl=this.gl;
    if(this.canvas.width!==width||this.canvas.height!==height){this.canvas.width=width;this.canvas.height=height;gl.viewport(0,0,width,height);}
    if(isYuv422Frame(frame)){
      this.use(this.yuvProgram);const planes=[frame.y,frame.u,frame.v];
      const allocate=!this.yuvTextureSize||this.yuvTextureSize.width!==width||this.yuvTextureSize.height!==height;
      for(let i=0;i<3;i++){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,this.yuvTextures[i]);const planeWidth=i===0?width:Math.ceil(width/2);if(allocate)gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,planeWidth,height,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,planes[i]);else gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,planeWidth,height,gl.LUMINANCE,gl.UNSIGNED_BYTE,planes[i]);gl.uniform1i(this.yuvUniforms[i],i);}
      this.yuvTextureSize={width,height};
    }else{
      this.use(this.rgbaProgram);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.rgbaTexture);if(!this.rgbaTextureSize||this.rgbaTextureSize.width!==width||this.rgbaTextureSize.height!==height){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frame);this.rgbaTextureSize={width,height};}else gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,frame);gl.uniform1i(this.rgbaUniform,0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  }
}
