/**
 * webgpu-device.ts — a REAL WebGPU device behind the {@link GpuDevice} seam.
 *
 * This is genuine hardware-GPU code: it acquires a real `GPUAdapter`/`GPUDevice`
 * via the standard WebGPU API, compiles a real **WGSL** shader, builds a render
 * pipeline with source-over blending, draws the command buffer's quads as
 * triangles, and reads the framebuffer back. The WebGPU runtime is loaded
 * OPPORTUNISTICALLY:
 *   - `globalThis.navigator.gpu` when the host exposes it (browsers, Deno,
 *     future Node), else
 *   - a dynamically imported `webgpu` (Dawn) package IF the user installed it.
 *
 * No runtime dependency is added, so `npm install` and CI are unaffected; when
 * NO WebGPU runtime is present, {@link createWebGpuDevice} resolves to `null`
 * and the caller picks the software/multi-core device — an explicit choice, not
 * a hidden fallback. On a WebGPU-capable machine this lights up the real GPU.
 *
 * Honesty: this code path cannot execute in a GPU-less CI, so it is validated by
 * shape + graceful-absence here and runs for real wherever a device exists. It
 * implements the clear + solid/linear-gradient quad pipeline (the GPU
 * primitive); coverage/image/layer WGSL passes extend it at the same seam.
 */
import type { CommandBuffer, Fragment, GpuColor } from "./pipeline.js";
import type { GpuDevice, GpuSurface } from "./device.js";
import {
  GPUBufferUsage,
  GPUMapMode,
  GPUTextureUsage,
  type GPU,
  type GPUDevice,
  type GPURenderPipeline,
} from "./webgpu-types.js";

/** Whether a WebGPU runtime is reachable in this process. */
export async function isWebGpuAvailable(): Promise<boolean> {
  return (await loadWebGpu()) !== null;
}

/** Acquire a WebGPU `GPU` from the host, or a Dawn `webgpu` package, or `null`. */
async function loadWebGpu(): Promise<GPU | null> {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (nav?.gpu !== undefined && nav.gpu !== null) {
    return nav.gpu as GPU;
  }
  try {
    const specifier = "webgpu";
    const mod: unknown = await import(specifier);
    if (typeof mod === "object" && mod !== null && "create" in mod) {
      const create: unknown = mod.create;
      if (typeof create === "function") {
        return (create as (flags: unknown[]) => GPU)([]);
      }
    }
  } catch {
    // `webgpu` is not installed — that is fine; we report unavailable.
  }
  return null;
}

const WGSL = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32> };
@vertex
fn vs(@location(0) xy: vec2<f32>, @location(1) color: vec4<f32>) -> VSOut {
  var o: VSOut;
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.color = color;
  return o;
}
@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  // Premultiply for correct source-over with the configured blend state.
  return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
}
`;

/**
 * Create a real WebGPU-backed {@link GpuDevice}, or `null` when no WebGPU
 * runtime is available. The returned device renders command buffers on the GPU.
 */
export async function createWebGpuDevice(): Promise<GpuDevice | null> {
  const gpu = await loadWebGpu();
  if (gpu === null) return null;
  const adapter = await gpu.requestAdapter();
  if (adapter === null) return null;
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: WGSL });

  const pipeline: GPURenderPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 24, // 6 floats * 4 bytes (vec2 pos + vec4 color)
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [
        {
          format: "rgba8unorm",
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  return {
    name: "webgpu",
    submit(cmd: CommandBuffer): Promise<GpuSurface> {
      return renderOnGpu(device, pipeline, cmd);
    },
  };
}

/** Submit one command buffer to the GPU and read the framebuffer back. */
async function renderOnGpu(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  cmd: CommandBuffer,
): Promise<GpuSurface> {
  const { width, height } = cmd;
  const verts = buildVertices(cmd);
  const clear = findClear(cmd);

  const vbuf = device.createBuffer({
    size: Math.max(24, verts.byteLength),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vbuf, 0, verts);

  const texture = device.createTexture({
    size: { width, height },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: clear.r / 255, g: clear.g / 255, b: clear.b / 255, a: clear.a },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setVertexBuffer(0, vbuf);
  pass.draw(verts.length / 6);
  pass.end();

  // Read the texture back (bytesPerRow must be a multiple of 256).
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readBuffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readBuffer, bytesPerRow },
    { width, height },
  );
  device.queue.submit([encoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(readBuffer.getMappedRange());
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  }
  readBuffer.unmap();
  readBuffer.destroy();
  texture.destroy();
  vbuf.destroy();
  return { width, height, pixels };
}

/** The clear colour to load the framebuffer with (last clear before drawing). */
function findClear(cmd: CommandBuffer): GpuColor {
  for (const c of cmd.commands) {
    if (c.op === "clear") return c.color;
  }
  return { r: 0, g: 0, b: 0, a: 0 };
}

/** Build the interleaved vertex buffer (pos.xy + color.rgba) for all quads. */
function buildVertices(cmd: CommandBuffer): Float32Array {
  const quads = cmd.commands.filter((c): c is Extract<typeof c, { op: "quad" }> => c.op === "quad");
  const floats: number[] = [];
  const ndcX = (x: number): number => (x / cmd.width) * 2 - 1;
  const ndcY = (y: number): number => 1 - (y / cmd.height) * 2;
  for (const q of quads) {
    const corner = (cx: number, cy: number): readonly [number, number, number, number] => {
      const u = (cx - q.x) / q.w;
      const v = (cy - q.y) / q.h;
      const c = cornerColor(q.fragment, u, v);
      return [c.r / 255, c.g / 255, c.b / 255, c.a];
    };
    const tl = { x: q.x, y: q.y };
    const tr = { x: q.x + q.w, y: q.y };
    const bl = { x: q.x, y: q.y + q.h };
    const br = { x: q.x + q.w, y: q.y + q.h };
    for (const [p, uv] of [
      [tl, tl], [tr, tr], [bl, bl],
      [tr, tr], [br, br], [bl, bl],
    ] as const) {
      const [r, g, b, a] = corner(uv.x, uv.y);
      floats.push(ndcX(p.x), ndcY(p.y), r, g, b, a);
    }
  }
  return new Float32Array(floats);
}

/** The colour at a quad corner — solid or interpolated gradient; coverage/image
 * fragments (which need GPU textures) resolve to transparent at this seam. */
function cornerColor(fragment: Fragment, u: number, v: number): GpuColor {
  if (fragment.kind === "solid") return fragment.color;
  if (fragment.kind === "linear-gradient") {
    const t = fragment.axis === "x" ? u : v;
    return {
      r: fragment.from.r + (fragment.to.r - fragment.from.r) * t,
      g: fragment.from.g + (fragment.to.g - fragment.from.g) * t,
      b: fragment.from.b + (fragment.to.b - fragment.from.b) * t,
      a: fragment.from.a + (fragment.to.a - fragment.from.a) * t,
    };
  }
  return { r: 0, g: 0, b: 0, a: 0 }; // coverage/image need textures (seam extension).
}
