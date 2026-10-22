# RFC 0036 — WebGL 1: a software GL device (GLSL front-end → interpreter → rasterizer)

Status: implemented. `canvas.getContext("webgl")` returns a real
`WebGLRenderingContext` backed by a **software GL** — the SwiftShader/WARP
approach browsers actually ship when no GPU is available. GLSL ES 1.00 is
lexed, parsed to a typed AST, and interpreted per vertex and per fragment;
triangles rasterize with perspective-correct barycentric varyings through a
fixed-function depth/blend/scissor/color-mask stage; the framebuffer IS the
canvas bitmap and rides the same `imageOf` channel as Canvas 2D into paint.

## Decision

**One invariant: the guest shader program never escapes into native code —
it is an AST interpreted inside `WebGLCore`, which writes only into the
RGBA8888 drawing buffer that doubles as the canvas bitmap.**

### The pipeline (`packages/gpu/src/gl/`)

```
shader source ──► tokenize/parse (glsl.ts) ──► GLSLProgram AST
                     │ compileShader / linkProgram
                     ▼
attribute buffers ──► GlslRunner (interp.ts) per vertex ──► gl_Position + varyings
                     │ clip→NDC→viewport (y-flip), cull
                     ▼
rasterizer (context.ts): edge-function tri coverage · Bresenham lines · points
                     │ perspective-correct varying lerp (λ·(1/w))
                     ▼
GlslRunner per fragment ──► gl_FragColor ──► depth test → blend → colorMask
                     ▼
               RGBA8888 buffer ──► snapshot() = DecodedImage ──► imageOf → paint
```

**`glsl.ts`** — a real GLSL ES 1.00 front-end: full lexer (comments,
`0.`/`.5`/exponent literals, `#` preprocessor lines stripped, no macro
expansion), recursive-descent parser producing a typed AST (`GLSLProgram`
— globals, functions, statements, expressions). Compile diagnostics are
`infoLog`-shaped with line numbers (`"GLSL <line>: <message>"`). Covers
`attribute`/`uniform`/`varying`/`const`/`precision`, scalar/vector/matrix/
sampler types, arrays, swizzles, constructors, `if/else/for/while/return/
break/continue/discard`, ternary, and the full operator precedence table.
`main()` is required — a program without it fails to link like a real driver.

**`interp.ts`** — `GlslRunner` executes the AST against a `ShaderEnv`
(read/write/sample callbacks that bind attributes, uniforms, varyings and
built-ins). Cell-based lvalues make swizzle writes (`v.xy = …`), indexed
array writes, and `inout` parameters real. Built-ins implemented: `vec2–4`/
`mat2–4` constructors, `dot`, `cross`, `normalize`, `mix`, `clamp`, `step`,
`smoothstep`, `min`, `max`, `abs`, `floor`, `ceil`, `fract`, `sqrt`, `pow`,
`exp`, `log`, `sin`, `cos`, `tan`, `asin`/`acos`/`atan`, `length`,
`distance`, `reflect`, `refract`, `mod`, `sign`, `texture2D` (delegates to
`env.sample`). `discard` throws `DiscardSignal`.

**`context.ts`** — `WebGLCore`: the GL state machine + rasterizer.

- Object lifecycle: `createShader/shaderSource/compileShader` (infoLog per
  spec), `createProgram/attachShader/linkProgram` — link enforces the
  varying contract (name AND type must match across stages) and assigns
  attribute/uniform locations in declaration order.
- Buffers are real byte stores; `vertexAttribPointer` reads through the
  bound `ARRAY_BUFFER` at draw time (size/type/normalize/stride/offset,
  `BYTE…FLOAT` with GL normalization rules); disabled attribs read the
  `vertexAttrib*f` constant.
- Vertex shading caches per-vertex results per draw call (shared triangle
  corners shade once — real GL behavior).
- Rasterization: `TRIANGLES`/`_STRIP`/`_FAN` via edge functions, `LINES`/
  `_STRIP`/`_LOOP` via interpolated segments, `POINTS`. Culling honors
  `CULL_FACE`/`FRONT_AND_BACK`/`frontFace(CW|CCW)` in screen space.
