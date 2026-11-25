// Renderização WebGL2: cada pedaço de rua é uma instância desenhada como um retângulo
// (6 vértices gerados por gl_VertexID), com largura em pixels e borda suavizada.
import type { Camera } from "./view";

export type RGBA = [number, number, number, number];

const LINE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_seg;   // x0, y0, x1, y1 (metros)
uniform vec2 u_center;
uniform float u_scale;    // px de dispositivo por metro
uniform vec2 u_viewport;  // px de dispositivo
uniform float u_width;    // px de dispositivo
out float v_dist;
out float v_half;
void main() {
  vec2 s0 = (a_seg.xy - u_center) * u_scale;
  vec2 s1 = (a_seg.zw - u_center) * u_scale;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  int id = gl_VertexID;
  float t = (id == 1 || id == 2 || id == 4) ? 1.0 : 0.0;
  float side = (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0;
  float half_w = max(u_width, 1.0) * 0.5 + 0.5;
  vec2 p = mix(s0, s1, t) + n * side * half_w + dir * (t * 2.0 - 1.0) * half_w * 0.5;
  gl_Position = vec4(p * 2.0 / u_viewport, 0.0, 1.0);
  v_dist = side * half_w;
  v_half = max(u_width, 1.0) * 0.5;
}`;

const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform float u_width;
in float v_dist;
in float v_half;
out vec4 o;
void main() {
  float a = clamp(v_half + 0.5 - abs(v_dist), 0.0, 1.0);
  a *= min(u_width, 1.0);   // linhas mais finas que 1 px ficam mais transparentes
  o = vec4(u_color.rgb * u_color.a * a, u_color.a * a);  // alfa pré-multiplicado
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
  return p;
}

export class LineBatch {
  readonly vao: WebGLVertexArrayObject;
  readonly buffer: WebGLBuffer;
  constructor(
    gl: WebGL2RenderingContext,
    data: Float32Array,
  ) {
    this.count = data.length / 4;
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
  }
  count: number;
}

export interface FrameParams {
  center: [number, number];
  scale: number;
  viewport: [number, number];
  dpr: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private lineProg: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null>;
  dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 indisponível neste navegador");
    this.gl = gl;
    this.lineProg = program(gl, LINE_VS, LINE_FS);
    this.u = {};
    for (const name of ["u_center", "u_scale", "u_viewport", "u_width", "u_color"]) {
      this.u[name] = gl.getUniformLocation(this.lineProg, name);
    }
  }

  /** Ajusta o tamanho do canvas ao CSS × devicePixelRatio (limitado a 2). */
  resize(cssW: number, cssH: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cssW * this.dpr);
    const h = Math.round(cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  frame(cam: Camera): FrameParams {
    return {
      center: [cam.cx, cam.cy],
      scale: cam.scale * this.dpr,
      viewport: [this.canvas.width, this.canvas.height],
      dpr: this.dpr,
    };
  }

  clear(bg: RGBA): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
  }

  /** Desenha um lote de retas com cor e largura (px CSS) fixas. `additive` soma a luz. */
  lines(batch: LineBatch, f: FrameParams, color: RGBA, widthCss: number, additive = false): void {
    const gl = this.gl;
    gl.useProgram(this.lineProg);
    gl.blendFunc(gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.u.u_center, f.center[0], f.center[1]);
    gl.uniform1f(this.u.u_scale, f.scale);
    gl.uniform2f(this.u.u_viewport, f.viewport[0], f.viewport[1]);
    gl.uniform1f(this.u.u_width, widthCss * f.dpr);
    gl.uniform4f(this.u.u_color, ...color);
    gl.bindVertexArray(batch.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count);
    gl.bindVertexArray(null);
  }
}

export function hex(c: string, a = 1): RGBA {
  const n = parseInt(c.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}
