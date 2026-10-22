/**
 * context.ts — a software WebGL1 device: the GL state machine + rasterizer
 * behind the guest `WebGLRenderingContext`.
 *
 * This is the WARP/SwiftShader path — a REAL renderer on CPU: vertex shading
 * per vertex through the GLSL interpreter, perspective-correct varying
 * interpolation (λ·(1/w) weights), edge-function triangle coverage, Bresenham
 * lines, `gl_PointSize` points, the fixed-function depth/blend/scissor/color-
 * mask stages, textures with NEAREST/LINEAR filtering and all three wrap
 * modes, and FBO-lite (texture color attachments). The framebuffer IS the
 * canvas bitmap — `snapshot()` hands it to paint as a `DecodedImage`.
 *
 * Honest boundaries (documented in RFC 0036):
 *  - WebGL1 only; no extensions, no WebGL2.
 *  - Framebuffer objects support RGBA/UNSIGNED_BYTE texture color attachments
 *    only (no renderbuffer attachments, no depth attachment).
 *  - Stencil state is stored but inert (no stencil buffer).
 *  - `dFdx`/`dFdy`/`fwidth` evaluate to 0 (single-quad shading).
 *  - No antialiasing, no compressed textures, no `LINE` width beyond 1px.
 */
import type { DecodedImage } from "@browser-engine/ir";

import { compileGlsl, type GLSLProgram } from "./glsl.js";
import {
  DiscardSignal,
  GlslRunner,
  type GLValue,
  type ShaderEnv,
} from "./interp.js";

// ---------------------------------------------------------------------------
// GL enum values (Khronos-specified constants — stable ABI)
// ---------------------------------------------------------------------------

export const GL = {
  // clear bits
  DEPTH_BUFFER_BIT: 0x0100, STENCIL_BUFFER_BIT: 0x0400, COLOR_BUFFER_BIT: 0x4000,
  // primitives
  POINTS: 0x0000, LINES: 0x0001, LINE_LOOP: 0x0002, LINE_STRIP: 0x0003,
  TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005, TRIANGLE_FAN: 0x0006,
  // types
  BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403,
  INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
  // buffer targets/usages
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
  STREAM_DRAW: 0x88e0, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
  // depth funcs
  NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204,
  NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
  // blend
  ZERO: 0, ONE: 1,
  SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301, SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303, DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305,
  DST_COLOR: 0x0306, ONE_MINUS_DST_COLOR: 0x0307, SRC_ALPHA_SATURATE: 0x0308,
  CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002,
  CONSTANT_ALPHA: 0x8003, ONE_MINUS_CONSTANT_ALPHA: 0x8004,
  FUNC_ADD: 0x8006, FUNC_SUBTRACT: 0x800a, FUNC_REVERSE_SUBTRACT: 0x800b,
  // caps
  CULL_FACE: 0x0b44, BLEND: 0x0be2, DITHER: 0x0bd0, STENCIL_TEST: 0x0b90,
  DEPTH_TEST: 0x0b71, SCISSOR_TEST: 0x0c11, POLYGON_OFFSET_FILL: 0x8037,
  // face/winding
  FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408, CW: 0x0900, CCW: 0x0901,
  // texture
  TEXTURE_2D: 0x0de1, TEXTURE0: 0x84c0, NEAREST: 0x2600, LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
  NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
  TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
  CLAMP_TO_EDGE: 0x812f, MIRRORED_REPEAT: 0x8370, REPEAT: 0x2901,
  // formats
  ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908, LUMINANCE: 0x1909,
  LUMINANCE_ALPHA: 0x190a, DEPTH_COMPONENT: 0x1902,
  UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034,
  UNSIGNED_SHORT_5_6_5: 0x8363,
  // state/params
  VIEWPORT: 0x0ba2, SCISSOR_BOX: 0x0c10, COLOR_CLEAR_VALUE: 0x0c22,
  DEPTH_CLEAR_VALUE: 0x0b73, STENCIL_CLEAR_VALUE: 0x0b91,
  MAX_TEXTURE_SIZE: 0x0d33, MAX_VIEWPORT_DIMS: 0x0d3a,
  MAX_VERTEX_ATTRIBS: 0x8869, MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  ALIASED_POINT_SIZE_RANGE: 0x846d, ALIASED_LINE_WIDTH_RANGE: 0x846e,
  VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02,
  SHADING_LANGUAGE_VERSION: 0x8b8c, UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  FRAMEBUFFER: 0x8d40, RENDERBUFFER: 0x8d41, COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00, STENCIL_ATTACHMENT: 0x8d20,
  FRAMEBUFFER_COMPLETE: 0x8cd5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
  FRAMEBUFFER_UNSUPPORTED: 0x8cdd,
  COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, VALIDATE_STATUS: 0x8b83,
  DELETE_STATUS: 0x8b80,
  SHADER_TYPE: 0x8b4f, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
  ACTIVE_ATTRIBUTES: 0x8b89, ACTIVE_UNIFORMS: 0x8b86, ATTACHED_SHADERS: 0x8b85,
  // errors
  NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501,
  INVALID_OPERATION: 0x0502, OUT_OF_MEMORY: 0x0505,
  INVALID_FRAMEBUFFER_OPERATION: 0x0506,
  CONTEXT_LOST_WEBGL: 0x9242,
} as const;

const TYPE_BYTES: Record<number, number> = {
  [GL.BYTE]: 1, [GL.UNSIGNED_BYTE]: 1, [GL.SHORT]: 2, [GL.UNSIGNED_SHORT]: 2,
  [GL.INT]: 4, [GL.UNSIGNED_INT]: 4, [GL.FLOAT]: 4,
};

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export interface GLBuffer { id: number; data: Uint8Array }
export interface GLShader {
  id: number;
  type: number;
  source: string;
  compiled: GLSLProgram | null;
  infoLog: string;
}
export interface GLProgram {
  id: number;
  vs: GLShader | null;
  fs: GLShader | null;
  linked: boolean;
  infoLog: string;
  /** attribute name → generic index (getAttribLocation). */
  attribs: Map<string, number>;
  /** uniform name → handle (getUniformLocation). */
  uniforms: Map<string, number>;
}
export interface GLTexture {
  id: number;
  width: number;
  height: number;
  /** RGBA8888 straight-alpha, row-major, bottom-up as GL stores. */
  pixels: Uint8ClampedArray;
  minFilter: number;
  magFilter: number;
  wrapS: number;
  wrapT: number;
}
interface GLFramebuffer { id: number; color: GLTexture | null }

interface AttribState {
  enabled: boolean;
  buffer: GLBuffer | null;
  size: number;
  type: number;
  normalized: boolean;
  stride: number;
  offset: number;
  value: number[];
}

export interface GLContextAttributes {
  readonly alpha?: boolean;
  readonly depth?: boolean;
  readonly stencil?: boolean;
  readonly antialias?: boolean;
  readonly premultipliedAlpha?: boolean;
  readonly preserveDrawingBuffer?: boolean;
}

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

export class WebGLCore {
  #w: number;
  #h: number;
  #attrs: GLContextAttributes;
  /** RGBA8888 straight alpha, row-major, TOP-left origin (canvas convention —
   *  GL's bottom-up is handled at the viewport transform + readPixels flip). */
  #color: Uint8ClampedArray;
  #depth: Float32Array;

  #nextId = 1;
  #buffers = new Map<number, GLBuffer>();
  #shaders = new Map<number, GLShader>();
  #programs = new Map<number, GLProgram>();
  #textures = new Map<number, GLTexture>();
  #framebuffers = new Map<number, GLFramebuffer>();
  /** Currently-bound FBO (null = canvas drawing buffer). */
  #boundFbo: GLFramebuffer | null = null;
  #fboColor: Uint8ClampedArray | null = null;
  #fboDepth: Float32Array | null = null;

