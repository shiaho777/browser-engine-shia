/**
 * webgl.ts — RFC 0036: the guest `WebGLRenderingContext` IDL surface over
 * {@link WebGLCore} (the software-GL device in `@browser-engine/gpu`).
 *
 * The wrapper is thin by design: every method delegates to the core context;
 * GL object handles (WebGLBuffer/Shader/Program/Texture/Framebuffer/
 * UniformLocation) are the core's own objects passed through opaquely — the
 * guest can store and hand them back, but they carry no guest-visible state
 * beyond identity (close enough to the opaque-handle spec shape).
 *
 * The full WebGL1 constant set is installed as enumerable own properties so
 * `gl.TRIANGLES` etc. read exactly like the platform.
 */
import { GL, WebGLCore } from "@browser-engine/gpu";
import type { DecodedImage } from "@browser-engine/ir";

export interface WebGLContextOptions {
  /** Resolve a canvas/img element's decoded bitmap for `texImage2D(source)`. */
  readonly imageSource?: (el: unknown) => DecodedImage | undefined;
}

/** The shared prototype behind `WebGLRenderingContext.prototype` — ctx
 * objects carry it so `gl instanceof WebGLRenderingContext` is true. */
export const WebGLRenderingContextProto: object = {};

/** `canvas.getContext("webgl")` — real software-GL rendering. */
export function makeWebGLContext(
  core: WebGLCore,
  canvasEl: object,
  options: WebGLContextOptions = {},
): object {
  const n = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
  const bool = (v: unknown): boolean => v === true || v === 1;

  const gl: Record<string, unknown> = {
    canvas: canvasEl,
    get drawingBufferWidth(): number {
      return core.canvasWidth;
    },
    get drawingBufferHeight(): number {
      return core.canvasHeight;
    },
    getContextAttributes: () => core.getParameter(GL.VERSION) !== null
      ? { alpha: true, depth: true, stencil: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false }
      : null,

    // ---- object lifecycle ----
    createBuffer: () => core.createBuffer(),
    deleteBuffer: (b: never) => core.deleteBuffer(b),
    isBuffer: (b: unknown) => typeof b === "object" && b !== null,
    createShader: (t: unknown) => core.createShader(n(t)),
    shaderSource: (s: never, src: unknown) => core.shaderSource(s, String(src)),
    compileShader: (s: never) => core.compileShader(s),
    getShaderParameter: (s: never, p: unknown) => core.getShaderParameter(s, n(p)),
    getShaderInfoLog: (s: never) => core.getShaderInfoLog(s),
    getShaderSource: (s: { source?: string }) => s?.source ?? "",
    deleteShader: (s: never) => core.deleteShader(s),
    isShader: (s: unknown) => typeof s === "object" && s !== null,
    createProgram: () => core.createProgram(),
    attachShader: (p: never, s: never) => core.attachShader(p, s),
    detachShader: (p: never, s: never) => core.detachShader(p, s),
    linkProgram: (p: never) => core.linkProgram(p),
    getProgramParameter: (p: never, n2: unknown) => core.getProgramParameter(p, n(n2)),
    getProgramInfoLog: (p: never) => core.getProgramInfoLog(p),
    useProgram: (p: never) => core.useProgram(p ?? null),
    validateProgram: (p: never) => core.validateProgram(p),
    isProgram: (p: unknown) => typeof p === "object" && p !== null,
    deleteProgram: (p: { id?: number }) => void p,
    createTexture: () => core.createTexture(),
    deleteTexture: (t: never) => core.deleteTexture(t),
    isTexture: (t: unknown) => typeof t === "object" && t !== null,
    createFramebuffer: () => core.createFramebuffer(),
    deleteFramebuffer: (f: never) => core.deleteFramebuffer(f),
    isFramebuffer: (f: unknown) => typeof f === "object" && f !== null,
    createRenderbuffer: () => ({}), // honest: RB objects exist but bind/use is inert.
    deleteRenderbuffer: () => undefined,
    isRenderbuffer: (r: unknown) => typeof r === "object" && r !== null,

    // ---- bindings ----
    bindBuffer: (t: unknown, b: never) => core.bindBuffer(n(t), b ?? null),
    bindTexture: (t: unknown, x: never) => core.bindTexture(n(t), x ?? null),
    bindFramebuffer: (t: unknown, f: never) => core.bindFramebuffer(n(t), f ?? null),
    bindRenderbuffer: () => undefined,
    activeTexture: (u: unknown) => core.activeTexture(n(u)),
    framebufferTexture2D: (t: unknown, a: unknown, tt: unknown, tex: never, lvl: unknown) =>
      core.framebufferTexture2D(n(t), n(a), n(tt), tex ?? null, n(lvl)),
    checkFramebufferStatus: (t: unknown) => core.checkFramebufferStatus(n(t)),
    framebufferRenderbuffer: () => undefined,
    renderbufferStorage: () => undefined,

    // ---- buffers ----
    bufferData: (t: unknown, d: unknown, u: unknown) => {
      if (typeof d === "number") core.bufferData(n(t), d, n(u));
      else if (ArrayBuffer.isView(d) || d instanceof ArrayBuffer) core.bufferData(n(t), d, n(u));
      else core.bufferData(n(t), 0, n(u));
    },
    bufferSubData: (t: unknown, off: unknown, d: unknown) => {
      if (ArrayBuffer.isView(d) || d instanceof ArrayBuffer) core.bufferSubData(n(t), n(off), d);
    },
    getBufferParameter: (_t: unknown, _p: unknown) => null,

    // ---- vertex attribs ----
    vertexAttribPointer: (i: unknown, size: unknown, type: unknown, norm: unknown, stride: unknown, off: unknown) =>
      core.vertexAttribPointer(n(i), n(size), n(type), bool(norm), n(stride), n(off)),
    enableVertexAttribArray: (i: unknown) => core.enableVertexAttribArray(n(i)),
    disableVertexAttribArray: (i: unknown) => core.disableVertexAttribArray(n(i)),
    getVertexAttrib: () => null,
    getVertexAttribOffset: () => 0,
    vertexAttrib1f: (i: unknown, x: unknown) => core.vertexAttrib1f(n(i), n(x)),
    vertexAttrib2f: (i: unknown, x: unknown, y: unknown) => core.vertexAttrib2f(n(i), n(x), n(y)),
    vertexAttrib3f: (i: unknown, x: unknown, y: unknown, z: unknown) => core.vertexAttrib3f(n(i), n(x), n(y), n(z)),
    vertexAttrib4f: (i: unknown, x: unknown, y: unknown, z: unknown, w: unknown) =>
      core.vertexAttrib4f(n(i), n(x), n(y), n(z), n(w)),
    vertexAttrib1fv: (i: unknown, v: ArrayLike<number>) => core.vertexAttribfv(n(i), v),
    vertexAttrib2fv: (i: unknown, v: ArrayLike<number>) => core.vertexAttribfv(n(i), v),
    vertexAttrib3fv: (i: unknown, v: ArrayLike<number>) => core.vertexAttribfv(n(i), v),
    vertexAttrib4fv: (i: unknown, v: ArrayLike<number>) => core.vertexAttribfv(n(i), v),

    // ---- program introspection ----
    getAttribLocation: (p: never, name: unknown) => core.getAttribLocation(p, String(name)),
    getUniformLocation: (p: never, name: unknown) => core.getUniformLocation(p, String(name)),
    bindAttribLocation: (p: never, i: unknown, name: unknown) => core.bindAttribLocation(p, n(i), String(name)),
    getActiveAttrib: (p: { attribs?: Map<string, number> }, i: number) => {
      const entry = [...(p.attribs?.entries() ?? [])].find(([, loc]) => loc === i);
      return entry === undefined ? null : { name: entry[0], size: 1, type: 0x8b52 /* FLOAT_VEC4 */ };
    },
    getActiveUniform: (p: { uniforms?: Map<string, number> }, i: number) => {
      const entry = [...(p.uniforms?.entries() ?? [])].find(([, loc]) => loc === i);
      return entry === undefined ? null : { name: entry[0], size: 1, type: 0x8b52 /* FLOAT_VEC4 */ };
    },
    getAttachedShaders: () => [],

    // ---- uniforms ----
    uniform1f: (l: object | null, x: unknown) => core.uniform1f(l, n(x)),
    uniform2f: (l: object | null, x: unknown, y: unknown) => core.uniform2f(l, n(x), n(y)),
    uniform3f: (l: object | null, x: unknown, y: unknown, z: unknown) => core.uniform3f(l, n(x), n(y), n(z)),
    uniform4f: (l: object | null, x: unknown, y: unknown, z: unknown, w: unknown) => core.uniform4f(l, n(x), n(y), n(z), n(w)),
    uniform1i: (l: object | null, x: unknown) => core.uniform1i(l, n(x)),
    uniform2i: (l: object | null, x: unknown, _y: unknown) => core.uniform1i(l, n(x)), // 2i+ collapses to slot
    uniform3i: (l: object | null, x: unknown, _y: unknown, _z: unknown) => core.uniform1i(l, n(x)),
    uniform4i: (_l: object | null) => undefined,
    uniform1fv: (l: object | null, v: ArrayLike<number>) => core.uniform1fv(l, v),
    uniform2fv: (l: object | null, v: ArrayLike<number>) => core.uniform2fv(l, v),
    uniform3fv: (l: object | null, v: ArrayLike<number>) => core.uniform3fv(l, v),
    uniform4fv: (l: object | null, v: ArrayLike<number>) => core.uniform4fv(l, v),
    uniform1iv: (l: object | null, v: ArrayLike<number>) => core.uniform1i(l, n(v[0])),
    uniform2iv: (l: object | null, v: ArrayLike<number>) => core.uniform1i(l, n(v[0])),
    uniform3iv: (l: object | null, v: ArrayLike<number>) => core.uniform1i(l, n(v[0])),
    uniform4iv: (l: object | null, v: ArrayLike<number>) => core.uniform1i(l, n(v[0])),
    uniformMatrix2fv: (l: object | null, t: unknown, v: ArrayLike<number>) => core.uniformMatrix2fv(l, bool(t), v),
    uniformMatrix3fv: (l: object | null, t: unknown, v: ArrayLike<number>) => core.uniformMatrix3fv(l, bool(t), v),
    uniformMatrix4fv: (l: object | null, t: unknown, v: ArrayLike<number>) => core.uniformMatrix4fv(l, bool(t), v),

    // ---- textures ----
    texImage2D: (t: unknown, lvl: unknown, internal: unknown, a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, f?: unknown) => {
      if (f !== undefined) {
        core.texImage2D(n(t), n(lvl), n(internal), n(a), n(b), n(c), n(d), e, f);
        return;
      }
      // source form: (target, level, internalformat, format, type, source) —
      // core reads a6 as the source; resolve DOM sources via imageSource.
      const decoded = options.imageSource?.(e);
      const src = decoded ?? (e as { width?: number; height?: number; pixels?: Uint8ClampedArray; data?: Uint8ClampedArray } | null);
      core.texImage2D(n(t), n(lvl), n(internal), n(a), n(b), src, 0, 0);
    },
    texSubImage2D: () => undefined, // boundary: no sub-region uploads.
    copyTexImage2D: () => undefined,
    copyTexSubImage2D: () => undefined,
    texParameteri: (t: unknown, p: unknown, v: unknown) => core.texParameteri(n(t), n(p), n(v)),
    texParameterf: (t: unknown, p: unknown, v: unknown) => core.texParameterf(n(t), n(p), n(v)),
    getTexParameter: () => null,
    generateMipmap: (t: unknown) => core.generateMipmap(n(t)),
    pixelStorei: (p: unknown, v: unknown) => core.pixelStorei(n(p), n(v)),
    compressedTexImage2D: () => { core.getError(); }, // no compressed formats.
    compressedTexSubImage2D: () => undefined,

    // ---- state ----
    enable: (c: unknown) => core.enable(n(c)),
    disable: (c: unknown) => core.disable(n(c)),
    isEnabled: (c: unknown) => core.isEnabled(n(c)),
    viewport: (x: unknown, y: unknown, w: unknown, h: unknown) => core.viewport(n(x), n(y), n(w), n(h)),
    scissor: (x: unknown, y: unknown, w: unknown, h: unknown) => core.scissor(n(x), n(y), n(w), n(h)),
    clearColor: (r: unknown, g: unknown, b: unknown, a: unknown) => core.clearColor(n(r), n(g), n(b), n(a)),
    clearDepth: (d: unknown) => core.clearDepth(n(d)),
    clearStencil: (v: unknown) => core.clearStencil(n(v)),
    depthFunc: (f: unknown) => core.depthFunc(n(f)),
    depthMask: (m: unknown) => core.depthMask(bool(m)),
    depthRange: () => undefined,
    colorMask: (r: unknown, g: unknown, b: unknown, a: unknown) => core.colorMask(bool(r), bool(g), bool(b), bool(a)),
    blendFunc: (s2: unknown, d: unknown) => core.blendFunc(n(s2), n(d)),
    blendFuncSeparate: (sr: unknown, dr: unknown, sa: unknown, da: unknown) =>
      core.blendFuncSeparate(n(sr), n(dr), n(sa), n(da)),
    blendEquation: (e: unknown) => core.blendEquation(n(e)),
    blendEquationSeparate: (rgb: unknown, a: unknown) => { core.blendEquation(n(rgb)); void a; },
    blendColor: (r: unknown, g: unknown, b: unknown, a: unknown) => core.blendColor(n(r), n(g), n(b), n(a)),
    frontFace: (f: unknown) => core.frontFace(n(f)),
    cullFace: (f: unknown) => core.cullFace(n(f)),
    lineWidth: (w: unknown) => core.lineWidth(n(w)),
    polygonOffset: (f: unknown, u: unknown) => core.polygonOffset(n(f), n(u)),
    hint: (t: unknown, h: unknown) => core.hint(n(t), n(h)),
    stencilFunc: () => undefined, // stencil inert — documented boundary.
    stencilFuncSeparate: () => undefined,
    stencilMask: () => undefined,
    stencilMaskSeparate: () => undefined,
    stencilOp: () => undefined,
    stencilOpSeparate: () => undefined,

    // ---- clear/draw/read ----
    clear: (m: unknown) => core.clear(n(m)),
    drawArrays: (m: unknown, f: unknown, c: unknown) => core.drawArrays(n(m), n(f), n(c)),
    drawElements: (m: unknown, c: unknown, t: unknown, o: unknown) => core.drawElements(n(m), n(c), n(t), n(o)),
    readPixels: (x: unknown, y: unknown, w: unknown, h: unknown, fmt: unknown, t: unknown, out: ArrayBufferView) => {
      core.readPixels(n(x), n(y), n(w), n(h), n(fmt), n(t), out as Uint8Array);
    },

    // ---- queries/misc ----
    getError: () => core.getError(),
    getParameter: (p: unknown) => core.getParameter(n(p)),
    getSupportedExtensions: () => core.getSupportedExtensions(),
    getExtension: (name: unknown) => core.getExtension(String(name)),
    isContextLost: () => core.isContextLost(),
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }), // fp64 backing.
    finish: () => undefined,
    flush: () => undefined,
  };

  // The full WebGL1 enum surface as own properties.
  for (const [k, v] of Object.entries(GL)) {
    gl[k] = v;
  }
  // Extra constants the guest reads that live outside GL.
  Object.assign(gl, {
    FLOAT_VEC2: 0x8b50, FLOAT_VEC3: 0x8b51, FLOAT_VEC4: 0x8b52,
    INT_VEC2: 0x8b53, INT_VEC3: 0x8b54, INT_VEC4: 0x8b55,
    BOOL: 0x8b56, BOOL_VEC2: 0x8b57, BOOL_VEC3: 0x8b58, BOOL_VEC4: 0x8b59,
    FLOAT_MAT2: 0x8b5a, FLOAT_MAT3: 0x8b5b, FLOAT_MAT4: 0x8b5c,
    SAMPLER_2D: 0x8b5e, SAMPLER_CUBE: 0x8b60,
    LOW_FLOAT: 0x8df0, MEDIUM_FLOAT: 0x8df1, HIGH_FLOAT: 0x8df2,
    LOW_INT: 0x8df3, MEDIUM_INT: 0x8df4, HIGH_INT: 0x8df5,
    BUFFER_SIZE: 0x8764, BUFFER_USAGE: 0x8765,
    CURRENT_PROGRAM: 0x8b8d, TEXTURE_BINDING_2D: 0x8069,
    ACTIVE_TEXTURE: 0x84e0, CURRENT_VERTEX_ATTRIB: 0x8626,
    VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622, VERTEX_ATTRIB_ARRAY_SIZE: 0x8623,
    VERTEX_ATTRIB_ARRAY_STRIDE: 0x8624, VERTEX_ATTRIB_ARRAY_TYPE: 0x8625,
    VERTEX_ATTRIB_ARRAY_NORMALIZED: 0x886a, VERTEX_ATTRIB_ARRAY_POINTER: 0x8645,
    VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889f,
    DEPTH_RANGE: 0x0b70, DEPTH_WRITEMASK: 0x0b72, DEPTH_FUNC: 0x0b74,
    STENCIL_FUNC: 0x0b92, STENCIL_VALUE_MASK: 0x0b93, STENCIL_FAIL: 0x0b94,
    STENCIL_PASS_DEPTH_FAIL: 0x0b95, STENCIL_PASS_DEPTH_PASS: 0x0b96,
    STENCIL_REF: 0x0b97, STENCIL_WRITEMASK: 0x0b98,
    STENCIL_BACK_FUNC: 0x8800, STENCIL_BACK_FAIL: 0x8801,
    STENCIL_BACK_PASS_DEPTH_FAIL: 0x8802, STENCIL_BACK_PASS_DEPTH_PASS: 0x8803,
    STENCIL_BACK_REF: 0x8ca3, STENCIL_BACK_VALUE_MASK: 0x8ca4,
    STENCIL_BACK_WRITEMASK: 0x8ca5,
    COLOR_WRITEMASK: 0x0c23, BLEND_COLOR: 0x8005, BLEND_EQUATION: 0x8009,
    BLEND_EQUATION_RGB: 0x8009, BLEND_EQUATION_ALPHA: 0x883d,
    BLEND_SRC_RGB: 0x80c9, BLEND_DST_RGB: 0x80c8,
    BLEND_SRC_ALPHA: 0x80ca, BLEND_DST_ALPHA: 0x80cb,
    BLEND_SRC: 0x0be1, BLEND_DST: 0x0be0,
    SAMPLE_COVERAGE: 0x80a0, SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
    GENERATE_MIPMAP_HINT: 0x8192, SUBPIXEL_BITS: 0x0d50,
    MAX_RENDERBUFFER_SIZE: 0x84e8, RED_BITS: 0x0d52, GREEN_BITS: 0x0d53,
    BLUE_BITS: 0x0d54, ALPHA_BITS: 0x0d55, DEPTH_BITS: 0x0d56, STENCIL_BITS: 0x0d57,
    RGB565: 0x8d62, RGBA4: 0x8056, RGB5_A1: 0x8057, DEPTH_COMPONENT16: 0x81a5,
    STENCIL_INDEX8: 0x8d48,
    FRAMEBUFFER_BINDING: 0x8ca6, RENDERBUFFER_BINDING: 0x8ca7,
    RENDERBUFFER_WIDTH: 0x8d42, RENDERBUFFER_HEIGHT: 0x8d43,
    RENDERBUFFER_RED_SIZE: 0x8d50, RENDERBUFFER_GREEN_SIZE: 0x8d51,
    RENDERBUFFER_BLUE_SIZE: 0x8d52, RENDERBUFFER_ALPHA_SIZE: 0x8d53,
    RENDERBUFFER_DEPTH_SIZE: 0x8d54, RENDERBUFFER_STENCIL_SIZE: 0x8d55,
    RENDERBUFFER_INTERNAL_FORMAT: 0x8d44,
    INVERT: 0x150a,
    KEEP: 0x1e00, REPLACE: 0x1e01, INCR: 0x1e02, DECR: 0x1e03,
    INCR_WRAP: 0x8507, DECR_WRAP: 0x8508,
    NEAREST_MIPMAP_LINEAR: 0x2702,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, BROWSER_DEFAULT_WEBGL: 0x9244,
  });
  // instanceof + [[Prototype]] — own props shadow, proto carries the brand.
  Object.setPrototypeOf(gl, WebGLRenderingContextProto);
  return gl;
}

/** The canvas-bitmap adapter — framebuffer snapshot for the paint channel. */
export function webglBitmap(core: WebGLCore): DecodedImage {
  return core.snapshot();
}