- Perspective-correct interpolation: varying = Σλᵢ·vᵢ·(1/wᵢ) / Σλᵢ·(1/wᵢ).
- Depth: full `LESS…ALWAYS` function set + `depthMask` + `DEPTH_TEST` cap.
- Blend: `blendFuncSeparate`/`blendEquation` — all 15 factors incl.
  `CONSTANT_*` and `SRC_ALPHA_SATURATE`, add/subtract/reverse-subtract.
- Scissor + `colorMask` + `viewport` (bottom-up → framebuffer's top-down
  flip happens at the viewport transform, and `readPixels` flips rows back
  to GL's bottom-up convention).
- Textures: `texImage2D` both forms (raw bytes incl. `RGB`/`LUMINANCE`/
  `UNSIGNED_SHORT_5_6_5` unpacking; DOM-source form resolved by the host
  hook), `NEAREST`/`LINEAR` filtering, `REPEAT`/`CLAMP_TO_EDGE`/
  `MIRRORED_REPEAT` wraps, `UNPACK_FLIP_Y_WEBGL`/`PREMULTIPLY_ALPHA` honored
  on upload.
- FBO-lite: `createFramebuffer`/`framebufferTexture2D(COLOR_ATTACHMENT0)`
  retargets rendering to a texture's RGBA surface; `checkFramebufferStatus`
  is real.
- `readPixels` — RGBA/UNSIGNED_BYTE, bottom-up rows.
- Errors queue through `getError` per spec (`INVALID_ENUM`/`INVALID_VALUE`/
  `INVALID_OPERATION`…); shader faults inside a draw flag
  `INVALID_OPERATION` instead of throwing into guest code.
- `preserveDrawingBuffer` semantics: `snapshot()` marks the buffer
  presented; the next draw clears unless the attribute was set.

### Guest surface (`packages/cli/src/webgl.ts` + script.ts)

`getContext("webgl"|"experimental-webgl")` returns the same ctx object on
repeat calls; **first-call mode lock**: a canvas that got `"2d"` returns
`null` for `"webgl"` and vice versa (spec). `WebGLRenderingContext` is a
non-constructible interface object; ctx objects carry its prototype so
`instanceof` works. The full WebGL1 enum set installs as own properties.
`canvasBitmaps()` merges `webglBitmap(core)` snapshots — paint never learns
which engine produced the bitmap. `width`/`height` writes resize the drawing
buffer. `OffscreenCanvas` supports `"webgl"` too. `texImage2D(domSource)`
resolves `img`/`canvas`/`OffscreenCanvas` through the same registries
`drawImage` uses.

## Honest boundaries

1. **Software only.** No discrete-GPU path is claimed — `RENDERER` reports
   `"software-gl (SwiftShader-style)"`. WebGPU hardware acceleration is a
   separate opportunistic device in this package, not this API.
2. **WebGL 1 only.** No `WebGL2RenderingContext`; `getContext("webgl2")`
   returns `null`.
3. **Zero extensions** — `getSupportedExtensions()` returns `[]`;
   `getExtension()` returns `null`. No `OES_*`, `WEBGL_*`, `ANGLE_*`.
4. **No mipmaps.** `generateMipmap` is a no-op; minification filters sample
   level 0 only.
5. **No stencil buffer.** Stencil state is stored but inert;
   `stencilFunc`/`stencilOp` are silent no-ops.
6. **No renderbuffer attachments.** `createRenderbuffer` returns an object,
   but `framebufferRenderbuffer`/`renderbufferStorage` are inert; FBOs take
   `RGBA/UNSIGNED_BYTE` texture color attachments only (no depth attachment).
7. **`texSubImage2D`, `copyTex*`, `compressedTex*`** are boundaries — the
   calls exist but do not modify texture data.
8. **Derivative builtins** (`dFdx`/`dFdy`/`fwidth`) — shading is
   single-quad; if reached they evaluate through `env.read` which does not
   provide them (they error → `INVALID_OPERATION` on draw).
9. **1px lines, point size fixed at 1** (`ALIASED_*_RANGE` reports [1,1]).
10. **No antialiasing** regardless of `contextAttributes.antialias`.
11. `uniform[234]i[v]` collapse to the first component (ivec uniforms are a
    rare path); `getActiveAttrib/Uniform` report `FLOAT_VEC4` types only.
12. GLSL subset honesty: no `#define` expansion, no structs/`samplerCube`,
    no global initializers beyond constants; out-of-range array indexing
    follows the GLSL "safe" semantics by clamping.
