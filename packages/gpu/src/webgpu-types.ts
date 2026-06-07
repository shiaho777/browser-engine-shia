/**
 * webgpu-types.ts — a MINIMAL, dependency-free facade over the standard WebGPU
 * API, declaring exactly the members the {@link import("./webgpu-device.js")}
 * adapter calls. This lets us write real, type-checked WebGPU code without
 * pulling `@webgpu/types` (or any runtime dep) into a repo that prides itself on
 * zero runtime dependencies. The shapes mirror the W3C WebGPU IDL.
 */

export interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>;
}

export interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>;
}

export interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void;
  submit(buffers: GPUCommandBuffer[]): void;
}

export interface GPUDevice {
  readonly queue: GPUQueue;
  createShaderModule(desc: { code: string }): GPUShaderModule;
  createBuffer(desc: { size: number; usage: number; mappedAtCreation?: boolean }): GPUBuffer;
  createTexture(desc: {
    size: { width: number; height: number };
    format: string;
    usage: number;
  }): GPUTexture;
  createRenderPipeline(desc: unknown): GPURenderPipeline;
  createCommandEncoder(): GPUCommandEncoder;
}

export interface GPUShaderModule {
  readonly __brand?: "shader";
}
export interface GPURenderPipeline {
  readonly __brand?: "pipeline";
}
export interface GPUBuffer {
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  mapAsync(mode: number): Promise<void>;
  destroy(): void;
}
export interface GPUTexture {
  createView(): GPUTextureView;
  destroy(): void;
}
export interface GPUTextureView {
  readonly __brand?: "view";
}
export interface GPUCommandBuffer {
  readonly __brand?: "cmdbuf";
}
export interface GPURenderPassEncoder {
  setPipeline(p: GPURenderPipeline): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer): void;
  draw(vertexCount: number): void;
  end(): void;
}
export interface GPUCommandEncoder {
  beginRenderPass(desc: unknown): GPURenderPassEncoder;
  copyTextureToBuffer(src: unknown, dst: unknown, size: unknown): void;
  finish(): GPUCommandBuffer;
}

/** WebGPU usage-flag constants (from the spec; stable numeric values). */
export const GPUBufferUsage = {
  MAP_READ: 0x0001,
  COPY_DST: 0x0008,
  COPY_SRC: 0x0004,
  VERTEX: 0x0020,
} as const;
export const GPUTextureUsage = {
  COPY_SRC: 0x01,
  RENDER_ATTACHMENT: 0x10,
} as const;
export const GPUMapMode = { READ: 0x0001 } as const;
