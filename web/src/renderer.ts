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

// Inundação: o pedaço acende onde a chegada interpolada já passou de u_t. A cor é a de
// quem chegou primeiro; a frente (últimos u_hot) fica quase branca e mais forte.
const FLOOD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_seg;
layout(location = 1) in vec2 a_arr;  // chegada na ponta 0 e na ponta 1
layout(location = 2) in vec2 a_who;  // pessoa que chega primeiro em cada ponta (255 = ninguém)
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_viewport;
uniform float u_width;
uniform float u_t;
uniform vec3 u_colors[12];
out float v_dist;
out float v_half;
out float v_arr;
out vec3 v_color;
out float v_valid;
void main() {
  int id = gl_VertexID;
  float t = (id == 1 || id == 2 || id == 4) ? 1.0 : 0.0;
  float side = (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0;
  float who = t > 0.5 ? a_who.y : a_who.x;
  float arr = t > 0.5 ? a_arr.y : a_arr.x;
  v_valid = who < 254.5 ? 1.0 : 0.0;
  v_color = u_colors[int(min(who, 11.0))];
  v_arr = arr;
  // pedaço que ninguém alcançou até agora: degenera (não gera fragmentos)
  if (min(a_arr.x, a_arr.y) > u_t) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 s0 = (a_seg.xy - u_center) * u_scale;
  vec2 s1 = (a_seg.zw - u_center) * u_scale;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float half_w = max(u_width, 1.0) * 0.5 + 0.5;
  vec2 p = mix(s0, s1, t) + n * side * half_w + dir * (t * 2.0 - 1.0) * half_w * 0.5;
  gl_Position = vec4(p * 2.0 / u_viewport, 0.0, 1.0);
  v_dist = side * half_w;
  v_half = max(u_width, 1.0) * 0.5;
}`;

const FLOOD_FS = `#version 300 es
precision highp float;
uniform float u_t;
uniform float u_hot;
uniform float u_alpha;
uniform float u_width;
uniform float u_soft;   // 1 = brilho difuso (passe largo), 0 = linha nítida
in float v_dist;
in float v_half;
in float v_arr;
in vec3 v_color;
in float v_valid;
out vec4 o;
void main() {
  if (v_valid < 0.5 || v_arr > u_t) discard;
  float edge = mix(clamp(v_half + 0.5 - abs(v_dist), 0.0, 1.0),
                   pow(max(1.0 - abs(v_dist) / (v_half + 0.5), 0.0), 2.0), u_soft);
  float heat = 1.0 - clamp((u_t - v_arr) / u_hot, 0.0, 1.0);
  vec3 c = mix(v_color, vec3(1.0), heat * 0.75);
  float a = min(1.0, u_alpha * edge * min(u_width, 1.0) * (1.0 + 1.5 * heat));
  o = vec4(c * a, a);
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

/** Atributos da inundação, por pedaço, apoiados no mesmo buffer de posições das ruas. */
export class FloodBatch {
  readonly vao: WebGLVertexArrayObject;
  readonly count: number;
  private bufs: WebGLBuffer[] = [];
  constructor(
    private gl: WebGL2RenderingContext,
    roads: LineBatch,
    arr: Float32Array,
    who: Uint8Array,
  ) {
    this.count = roads.count;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, roads.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(0, 1);
    const a = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, a);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(1, 1);
    const w = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, w);
    gl.bufferData(gl.ARRAY_BUFFER, who, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.UNSIGNED_BYTE, false, 2, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    this.bufs = [a, w];
  }
  dispose(): void {
    for (const b of this.bufs) this.gl.deleteBuffer(b);
    this.gl.deleteVertexArray(this.vao);
  }
}

export interface FloodStyle {
  t: number;
  hot: number;
  colors: RGBA[];
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
  private floodProg: WebGLProgram;
  private fu: Record<string, WebGLUniformLocation | null>;
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
    this.floodProg = program(gl, FLOOD_VS, FLOOD_FS);
    this.fu = {};
    for (const name of ["u_center", "u_scale", "u_viewport", "u_width", "u_t", "u_hot", "u_alpha", "u_soft", "u_colors"]) {
      this.fu[name] = gl.getUniformLocation(this.floodProg, name);
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

  /** Inundação: um passe largo e difuso (brilho) + um passe nítido, ambos aditivos. */
  flood(batch: FloodBatch, f: FrameParams, style: FloodStyle, widthCss: number): void {
    const gl = this.gl;
    gl.useProgram(this.floodProg);
    gl.blendFunc(gl.ONE, gl.ONE);
    const u = this.fu;
    gl.uniform2f(u.u_center, f.center[0], f.center[1]);
    gl.uniform1f(u.u_scale, f.scale);
    gl.uniform2f(u.u_viewport, f.viewport[0], f.viewport[1]);
    gl.uniform1f(u.u_t, style.t);
    gl.uniform1f(u.u_hot, style.hot);
    const cols = new Float32Array(36);
    style.colors.slice(0, 12).forEach((c, i) => cols.set(c.slice(0, 3), 3 * i));
    gl.uniform3fv(u.u_colors, cols);
    gl.bindVertexArray(batch.vao);
    // brilho (aditivo). Na cidade inteira há centenas de ruas por pixel: o brilho tem de ser
    // bem fraco para não estourar em branco; de perto ele aparece.
    const zoomIn = Math.min(1, widthCss / 2.5);
    gl.uniform1f(u.u_width, Math.max(widthCss * 5, 4) * f.dpr);
    gl.uniform1f(u.u_alpha, Math.max(0.006, 0.1 * zoomIn ** 1.5));
    gl.uniform1f(u.u_soft, 1);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count);
    // linha (alfa normal: mantém a cor de cada pessoa em vez de somar até o branco)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(u.u_width, widthCss * 1.2 * f.dpr);
    gl.uniform1f(u.u_alpha, 0.55 + 0.35 * zoomIn);
    gl.uniform1f(u.u_soft, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count);
    gl.bindVertexArray(null);
  }
}

export function hex(c: string, a = 1): RGBA {
  const n = parseInt(c.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}