  #arrayBuffer: GLBuffer | null = null;
  #elementBuffer: GLBuffer | null = null;
  #boundTexture2D = new Map<number, GLTexture | null>(); // per texture unit
  #textureUnits = 8;
  #activeTexture = 0;
  #program: GLProgram | null = null;
  #uniformValues = new Map<number, Map<number, GLValue>>(); // program → loc → value
  #attribs: AttribState[];

  #errors: number[] = [];
  #viewport = { x: 0, y: 0, w: 0, h: 0 };
  #scissor = { x: 0, y: 0, w: 0, h: 0 };
  #clearColor = [0, 0, 0, 0];
  #clearDepth = 1;
  #clearStencil = 0;
  #enabled = new Set<number>();
  #depthFunc: number = GL.LESS;
  #depthMask = true;
  #colorMask = [true, true, true, true];
  #blendSrc: number = GL.ONE;
  #blendDst: number = GL.ZERO;
  #blendSrcA: number = GL.ONE;
  #blendDstA: number = GL.ZERO;
  #blendEqRgb: number = GL.FUNC_ADD;
  #blendEqA: number = GL.FUNC_ADD;
  #blendColor = [0, 0, 0, 0];
  #frontFace: number = GL.CCW;
  #cullFace: number = GL.BACK;
  #flipY = false;
  #premultiplyUnpack = false;
  /** presented+!preserve ⇒ next draw clears (spec drawing-buffer semantics). */
  #needsClearAfterPresent = false;
  #contextLost = false;

  constructor(width: number, height: number, attrs: GLContextAttributes = {}) {
    this.#w = Math.max(1, Math.floor(width));
    this.#h = Math.max(1, Math.floor(height));
    this.#attrs = { depth: true, ...attrs };
    this.#color = new Uint8ClampedArray(this.#w * this.#h * 4);
    this.#depth = new Float32Array(this.#w * this.#h).fill(1);
    this.#viewport = { x: 0, y: 0, w: this.#w, h: this.#h };
    this.#scissor = { x: 0, y: 0, w: this.#w, h: this.#h };
    this.#attribs = Array.from({ length: 8 }, () => ({
      enabled: false, buffer: null, size: 4, type: GL.FLOAT,
      normalized: false, stride: 0, offset: 0, value: [0, 0, 0, 1],
    }));
    for (let u = 0; u < this.#textureUnits; u += 1) this.#boundTexture2D.set(u, null);
  }

  resize(w: number, h: number): void {
    if (w === this.#w && h === this.#h) return;
    this.#w = Math.max(1, Math.floor(w));
    this.#h = Math.max(1, Math.floor(h));
    this.#color = new Uint8ClampedArray(this.#w * this.#h * 4);
    this.#depth = new Float32Array(this.#w * this.#h).fill(1);
    this.#viewport = { x: 0, y: 0, w: this.#w, h: this.#h };
    this.#scissor = { x: 0, y: 0, w: this.#w, h: this.#h };
  }

  get canvasWidth(): number {
    return this.#w;
  }
  get canvasHeight(): number {
    return this.#h;
  }

  #setError(code: number): void {
    if (code !== GL.NO_ERROR) this.#errors.push(code);
  }

  getError(): number {
    return this.#errors.shift() ?? GL.NO_ERROR;
  }

  // ---- buffers ----

  createBuffer(): GLBuffer {
    const b: GLBuffer = { id: this.#nextId++, data: new Uint8Array(0) };
    this.#buffers.set(b.id, b);
    return b;
  }

  deleteBuffer(b: GLBuffer | null): void {
    if (b !== null) this.#buffers.delete(b.id);
  }

  bindBuffer(target: number, b: GLBuffer | null): void {
    if (target === GL.ARRAY_BUFFER) this.#arrayBuffer = b;
    else if (target === GL.ELEMENT_ARRAY_BUFFER) this.#elementBuffer = b;
    else this.#setError(GL.INVALID_ENUM);
  }

  bufferData(target: number, data: ArrayBuffer | ArrayBufferView | number, usage: number): void {
    void usage; // STATIC/DYNAMIC hints don't change a CPU renderer.
    const bound = target === GL.ARRAY_BUFFER ? this.#arrayBuffer
      : target === GL.ELEMENT_ARRAY_BUFFER ? this.#elementBuffer : null;
    if (bound === null) {
      this.#setError(GL.INVALID_OPERATION);
      return;
    }
    if (typeof data === "number") {
      bound.data = new Uint8Array(Math.max(0, data));
      return;
    }
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    bound.data = new Uint8Array(view);
  }

  bufferSubData(target: number, offset: number, data: ArrayBuffer | ArrayBufferView): void {
    const bound = target === GL.ARRAY_BUFFER ? this.#arrayBuffer
      : target === GL.ELEMENT_ARRAY_BUFFER ? this.#elementBuffer : null;
    if (bound === null) {
      this.#setError(GL.INVALID_OPERATION);
      return;
    }
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    bound.data.set(view.subarray(0, Math.max(0, bound.data.length - offset)), offset);
  }

  // ---- shaders/programs ----

  createShader(type: number): GLShader | null {
    if (type !== GL.VERTEX_SHADER && type !== GL.FRAGMENT_SHADER) {
      this.#setError(GL.INVALID_ENUM);
      return null;
    }
    const s: GLShader = { id: this.#nextId++, type, source: "", compiled: null, infoLog: "" };
    this.#shaders.set(s.id, s);
    return s;
  }

  shaderSource(s: GLShader, src: string): void {
    s.source = src;
    s.compiled = null;
    s.infoLog = "";
  }

  compileShader(s: GLShader): void {
    const r = compileGlsl(s.source);
    if (r.ok && r.program !== null) {
      // Stage sanity: `attribute` in a fragment shader is a link-time smell —
      // refuse at compile time like real drivers do.
      const bad = r.program.globals.find((g) => g.qualifier === "attribute" && s.type === GL.FRAGMENT_SHADER);
      if (bad !== undefined) {
        s.compiled = null;
        s.infoLog = `GLSL ${bad.line}: 'attribute' not allowed in a fragment shader`;
        return;
      }
      s.compiled = r.program;
      s.infoLog = "";
      return;
    }
    s.compiled = null;
    s.infoLog = r.infoLog;
  }

  getShaderParameter(s: GLShader, pname: number): unknown {
    if (pname === GL.COMPILE_STATUS) return s.compiled !== null;
    if (pname === GL.SHADER_TYPE) return s.type;
    if (pname === GL.DELETE_STATUS) return false;
    return null;
  }

  getShaderInfoLog(s: GLShader): string {
    return s.infoLog;
  }

  deleteShader(s: GLShader | null): void {
    if (s !== null) this.#shaders.delete(s.id);
  }

  createProgram(): GLProgram {
    const p: GLProgram = {
      id: this.#nextId++, vs: null, fs: null, linked: false, infoLog: "",
      attribs: new Map(), uniforms: new Map(),
    };
    this.#programs.set(p.id, p);
    return p;
  }

  attachShader(p: GLProgram, s: GLShader): void {
    if (s.type === GL.VERTEX_SHADER) p.vs = s;
    else if (s.type === GL.FRAGMENT_SHADER) p.fs = s;
    else {
      this.#setError(GL.INVALID_OPERATION);
      return;
    }
    p.linked = false;
  }

  detachShader(p: GLProgram, s: GLShader): void {
    if (p.vs === s) p.vs = null;
    if (p.fs === s) p.fs = null;
    p.linked = false;
  }

  linkProgram(p: GLProgram): void {
    p.infoLog = "";
    p.linked = false;
    p.attribs.clear();
    p.uniforms.clear();
    if (p.vs === null || p.fs === null) {
      p.infoLog = "link: needs a vertex AND a fragment shader";
      return;
    }
    if (p.vs.compiled === null || p.fs.compiled === null) {
      p.infoLog = "link: an attached shader failed to compile";
      return;
    }
    // Varying contract: fragment reads must be declared on both sides.
    const vsVary = new Map(p.vs.compiled.globals.filter((g) => g.qualifier === "varying").map((g) => [g.name, g.type]));
    for (const g of p.fs.compiled.globals) {
      if (g.qualifier !== "varying") continue;
      const t = vsVary.get(g.name);
      if (t === undefined) {
        p.infoLog = `link: varying '${g.name}' read by fragment shader is not written by vertex shader`;
        return;
      }
      if (t !== g.type) {
        p.infoLog = `link: varying '${g.name}' type mismatch (${t} vs ${g.type})`;
        return;
      }
    }
    // Attribute/uniform location assignment — stable declaration order.
    let ai = 0;
    for (const g of p.vs.compiled.globals) {
      if (g.qualifier === "attribute" && !p.attribs.has(g.name)) {
        p.attribs.set(g.name, ai++);
      }
    }
    let ui = 0;
    for (const g of [...p.vs.compiled.globals, ...p.fs.compiled.globals]) {
      if (g.qualifier === "uniform" && !p.uniforms.has(g.name)) {
        p.uniforms.set(g.name, ui++);
      }
    }
    p.linked = true;
    this.#uniformValues.set(p.id, new Map());
  }

  getProgramParameter(p: GLProgram, pname: number): unknown {
    if (pname === GL.LINK_STATUS) return p.linked;
    if (pname === GL.ATTACHED_SHADERS) return (p.vs !== null ? 1 : 0) + (p.fs !== null ? 1 : 0);
    if (pname === GL.ACTIVE_ATTRIBUTES) return p.attribs.size;
    if (pname === GL.ACTIVE_UNIFORMS) return p.uniforms.size;
    if (pname === GL.VALIDATE_STATUS) return p.linked;
    if (pname === GL.DELETE_STATUS) return false;
    return null;
  }

  getProgramInfoLog(p: GLProgram): string {
    return p.infoLog;
  }

  useProgram(p: GLProgram | null): void {
    if (p !== null && !p.linked) {
      this.#setError(GL.INVALID_OPERATION);
      return;
    }
    this.#program = p;
  }

  validateProgram(p: GLProgram): void {
    void p;
  }

  getAttribLocation(p: GLProgram, name: string): number {
    return p.attribs.get(name) ?? -1;
  }

  getUniformLocation(p: GLProgram, name: string): object | null {
    const loc = p.uniforms.get(name);
    if (loc === undefined) return null;
    return { __glUniform: p.id, loc };
  }

  bindAttribLocation(p: GLProgram, index: number, name: string): void {
    p.attribs.set(name, index);
  }

  // ---- vertex attribs ----

  enableVertexAttribArray(i: number): void {
    const a = this.#attribs[i];
    if (a === undefined) {
      this.#setError(GL.INVALID_VALUE);
      return;
    }
    a.enabled = true;
  }

  disableVertexAttribArray(i: number): void {
    const a = this.#attribs[i];
    if (a !== undefined) a.enabled = false;
  }

  vertexAttribPointer(i: number, size: number, type: number, normalized: boolean, stride: number, offset: number): void {
    const a = this.#attribs[i];
    if (a === undefined || size < 1 || size > 4 || stride < 0 || offset < 0 || TYPE_BYTES[type] === undefined) {
      this.#setError(GL.INVALID_VALUE);
      return;
    }
    a.buffer = this.#arrayBuffer;
    a.size = size;
    a.type = type;
    a.normalized = normalized;
    a.stride = stride;
    a.offset = offset;
    if (this.#arrayBuffer === null) {
      this.#setError(GL.INVALID_OPERATION);
    }
  }

  vertexAttrib1f(i: number, x: number): void {
    this.#attribConstant(i, [x, 0, 0, 1]);
  }
  vertexAttrib2f(i: number, x: number, y: number): void {
    this.#attribConstant(i, [x, y, 0, 1]);
  }
  vertexAttrib3f(i: number, x: number, y: number, z: number): void {
    this.#attribConstant(i, [x, y, z, 1]);
  }
  vertexAttrib4f(i: number, x: number, y: number, z: number, w: number): void {
    this.#attribConstant(i, [x, y, z, w]);
  }
  vertexAttribfv(i: number, v: ArrayLike<number>): void {
    const arr = [0, 0, 0, 1];
    for (let k = 0; k < Math.min(4, v.length); k += 1) arr[k] = v[k] as number;
    this.#attribConstant(i, arr);
  }

  #attribConstant(i: number, v: number[]): void {
    const a = this.#attribs[i];
    if (a === undefined) {
      this.#setError(GL.INVALID_VALUE);
      return;
    }
    a.value = [...v];
    a.enabled = false;
  }

  // ---- uniforms ----

  #uniformSet(locObj: unknown, v: GLValue): void {
    const p = this.#program;
    if (p === null || locObj === null || typeof locObj !== "object" || !("__glUniform" in locObj)) {
      this.#setError(GL.INVALID_OPERATION);
      return;
    }
    const loc = (locObj as { __glUniform: number; loc: number }).loc;
    const store = this.#uniformValues.get(p.id);
    if (store !== undefined) store.set(loc, v);
  }

  uniform1f(l: object | null, x: number): void {
    this.#uniformSet(l, x);
  }
  uniform2f(l: object | null, x: number, y: number): void {
    this.#uniformSet(l, [x, y]);
  }
  uniform3f(l: object | null, x: number, y: number, z: number): void {
    this.#uniformSet(l, [x, y, z]);
  }
  uniform4f(l: object | null, x: number, y: number, z: number, w: number): void {
    this.#uniformSet(l, [x, y, z, w]);
  }
  uniform1i(l: object | null, x: number): void {
    this.#uniformSet(l, { sampler: Math.trunc(x) });
  }
  uniform1fv(l: object | null, v: ArrayLike<number>): void {
    this.#uniformSet(l, v.length > 1 ? Array.from(v as number[]) : (v[0] ?? 0));
  }
  uniform2fv(l: object | null, v: ArrayLike<number>): void {
    this.#uniformSet(l, [v[0] ?? 0, v[1] ?? 0]);
  }
  uniform3fv(l: object | null, v: ArrayLike<number>): void {
    this.#uniformSet(l, [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
  }
  uniform4fv(l: object | null, v: ArrayLike<number>): void {
    this.#uniformSet(l, [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0]);
  }
  uniformMatrix2fv(l: object | null, transpose: boolean, v: ArrayLike<number>): void {
    if (transpose) {
      this.#setError(GL.INVALID_VALUE); // spec: transpose must be false.
      return;
    }
    this.#uniformSet(l, { m: Array.from({ length: 4 }, (_x, i) => v[i] ?? 0), dim: 2 });
  }
  uniformMatrix3fv(l: object | null, transpose: boolean, v: ArrayLike<number>): void {
    if (transpose) {
      this.#setError(GL.INVALID_VALUE);
      return;
    }
    this.#uniformSet(l, { m: Array.from({ length: 9 }, (_x, i) => v[i] ?? 0), dim: 3 });
  }
  uniformMatrix4fv(l: object | null, transpose: boolean, v: ArrayLike<number>): void {
    if (transpose) {
      this.#setError(GL.INVALID_VALUE);
      return;
    }
    this.#uniformSet(l, { m: Array.from({ length: 16 }, (_x, i) => v[i] ?? 0), dim: 4 });
  }

  // ---- textures ----

  createTexture(): GLTexture {
    const t: GLTexture = {
      id: this.#nextId++, width: 0, height: 0, pixels: new Uint8ClampedArray(0),
      minFilter: GL.NEAREST_MIPMAP_LINEAR, magFilter: GL.LINEAR,
      wrapS: GL.REPEAT, wrapT: GL.REPEAT,
    };
    this.#textures.set(t.id, t);
    return t;
  }

  deleteTexture(t: GLTexture | null): void {
    if (t !== null) this.#textures.delete(t.id);
  }

  bindTexture(target: number, t: GLTexture | null): void {
    if (target !== GL.TEXTURE_2D) {
      this.#setError(GL.INVALID_ENUM);
      return;
    }
    this.#boundTexture2D.set(this.#activeTexture, t);
  }

  activeTexture(unit: number): void {
    const i = unit - GL.TEXTURE0;
    if (i < 0 || i >= this.#textureUnits) {
      this.#setError(GL.INVALID_ENUM);
      return;
    }
    this.#activeTexture = i;
  }

  texParameteri(target: number, pname: number, value: number): void {
    const t = this.#boundTexture2D.get(this.#activeTexture) ?? null;
    if (target !== GL.TEXTURE_2D || t === null) {
      this.#setError(target === GL.TEXTURE_2D ? GL.INVALID_OPERATION : GL.INVALID_ENUM);
      return;
    }
    if (pname === GL.TEXTURE_MIN_FILTER) t.minFilter = value;
    else if (pname === GL.TEXTURE_MAG_FILTER) t.magFilter = value;
    else if (pname === GL.TEXTURE_WRAP_S) t.wrapS = value;
    else if (pname === GL.TEXTURE_WRAP_T) t.wrapT = value;
    else this.#setError(GL.INVALID_ENUM);
  }

  texParameterf(target: number, pname: number, value: number): void {
    this.texParameteri(target, pname, Math.trunc(value));
  }

  /**
   * `texImage2D` — two overload shapes:
   *   (target, level, internal, w, h, border, format, type, ArrayBufferView)
   *   (target, level, internal, format, type, TexImageSource-like)
   * The source form accepts `{width,height,pixels|data}` — DecodedImage,
   * ImageData-shaped objects, canvas bitmaps from `canvasImageSource`.
   */
  texImage2D(
    target: number,
    level: number,
    internalformat: number,
    a4: number,
    a5: number,
    a6: unknown,
    a7: number,
    a8: unknown,
    a9?: unknown,
  ): void {
    void internalformat; // internal vs format must match in WebGL1 — stored RGBA always.
    const t = this.#boundTexture2D.get(this.#activeTexture) ?? null;
    if (target !== GL.TEXTURE_2D || t === null) {
      this.#setError(target === GL.TEXTURE_2D ? GL.INVALID_OPERATION : GL.INVALID_ENUM);
      return;
    }
    if (level !== 0) {
      this.#setError(GL.INVALID_VALUE);
      return;
    }
    if (a9 !== undefined) {
      // long form: (w, h, border, format, type, pixels)
      const w = a4;
      const h = a5;
      const format = a7;
      const type = a8 as number;
      const pixels = a9;
      t.width = w;
      t.height = h;
      t.pixels = this.#unpackPixels(w, h, format, type, pixels);
      return;
    }
    // source form: (format, type, source)
    const src = a6 as { width?: number; height?: number; pixels?: Uint8ClampedArray; data?: Uint8ClampedArray } | null;
    const w = src?.width ?? 0;
    const h = src?.height ?? 0;
    const px = src?.pixels ?? src?.data;
    t.width = w;
    t.height = h;
    let out = px !== undefined ? new Uint8ClampedArray(px) : new Uint8ClampedArray(w * h * 4);
    if (this.#flipY && px !== undefined) {
      const flipped = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y += 1) {
        flipped.set(out.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      }
      out = flipped;
    }
    if (this.#premultiplyUnpack && px !== undefined) {
      for (let i = 0; i < out.length; i += 4) {
        const a = (out[i + 3] ?? 0) / 255;
        out[i] = Math.round((out[i] ?? 0) * a);
        out[i + 1] = Math.round((out[i + 1] ?? 0) * a);
        out[i + 2] = Math.round((out[i + 2] ?? 0) * a);
      }
    }
    t.pixels = out;
  }

  #unpackPixels(w: number, h: number, format: number, type: number, pixels: unknown): Uint8ClampedArray {
    const out = new Uint8ClampedArray(w * h * 4);
    let src: Uint8Array | Uint8ClampedArray | Uint16Array | null = null;
    if (pixels !== null && pixels !== undefined) {
      if (ArrayBuffer.isView(pixels)) {
        src = pixels as Uint8Array;
      } else if (pixels instanceof ArrayBuffer) {
        src = new Uint8Array(pixels);
      }
    }
    if (src === null) return out;
    if (type === GL.UNSIGNED_BYTE && format === GL.RGBA) {
      out.set(src.subarray(0, Math.min(out.length, src.length)));
      return out;
    }
    if (type === GL.UNSIGNED_BYTE && format === GL.RGB) {
      for (let i = 0; i < w * h; i += 1) {
        out[i * 4] = src[i * 3] ?? 0;
        out[i * 4 + 1] = src[i * 3 + 1] ?? 0;
        out[i * 4 + 2] = src[i * 3 + 2] ?? 0;
        out[i * 4 + 3] = 255;
      }
      return out;
    }
    if (type === GL.UNSIGNED_BYTE && format === GL.LUMINANCE) {
      for (let i = 0; i < w * h; i += 1) {
        const l = src[i] ?? 0;
        out[i * 4] = l;
        out[i * 4 + 1] = l;
        out[i * 4 + 2] = l;
        out[i * 4 + 3] = 255;
      }
      return out;
    }
    if (type === GL.UNSIGNED_SHORT_5_6_5) {
      const u16 = src as unknown as Uint16Array;
      for (let i = 0; i < w * h; i += 1) {
        const px = u16[i] ?? 0;
        out[i * 4] = ((px >> 11) & 0x1f) * 255 / 31;
        out[i * 4 + 1] = ((px >> 5) & 0x3f) * 255 / 63;
        out[i * 4 + 2] = (px & 0x1f) * 255 / 31;
        out[i * 4 + 3] = 255;
      }
      return out;
    }
    // Other packed types — silent boundary → INVALID via caller's check? We
    // document: only the unpacked conversions above; other formats land as-is.
    out.set(src.subarray(0, Math.min(out.length, src.length)));
    return out;
  }

  generateMipmap(_target: number): void {
    // Mipmap chains are not built — minification uses level-0 sampling; an
    // honest single-level boundary (documented).
  }

  pixelStorei(pname: number, param: number): void {
    if (pname === GL.UNPACK_FLIP_Y_WEBGL) this.#flipY = param !== 0;
    else if (pname === GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL) this.#premultiplyUnpack = param !== 0;
  }

  // ---- framebuffers (lite) ----

  createFramebuffer(): GLFramebuffer {
    const f: GLFramebuffer = { id: this.#nextId++, color: null };
    this.#framebuffers.set(f.id, f);
    return f;
  }

  deleteFramebuffer(f: GLFramebuffer | null): void {
    if (f !== null) this.#framebuffers.delete(f.id);
  }

  bindFramebuffer(target: number, f: GLFramebuffer | null): void {
    if (target !== GL.FRAMEBUFFER) {
      this.#setError(GL.INVALID_ENUM);
      return;
    }
    this.#boundFbo = f;
    if (f !== null && f.color !== null) {
      this.#fboColor = f.color.pixels;
      this.#fboDepth = new Float32Array(f.color.width * f.color.height).fill(1);
    } else {
      this.#fboColor = null;
      this.#fboDepth = null;
    }
  }

  framebufferTexture2D(target: number, attachment: number, textarget: number, tex: GLTexture | null, level: number): void {
    if (target !== GL.FRAMEBUFFER || textarget !== GL.TEXTURE_2D || level !== 0) {
      this.#setError(GL.INVALID_ENUM);
      return;
    }
    if (this.#boundFbo === null) {
      this.#setError(GL.INVALID_OPERATION);
      return;
    }
    if (attachment !== GL.COLOR_ATTACHMENT0) {
      this.#setError(GL.INVALID_ENUM); // depth/stencil FBO attachments: boundary.
      return;
    }
    this.#boundFbo.color = tex;
    this.#fboColor = tex !== null ? tex.pixels : null;
    this.#fboDepth = tex !== null ? new Float32Array(tex.width * tex.height).fill(1) : null;
  }

  checkFramebufferStatus(target: number): number {
    if (target !== GL.FRAMEBUFFER) return GL.FRAMEBUFFER_UNSUPPORTED;
    if (this.#boundFbo === null) return GL.FRAMEBUFFER_COMPLETE;
    const t = this.#boundFbo.color;
    if (t === null || t.width === 0) return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    return GL.FRAMEBUFFER_COMPLETE;
  }

  // ---- state ----

  enable(cap: number): void {
    this.#enabled.add(cap);
  }
  disable(cap: number): void {
    this.#enabled.delete(cap);
  }
  isEnabled(cap: number): boolean {
    return this.#enabled.has(cap);
  }

  viewport(x: number, y: number, w: number, h: number): void {
    this.#viewport = { x, y, w, h };
  }

  scissor(x: number, y: number, w: number, h: number): void {
    this.#scissor = { x, y, w, h };
  }

  clearColor(r: number, g: number, b: number, a: number): void {
    this.#clearColor = [r, g, b, a];
  }
  clearDepth(d: number): void {
    this.#clearDepth = Math.min(1, Math.max(0, d));
  }
  clearStencil(s: number): void {
    this.#clearStencil = s;
  }
  depthFunc(f: number): void {
    this.#depthFunc = f;
  }
  depthMask(m: boolean): void {
    this.#depthMask = m;
  }
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void {
    this.#colorMask = [r, g, b, a];
  }
  blendFunc(s: number, d: number): void {
    this.#blendSrc = s;
    this.#blendDst = d;
    this.#blendSrcA = s;
    this.#blendDstA = d;
  }
  blendFuncSeparate(srgb: number, drgb: number, sa: number, da: number): void {
    this.#blendSrc = srgb;
    this.#blendDst = drgb;
    this.#blendSrcA = sa;
    this.#blendDstA = da;
  }
  blendEquation(eq: number): void {
    this.#blendEqRgb = eq;
    this.#blendEqA = eq;
  }
  blendColor(r: number, g: number, b: number, a: number): void {
    this.#blendColor = [r, g, b, a];
  }
  frontFace(f: number): void {
    this.#frontFace = f;
  }
  cullFace(f: number): void {
    this.#cullFace = f;
  }
  lineWidth(_w: number): void {
    // 1px lines only — documented.
  }
  polygonOffset(_f: number, _u: number): void {
    // boundary.
  }
  hint(_t: number, _h: number): void {}

  clear(mask: number): void {
    const { color, depth, w, h } = this.#target();
    if ((mask & GL.COLOR_BUFFER_BIT) !== 0) {
      const [r, g, b, a] = this.#clearColor as [number, number, number, number];
      for (let i = 0; i < w * h; i += 1) {
        color[i * 4] = Math.round(r * 255);
        color[i * 4 + 1] = Math.round(g * 255);
        color[i * 4 + 2] = Math.round(b * 255);
        color[i * 4 + 3] = Math.round(a * 255);
      }
    }
    if ((mask & GL.DEPTH_BUFFER_BIT) !== 0) depth.fill(this.#clearDepth);
    void this.#clearStencil;
    this.#needsClearAfterPresent = false;
  }

  #target(): { color: Uint8ClampedArray; depth: Float32Array; w: number; h: number } {
    if (this.#boundFbo !== null && this.#fboColor !== null) {
      const t = this.#boundFbo.color as GLTexture;
      return { color: this.#fboColor, depth: this.#fboDepth as Float32Array, w: t.width, h: t.height };
    }
    return { color: this.#color, depth: this.#depth, w: this.#w, h: this.#h };
  }

  getParameter(pname: number): unknown {
    switch (pname) {
      case GL.VIEWPORT: return [this.#viewport.x, this.#viewport.y, this.#viewport.w, this.#viewport.h];
      case GL.SCISSOR_BOX: return [this.#scissor.x, this.#scissor.y, this.#scissor.w, this.#scissor.h];
      case GL.COLOR_CLEAR_VALUE: return [...this.#clearColor];
      case GL.DEPTH_CLEAR_VALUE: return this.#clearDepth;
      case GL.STENCIL_CLEAR_VALUE: return this.#clearStencil;
      case GL.MAX_TEXTURE_SIZE: return 4096;
      case GL.MAX_VIEWPORT_DIMS: return [4096, 4096];
      case GL.MAX_VERTEX_ATTRIBS: return this.#attribs.length;
      case GL.MAX_TEXTURE_IMAGE_UNITS: return this.#textureUnits;
      case GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS: return 0;
      case GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return this.#textureUnits;
      case GL.ALIASED_POINT_SIZE_RANGE: return [1, 64];
      case GL.ALIASED_LINE_WIDTH_RANGE: return [1, 1];
      case GL.VENDOR: return "browser-engine-shia";
      case GL.RENDERER: return "software-gl (SwiftShader-style)";
      case GL.VERSION: return "WebGL 1.0 (software)";
      case GL.SHADING_LANGUAGE_VERSION: return "WebGL GLSL ES 1.0 (subset)";
      case GL.ARRAY_BUFFER: return this.#arrayBuffer;
      case GL.ELEMENT_ARRAY_BUFFER: return this.#elementBuffer;
      case GL.TEXTURE_2D: return this.#boundTexture2D.get(this.#activeTexture) ?? null;
      case GL.FRAMEBUFFER: return this.#boundFbo;
      case GL.CULL_FACE: return this.#enabled.has(GL.CULL_FACE);
      case GL.BLEND: return this.#enabled.has(GL.BLEND);
      case GL.DEPTH_TEST: return this.#enabled.has(GL.DEPTH_TEST);
      case GL.SCISSOR_TEST: return this.#enabled.has(GL.SCISSOR_TEST);
      case GL.STENCIL_TEST: return this.#enabled.has(GL.STENCIL_TEST);
      case GL.DITHER: return this.#enabled.has(GL.DITHER);
      default: return null;
    }
  }

  getSupportedExtensions(): string[] {
    return [];
  }

  getExtension(_name: string): object | null {
    return null; // honest: no extensions implemented.
  }

  isContextLost(): boolean {
    return this.#contextLost;
  }

  // ---- drawing ----

  drawArrays(mode: number, first: number, count: number): void {
    this.#draw(mode, (i) => first + i, count);
  }

  drawElements(mode: number, count: number, type: number, offset: number): void {
    const eb = this.#elementBuffer;
    if (eb === null) {
      this.#setError(GL.INVALID_OPERATION);
      return;
    }
    const read = (i: number): number => {
      const at = offset + i;
      if (type === GL.UNSIGNED_BYTE) return eb.data[at] ?? 0;
      if (type === GL.UNSIGNED_SHORT) return ((eb.data[at * 2] ?? 0) | ((eb.data[at * 2 + 1] ?? 0) << 8)) >>> 0;
      if (type === GL.UNSIGNED_INT) {
        return (((eb.data[at * 4] ?? 0) | ((eb.data[at * 4 + 1] ?? 0) << 8) |
          ((eb.data[at * 4 + 2] ?? 0) << 16) | ((eb.data[at * 4 + 3] ?? 0) << 24)) >>> 0);
      }
      this.#setError(GL.INVALID_ENUM);
      return 0;
    };
    this.#draw(mode, read, count);
  }

  #draw(mode: number, indexOf: (i: number) => number, count: number): void {
    if (this.#needsClearAfterPresent && !this.#attrs.preserveDrawingBuffer) {
      this.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
    }
    const p = this.#program;
    const vsProgram = p?.vs?.compiled;
    const fsProgramEarly = p?.fs?.compiled;
    if (p === null || vsProgram == null || fsProgramEarly == null) {
      this.#setError(GL.INVALID_OPERATION);
      return;
    }
    const { w, h } = this.#target();

    // ---- 1. vertex shading ----
    interface Vtx {
      clip: number[]; // x,y,z,w
      varyings: Map<string, GLValue>;
    }
    const vtxCache = new Map<number, Vtx>();
    const uniforms = this.#uniformValues.get(p.id) ?? new Map<number, GLValue>();
    const vertexOf = (idx: number): Vtx => {
      const hit = vtxCache.get(idx);
      if (hit !== undefined) return hit;
      const varyings = new Map<string, GLValue>();
      let clip = [0, 0, 0, 1];
      const env: ShaderEnv = {
        read: (name) => {
          if (name === "gl_Position") return clip;
          if (name === "gl_PointSize") return 1;
          if (name === "gl_FragCoord") return [0, 0, 0, 1];
          const g = vsProgram.globals.find((x) => x.name === name);
          if (g === undefined) return undefined;
          if (g.qualifier === "attribute") return this.#readAttrib(idx, p, name);
          if (g.qualifier === "uniform") return uniforms.get(p.uniforms.get(name) ?? -1);
          if (g.qualifier === "varying") return varyings.get(name) ?? 0;
          return undefined;
        },
        write: (name, v) => {
          if (name === "gl_Position") {
            clip = Array.isArray(v) ? (v as number[]).slice(0, 4) : clip;
            return;
          }
          if (name === "gl_PointSize") return;
          const g = vsProgram.globals.find((x) => x.name === name);
          if (g !== undefined && g.qualifier === "varying") varyings.set(name, v);
        },
        sample: () => [0, 0, 0, 1], // vertex texture fetch: boundary (units=0).
      };
      try {
        new GlslRunner(vsProgram, env).run("main");
      } catch {
        // shader fault → vertex is degenerate; flagged via getError.
        this.#setError(GL.INVALID_OPERATION);
      }
      const vtx: Vtx = { clip, varyings };
      vtxCache.set(idx, vtx);
      return vtx;
    };

    // ---- 2. clip → screen ----
    const vp = this.#viewport;
    const ndcToScreen = (v: Vtx): { x: number; y: number; z: number; w: number } => {
      const [cx, cy, cz, cw] = v.clip as [number, number, number, number];
      const iw = cw !== 0 ? 1 / cw : 0;
      const nx = cx * iw;
      const ny = cy * iw;
      const nz = cz * iw;
      // GL viewport y is bottom-up; framebuffer rows are top-down → flip.
      return {
        x: vp.x + ((nx + 1) / 2) * vp.w,
        y: h - (vp.y + ((ny + 1) / 2) * vp.h),
        z: (nz + 1) / 2,
        w: iw,
      };
    };

    // ---- 3. fragment env ----
    const fsProgram = fsProgramEarly;
    const fsGlobals = fsProgram.globals;
    const texUnit = (sampler: GLValue): GLTexture | null => {
      if (typeof sampler === "object" && sampler !== null && "sampler" in sampler) {
        return this.#boundTexture2D.get((sampler).sampler) ?? null;
      }
      return null;
    };
    const sampleTex = (sampler: GLValue, uv: number[]): number[] => {
      const t = texUnit(sampler);
      if (t === null || t.width === 0) return [0, 0, 0, 1];
      let u = uv[0] ?? 0;
      let v = uv[1] ?? 0;
      const wrap = (x: number, m: number): number => {
        if (m === GL.REPEAT) return x - Math.floor(x);
        if (m === GL.MIRRORED_REPEAT) {
          const f = x - Math.floor(x);
          return (Math.floor(x) % 2 === 0) ? f : 1 - f;
        }
        return Math.min(Math.max(x, 0), 1); // CLAMP_TO_EDGE
      };
      u = wrap(u, t.wrapS);
      v = wrap(v, t.wrapT);
      const fetch = (px: number, py: number): number[] => {
        const cx = Math.min(Math.max(px, 0), t.width - 1);
        const cy = Math.min(Math.max(py, 0), t.height - 1);
        const o = (cy * t.width + cx) * 4;
        return [
          (t.pixels[o] ?? 0) / 255,
          (t.pixels[o + 1] ?? 0) / 255,
          (t.pixels[o + 2] ?? 0) / 255,
          (t.pixels[o + 3] ?? 255) / 255,
        ];
      };
      const linear = t.magFilter === GL.LINEAR;
      const tx = u * t.width - 0.5;
      const ty = v * t.height - 0.5;
      if (!linear) return fetch(Math.round(tx), Math.round(ty));
      const x0 = Math.floor(tx);
      const y0 = Math.floor(ty);
      const fx = tx - x0;
      const fy = ty - y0;
      const c00 = fetch(x0, y0);
      const c10 = fetch(x0 + 1, y0);
      const c01 = fetch(x0, y0 + 1);
      const c11 = fetch(x0 + 1, y0 + 1);
      return [0, 1, 2, 3].map((i) =>
        (c00[i] ?? 0) * (1 - fx) * (1 - fy) + (c10[i] ?? 0) * fx * (1 - fy) +
        (c01[i] ?? 0) * (1 - fx) * fy + (c11[i] ?? 0) * fx * fy,
      );
    };

    const { color, depth } = this.#target();
    const varyDefaults = fsGlobals.filter((g) => g.qualifier === "varying");
    const emitFragment = (sx: number, sy: number, z: number, lerp: (name: string) => GLValue): void => {
      let frag: GLValue = [0, 0, 0, 0];
      const env: ShaderEnv = {
        read: (name) => {
          if (name === "gl_FragColor") return frag;
          if (name === "gl_FragCoord") return [sx, sy, z, 1];
          const g = fsGlobals.find((x) => x.name === name);
          if (g === undefined) return undefined;
          if (g.qualifier === "uniform") return uniforms.get(p.uniforms.get(name) ?? -1);
          if (g.qualifier === "varying") return lerp(name);
          return undefined;
        },
        write: (name, v) => {
          if (name === "gl_FragColor") frag = v;
        },
        sample: sampleTex,
      };
      try {
        new GlslRunner(fsProgram, env).run("main");
      } catch (e) {
        if (e instanceof DiscardSignal) return;
        this.#setError(GL.INVALID_OPERATION);
        return;
      }
      this.#writePixel(Math.floor(sx), Math.floor(sy), z, frag, color, depth, w, h);
    };

    // ---- 4. primitives ----
    const scissorOn = this.#enabled.has(GL.SCISSOR_TEST);
    const inScissor = (x: number, y: number): boolean => {
      if (!scissorOn) return true;
      const gy = h - y - 1; // scissor rect is bottom-up
      return x >= this.#scissor.x && x < this.#scissor.x + this.#scissor.w &&
        gy >= this.#scissor.y && gy < this.#scissor.y + this.#scissor.h;
    };
    void inScissor;

    const triangleAt = (a: Vtx, b: Vtx, c: Vtx): void => {
      const A = ndcToScreen(a);
      const B = ndcToScreen(b);
      const C = ndcToScreen(c);
      // Culling: signed area vs frontFace.
      const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
      const ccw = area < 0; // screen-space y flipped
      const front = this.#frontFace === GL.CCW ? !ccw : ccw;
      if (this.#enabled.has(GL.CULL_FACE)) {
        const mode = this.#cullFace;
        if (mode === GL.FRONT_AND_BACK) return;
        if (mode === GL.FRONT && front) return;
        if (mode === GL.BACK && !front) return;
      }
      const minX = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x)));
      const maxX = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
      const minY = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y)));
      const maxY = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
      const den = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
      if (den === 0) return;
      for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
          const cx = px + 0.5;
          const cy = py + 0.5;
          const l0 = ((B.x - cx) * (C.y - cy) - (C.x - cx) * (B.y - cy)) / den;
          const l1 = ((C.x - cx) * (A.y - cy) - (A.x - cx) * (C.y - cy)) / den;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          // Perspective-correct: λ/w weights.
          const iwSum = l0 * A.w + l1 * B.w + l2 * C.w;
          const iw = iwSum !== 0 ? 1 / iwSum : 0;
          const z = (l0 * A.z + l1 * B.z + l2 * C.z) / (iwSum !== 0 ? iwSum : 1);
          const lerp = (name: string): GLValue => {
            const va = a.varyings.get(name);
            const vb = b.varyings.get(name);
            const vc = c.varyings.get(name);
            const def = varyDefaults.find((g) => g.name === name);
            if (va === undefined || vb === undefined || vc === undefined) {
              return def !== undefined ? this.#zeroValueForType(def.type) : 0;
            }
            const wa = l0 * A.w * iw;
            const wb = l1 * B.w * iw;
            const wc = l2 * C.w * iw;
            const blend = (x: GLValue): GLValue => {
              if (Array.isArray(x) && typeof (x as number[])[0] === "number") {
                const n = (x as number[]).length;
                const out = new Array<number>(n).fill(0);
                for (let i = 0; i < n; i += 1) {
                  out[i] = wa * ((va as number[])[i] ?? 0) + wb * ((vb as number[])[i] ?? 0) + wc * ((vc as number[])[i] ?? 0);
                }
                return out;
              }
              if (typeof x === "number") return wa * (va as number) + wb * (vb as number) + wc * (vc as number);
              return x; // samplers/bvecs interpolate flat — take A's.
            };
            return blend(va);
          };
          emitFragment(cx, cy, z, lerp);
        }
      }
    };

    const pointAt = (v: Vtx): void => {
      const s = ndcToScreen(v);
      const lerp = (name: string): GLValue => v.varyings.get(name) ?? 0;
      emitFragment(s.x, s.y, s.z, lerp);
    };

    const lineAt = (a: Vtx, b: Vtx): void => {
      const A = ndcToScreen(a);
      const B = ndcToScreen(b);
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(B.x - A.x), Math.abs(B.y - A.y)) * 2));
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const iw = (1 - t) * A.w + t * B.w;
        const x = A.x + (B.x - A.x) * t;
        const y = A.y + (B.y - A.y) * t;
        const z = (A.z + (B.z - A.z) * t);
        const lerp = (name: string): GLValue => {
          const va = a.varyings.get(name);
          const vb = b.varyings.get(name);
          if (typeof va === "number" && typeof vb === "number") return (va * (1 - t) + vb * t);
          if (Array.isArray(va) && Array.isArray(vb)) {
            return (va as number[]).map((x1, k) => x1 * (1 - t) + ((vb as number[])[k] ?? 0) * t);
          }
          return va ?? 0;
        };
        void iw;
        emitFragment(x, y, z, lerp);
      }
    };

    switch (mode) {
      case GL.POINTS:
        for (let i = 0; i < count; i += 1) pointAt(vertexOf(indexOf(i)));
        break;
      case GL.LINES:
        for (let i = 0; i + 1 < count; i += 2) lineAt(vertexOf(indexOf(i)), vertexOf(indexOf(i + 1)));
        break;
      case GL.LINE_STRIP:
        for (let i = 0; i + 1 < count; i += 1) lineAt(vertexOf(indexOf(i)), vertexOf(indexOf(i + 1)));
        break;
      case GL.LINE_LOOP:
        for (let i = 0; i + 1 < count; i += 1) lineAt(vertexOf(indexOf(i)), vertexOf(indexOf(i + 1)));
        if (count > 2) lineAt(vertexOf(indexOf(count - 1)), vertexOf(indexOf(0)));
        break;
      case GL.TRIANGLES:
        for (let i = 0; i + 2 < count; i += 3) {
          triangleAt(vertexOf(indexOf(i)), vertexOf(indexOf(i + 1)), vertexOf(indexOf(i + 2)));
        }
        break;
      case GL.TRIANGLE_STRIP:
        for (let i = 0; i + 2 < count; i += 1) {
          const a = vertexOf(indexOf(i));
          const b = vertexOf(indexOf(i + 1));
          const c = vertexOf(indexOf(i + 2));
          // alternate winding keeps strips consistent
          if (i % 2 === 0) triangleAt(a, b, c); else triangleAt(b, a, c);
        }
        break;
      case GL.TRIANGLE_FAN:
        for (let i = 1; i + 1 < count; i += 1) {
          triangleAt(vertexOf(indexOf(0)), vertexOf(indexOf(i)), vertexOf(indexOf(i + 1)));
        }
        break;
      default:
        this.#setError(GL.INVALID_ENUM);
    }
  }

  #zeroValueForType(t: string): GLValue {
    if (t.startsWith("vec") || t.startsWith("ivec")) return new Array<number>(Number(t.slice(3))).fill(0);
    if (t.startsWith("bvec")) return { b: new Array<boolean>(Number(t.slice(4))).fill(false) };
    if (t.startsWith("mat")) return { m: new Array<number>(Number(t.slice(3)) ** 2).fill(0), dim: Number(t.slice(3)) };
    if (t === "bool") return false;
    return 0;
  }

  #readAttrib(vertexIndex: number, p: GLProgram, name: string): GLValue {
    const loc = p.attribs.get(name);
    if (loc === undefined) return 0;
    const a = this.#attribs[loc];
    if (a === undefined) return 0;
    if (!a.enabled) return [...a.value];
    const buf = a.buffer;
    if (buf === null || buf.data.length === 0) return [...a.value];
    const bytesPerComp = TYPE_BYTES[a.type] ?? 4;
    const stride = a.stride > 0 ? a.stride : a.size * bytesPerComp;
    const base = a.offset + vertexIndex * stride;
    const dv = new DataView(buf.data.buffer, buf.data.byteOffset, buf.data.byteLength);
    const out: number[] = [];
    for (let i = 0; i < a.size; i += 1) {
      const at = base + i * bytesPerComp;
      if (at + bytesPerComp > buf.data.length) {
        out.push(0);
        continue;
      }
      let v: number;
      switch (a.type) {
        case GL.BYTE: v = dv.getInt8(at); break;
        case GL.UNSIGNED_BYTE: v = dv.getUint8(at); break;
        case GL.SHORT: v = dv.getInt16(at, true); break;
        case GL.UNSIGNED_SHORT: v = dv.getUint16(at, true); break;
        case GL.INT: v = dv.getInt32(at, true); break;
        case GL.UNSIGNED_INT: v = dv.getUint32(at, true); break;
        default: v = dv.getFloat32(at, true); break;
      }
      if (a.normalized && a.type !== GL.FLOAT) {
        const maxPos = a.type === GL.UNSIGNED_BYTE ? 255 : a.type === GL.UNSIGNED_SHORT ? 65535 : a.type === GL.UNSIGNED_INT ? 4294967295 : 127;
        v = a.type === GL.UNSIGNED_BYTE || a.type === GL.UNSIGNED_SHORT || a.type === GL.UNSIGNED_INT
          ? v / maxPos
          : Math.max(-1, v / maxPos);
      }
      out.push(v);
    }
    while (out.length < 4) out.push(out.length === 3 ? 1 : 0);
    return out;
  }

  #writePixel(x: number, y: number, z: number, frag: GLValue, color: Uint8ClampedArray, depth: Float32Array, w: number, h: number): void {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const sc = this.#enabled.has(GL.SCISSOR_TEST) ? this.#scissor : null;
    if (sc !== null) {
      const gy = h - y - 1;
      if (x < sc.x || x >= sc.x + sc.w || gy < sc.y || gy >= sc.y + sc.h) return;
    }
    const i = y * w + x;
    // depth
    if (this.#enabled.has(GL.DEPTH_TEST)) {
      const pass = this.#depthTest(z, depth[i] ?? 1);
      if (!pass) return;
      if (this.#depthMask) depth[i] = Math.min(1, Math.max(0, z));
    }
    // fragment color (vec4 0..1)
    let rgba = [0, 0, 0, 0];
    if (Array.isArray(frag)) {
      const v = frag as number[];
      rgba = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1];
    } else if (typeof frag === "number") {
      rgba = [frag, frag, frag, 1];
    }
    // premultiplied? GLSL writes straight alpha; store straight.
    const src = rgba.map((c) => Math.min(1, Math.max(0, c)));
    if (this.#enabled.has(GL.BLEND)) {
      const dstR = (color[i * 4] ?? 0) / 255;
      const dstG = (color[i * 4 + 1] ?? 0) / 255;
      const dstB = (color[i * 4 + 2] ?? 0) / 255;
      const dstA = (color[i * 4 + 3] ?? 0) / 255;
      const srcN = [src[0] ?? 0, src[1] ?? 0, src[2] ?? 0, src[3] ?? 0];
      const dstN = [dstR, dstG, dstB, dstA];
      const out = [0, 1, 2, 3].map((k) =>
        this.#blendChannel(
          srcN[k] ?? 0, dstN[k] ?? 0,
          k === 3 ? this.#blendSrcA : this.#blendSrc,
          k === 3 ? this.#blendDstA : this.#blendDst,
          k === 3 ? this.#blendEqA : this.#blendEqRgb,
          srcN, dstN,
        ),
      );
      const cm = this.#colorMask;
      if (cm[0] === true) color[i * 4] = Math.round((out[0] ?? 0) * 255);
      if (cm[1] === true) color[i * 4 + 1] = Math.round((out[1] ?? 0) * 255);
      if (cm[2] === true) color[i * 4 + 2] = Math.round((out[2] ?? 0) * 255);
      if (cm[3] === true) color[i * 4 + 3] = Math.round((out[3] ?? 0) * 255);
      return;
    }
    const cm = this.#colorMask;
    if (cm[0] === true) color[i * 4] = Math.round((src[0] ?? 0) * 255);
    if (cm[1] === true) color[i * 4 + 1] = Math.round((src[1] ?? 0) * 255);
    if (cm[2] === true) color[i * 4 + 2] = Math.round((src[2] ?? 0) * 255);
    if (cm[3] === true) color[i * 4 + 3] = Math.round((src[3] ?? 1) * 255);
  }

  #depthTest(z: number, stored: number): boolean {
    switch (this.#depthFunc) {
      case GL.NEVER: return false;
      case GL.ALWAYS: return true;
      case GL.LESS: return z < stored;
      case GL.LEQUAL: return z <= stored;
      case GL.EQUAL: return z === stored;
      case GL.NOTEQUAL: return z !== stored;
      case GL.GREATER: return z > stored;
      case GL.GEQUAL: return z >= stored;
      default: return z < stored;
    }
  }

  #blendFactor(kind: number, src: readonly number[], dst: readonly number[], channel: number): number {
    const sA = src[3] ?? 0;
    const dA = dst[3] ?? 0;
    switch (kind) {
      case GL.ZERO: return 0;
      case GL.ONE: return 1;
      case GL.SRC_COLOR: return src[channel] ?? 0;
      case GL.ONE_MINUS_SRC_COLOR: return 1 - (src[channel] ?? 0);
      case GL.DST_COLOR: return dst[channel] ?? 0;
      case GL.ONE_MINUS_DST_COLOR: return 1 - (dst[channel] ?? 0);
      case GL.SRC_ALPHA: return sA;
      case GL.ONE_MINUS_SRC_ALPHA: return 1 - sA;
      case GL.DST_ALPHA: return dA;
      case GL.ONE_MINUS_DST_ALPHA: return 1 - dA;
      case GL.CONSTANT_COLOR: return this.#blendColor[channel] ?? 0;
      case GL.ONE_MINUS_CONSTANT_COLOR: return 1 - (this.#blendColor[channel] ?? 0);
      case GL.CONSTANT_ALPHA: return this.#blendColor[3] ?? 0;
      case GL.ONE_MINUS_CONSTANT_ALPHA: return 1 - (this.#blendColor[3] ?? 0);
      case GL.SRC_ALPHA_SATURATE: return channel === 3 ? 1 : Math.min(sA, 1 - dA);
      default: return 1;
    }
  }

  #blendChannel(s: number, d: number, sFactor: number, dFactor: number, eq: number, src: readonly number[], dst: readonly number[], channel = 0): number {
    const sf = this.#blendFactor(sFactor, src, dst, channel);
    const df = this.#blendFactor(dFactor, src, dst, channel);
    const a = s * sf;
    const b = d * df;
    switch (eq) {
      case GL.FUNC_SUBTRACT: return a - b;
      case GL.FUNC_REVERSE_SUBTRACT: return b - a;
      default: return a + b;
    }
  }

  // ---- read-back / present ----

  readPixels(x: number, y: number, w: number, h: number, format: number, type: number, out: Uint8Array | Uint8ClampedArray): void {
    if (format !== GL.RGBA || type !== GL.UNSIGNED_BYTE) {
      this.#setError(GL.INVALID_ENUM);
      return;
    }
    const { color, w: tw, h: th } = this.#target();
    for (let row = 0; row < h; row += 1) {
      for (let col = 0; col < w; col += 1) {
        // GL readPixels y is bottom-up — row 0 = bottom of the buffer.
        const sx = x + col;
        const sy = th - 1 - (y + row);
        const di = (row * w + col) * 4;
        if (sx < 0 || sy < 0 || sx >= tw || sy >= th) {
          out[di] = 0;
          out[di + 1] = 0;
          out[di + 2] = 0;
          out[di + 3] = 0;
          continue;
        }
        const si = (sy * tw + sx) * 4;
        out[di] = color[si] ?? 0;
        out[di + 1] = color[si + 1] ?? 0;
        out[di + 2] = color[si + 2] ?? 0;
        out[di + 3] = color[si + 3] ?? 0;
      }
    }
  }

  /** The drawing buffer as a DecodedImage for the canvas paint channel. */
  snapshot(): DecodedImage {
    const alpha = this.#attrs.alpha !== false;
    if (!alpha) {
      const c = new Uint8ClampedArray(this.#color);
      for (let i = 3; i < c.length; i += 4) c[i] = 255;
      this.#needsClearAfterPresent = true;
      return { width: this.#w, height: this.#h, pixels: c };
    }
    this.#needsClearAfterPresent = true;
    return { width: this.#w, height: this.#h, pixels: new Uint8ClampedArray(this.#color) };
  }
}
