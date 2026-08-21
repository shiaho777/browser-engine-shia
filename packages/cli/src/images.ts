import type { DecodedImage, DomNode, DomTree, NodeId } from "@browser-engine/ir";
import { decodePng } from "@browser-engine/test-harness";
import { decode as decodeJpeg } from "jpeg-js";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ImageLoader = (src: string) => Uint8Array | undefined;

export function collectImages(
  dom: DomTree,
  loadExternal?: ImageLoader,
): Map<NodeId, DecodedImage> {
  const images = new Map<NodeId, DecodedImage>();
  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) {
      return;
    }
    if (node.kind === "element" && node.tag === "img") {
      const bytes = imageBytes(node, loadExternal);
      if (bytes !== undefined) {
        const decoded = tryDecode(bytes);
        if (decoded !== undefined) {
          images.set(node.id, decoded);
        }
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(dom.root);
  return images;
}

export type AsyncImageLoader = (src: string) => Promise<Uint8Array | undefined>;

export async function collectImagesAsync(
  dom: DomTree,
  loadExternal?: ImageLoader,
  options: {
    readonly concurrency?: number;
    readonly onlyNodes?: ReadonlySet<NodeId>;
    readonly fetchFn?: AsyncImageLoader;
    readonly maxImages?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<Map<NodeId, DecodedImage>> {
  const only = options.onlyNodes;
  const fetchFn = options.fetchFn;
  const maxImages = options.maxImages;
  const timeoutMs = options.timeoutMs;
  const targets: DomNode[] = [];
  const visit = (id: NodeId): void => {
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element" && node.tag === "img") {
      if (only === undefined || only.has(node.id)) targets.push(node);
    }
    for (const child of node.children) visit(child);
  };
  visit(dom.root);
  const limited =
    maxImages !== undefined && maxImages >= 0 && targets.length > maxImages
      ? targets.slice(0, maxImages)
      : targets;

  const jobs: { id: NodeId; bytes: Uint8Array }[] = [];
  const deadline =
    timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + Math.max(timeoutMs, 200) * 2 : null;
  const resolveOne = async (node: DomNode): Promise<void> => {
    if (deadline !== null && Date.now() >= deadline) return;
    let bytes = imageBytes(node, loadExternal);
    if (bytes === undefined && fetchFn !== undefined) {
      const candidates = imageSourceCandidates(node, false).filter((src) => !src.startsWith("data:"));
      const tryList = candidates.slice(0, 2);
      for (const src of tryList) {
        if (deadline !== null && Date.now() >= deadline) break;
        try {
          const fetched = fetchFn(src);
          bytes =
            timeoutMs !== undefined && timeoutMs > 0
              ? await raceTimeout(fetched, timeoutMs)
              : await fetched;
        } catch {
          bytes = undefined;
        }
        if (bytes !== undefined) break;
      }
    }
    if (bytes !== undefined) jobs.push({ id: node.id, bytes });
  };

  const concurrency = Math.max(1, options.concurrency ?? 16);
  let cursor = 0;
  const fetchWorkers = Array.from(
    { length: Math.min(concurrency, Math.max(1, limited.length)) },
    async () => {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= limited.length) return;
        await resolveOne(limited[i]!);
      }
    },
  );
  const fetchPhase =
    limited.length > 0
      ? Promise.all(fetchWorkers)
      : Promise.resolve();
  if (timeoutMs !== undefined && timeoutMs > 0) {
    await raceTimeout(fetchPhase.then(() => true), Math.max(timeoutMs, 200) * 2);
  } else {
    await fetchPhase;
  }

  const images = new Map<NodeId, DecodedImage>();
  let next = 0;
  const decodeWorkers = Array.from(
    { length: Math.min(concurrency, Math.max(1, jobs.length)) },
    async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= jobs.length) return;
        const job = jobs[i]!;
        const decoded = await tryDecodeAsync(job.bytes);
        if (decoded !== undefined) images.set(job.id, decoded);
      }
    },
  );
  const decodePhase = jobs.length > 0 ? Promise.all(decodeWorkers) : Promise.resolve();
  if (timeoutMs !== undefined && timeoutMs > 0) {
    await raceTimeout(decodePhase.then(() => true), Math.max(400, timeoutMs));
  } else {
    await decodePhase;
  }
  return images;
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export function imageSourceCandidates(img: DomNode, preferSmall = false): string[] {
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    if (v !== undefined && v.length > 0 && !out.includes(v)) out.push(v);
  };
  push(img.attrs?.get("src"));
  push(img.attrs?.get("data-src"));
  push(img.attrs?.get("data-src-img"));
  const srcset = img.attrs?.get("srcset") ?? img.attrs?.get("data-srcset");
  if (srcset !== undefined && srcset.length > 0) {
    const parts: { url: string; score: number }[] = [];
    for (const part of srcset.split(",")) {
      const bits = part.trim().split(/\s+/);
      const url = bits[0];
      if (url === undefined || url.length === 0) continue;
      let score = Number.POSITIVE_INFINITY;
      for (let i = 1; i < bits.length; i += 1) {
        const d = bits[i]!;
        if (d.endsWith("w")) {
          const n = Number(d.slice(0, -1));
          if (Number.isFinite(n)) score = n;
        } else if (d.endsWith("x")) {
          const n = Number(d.slice(0, -1));
          if (Number.isFinite(n)) score = n * 1000;
        }
      }
      parts.push({ url, score });
    }
    if (preferSmall) {
      parts.sort((a, b) => a.score - b.score);
    } else {
      parts.sort((a, b) => {
        const ta = Math.abs((Number.isFinite(a.score) ? a.score : 800) - 640);
        const tb = Math.abs((Number.isFinite(b.score) ? b.score : 800) - 640);
        return ta - tb;
      });
    }
    for (const p of parts) push(p.url);
  }
  return out;
}

function imageBytes(img: DomNode, loadExternal?: ImageLoader): Uint8Array | undefined {
  for (const src of imageSourceCandidates(img)) {
    const data = decodeDataUrl(src);
    if (data !== undefined) return data;
    const external = loadExternal?.(src);
    if (external !== undefined) return external;
  }
  return undefined;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "bes-img-"));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Guest/page code may throw here; swallowed by design.
    }
  }
}

function decodePngFile(path: string): DecodedImage | undefined {
  try {
    const png = new Uint8Array(readFileSync(path));
    const raw = decodePng(png);
    return {
      width: raw.width,
      height: raw.height,
      pixels: new Uint8ClampedArray(raw.data),
    };
  } catch {
    return undefined;
  }
}

function decodeViaDwebpSync(bytes: Uint8Array): DecodedImage | undefined {
  return withTempDir((dir) => {
    const input = join(dir, "in.webp");
    const output = join(dir, "out.png");
    writeFileSync(input, bytes);
    const result = spawnSync("dwebp", [input, "-quiet", "-o", output], { encoding: "buffer" });
    if (result.status !== 0) return undefined;
    return decodePngFile(output);
  });
}

function decodeViaMagick(bytes: Uint8Array): DecodedImage | undefined {
  return withTempDir((dir) => {
    const input = join(dir, "in.bin");
    const output = join(dir, "out.png");
    writeFileSync(input, bytes);
    for (const tool of ["magick", "convert"] as const) {
      const result = spawnSync(tool, [input, output], { encoding: "buffer" });
      if (result.status === 0) return decodePngFile(output);
    }
    const sips = spawnSync("sips", ["-s", "format", "png", input, "--out", output], {
      encoding: "buffer",
    });
    if (sips.status !== 0) return undefined;
    return decodePngFile(output);
  });
}

function decodeViaDwebpPamSync(bytes: Uint8Array): DecodedImage | undefined {
  return withTempDir((dir) => {
    const input = join(dir, "in.webp");
    writeFileSync(input, bytes);
    const result = spawnSync("dwebp", [input, "-quiet", "-pam", "-o", "-"], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0 || result.stdout === undefined) return undefined;
    const out = result.stdout;
    return parsePamRgba(Buffer.isBuffer(out) ? out : Buffer.from(out));
  });
}

function decodeWebpSync(bytes: Uint8Array): DecodedImage | undefined {
  return decodeViaDwebpPamSync(bytes) ?? decodeViaDwebpSync(bytes) ?? decodeViaMagick(bytes);
}

let dwebpActive = 0;
const dwebpWaiters: Array<() => void> = [];
function acquireDwebp(): Promise<void> {
  if (dwebpActive < 8) {
    dwebpActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    dwebpWaiters.push(() => {
      dwebpActive += 1;
      resolve();
    });
  });
}
function releaseDwebp(): void {
  dwebpActive = Math.max(0, dwebpActive - 1);
  const next = dwebpWaiters.shift();
  if (next !== undefined) next();
}


function parsePamRgba(buf: Buffer): DecodedImage | undefined {
  const marker = Buffer.from("ENDHDR\n");
  const end = buf.indexOf(marker);
  if (end < 0) return undefined;
  const header = buf.subarray(0, end).toString("latin1");
  const widthMatch = /WIDTH\s+(\d+)/i.exec(header);
  const heightMatch = /HEIGHT\s+(\d+)/i.exec(header);
  const depthMatch = /DEPTH\s+(\d+)/i.exec(header);
  if (widthMatch === null || heightMatch === null) return undefined;
  const width = Number(widthMatch[1]);
  const height = Number(heightMatch[1]);
  const depth = depthMatch !== null ? Number(depthMatch[1]) : 4;
  if (!(width > 0) || !(height > 0) || width > 8192 || height > 8192) return undefined;
  const pixelsRaw = buf.subarray(end + marker.length);
  const expected = width * height * depth;
  if (pixelsRaw.length < expected) return undefined;
  if (depth === 4) {
    return {
      width,
      height,
      pixels: new Uint8ClampedArray(pixelsRaw.buffer, pixelsRaw.byteOffset, expected),
    };
  }
  if (depth === 3) {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < expected; i += 3, j += 4) {
      out[j] = pixelsRaw[i]!;
      out[j + 1] = pixelsRaw[i + 1]!;
      out[j + 2] = pixelsRaw[i + 2]!;
      out[j + 3] = 255;
    }
    return { width, height, pixels: out };
  }
  return undefined;
}

function decodeViaDwebpPamAsync(bytes: Uint8Array): Promise<DecodedImage | undefined> {
  return new Promise((resolve) => {
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), "bes-webp-"));
    } catch {
      resolve(undefined);
      return;
    }
    const input = join(dir, "in.webp");
    const cleanup = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
    };
    try {
      writeFileSync(input, bytes);
    } catch {
      cleanup();
      resolve(undefined);
      return;
    }
    void acquireDwebp().then(() => {
      const child = spawn("dwebp", [input, "-quiet", "-pam", "-o", "-"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => {
        chunks.push(c);
      });
      child.on("error", () => {
        releaseDwebp();
        cleanup();
        resolve(decodeViaMagick(bytes));
      });
      child.on("close", (code) => {
        try {
          if (code === 0) {
            const buf = Buffer.concat(chunks);
            const parsed = parsePamRgba(buf);
            if (parsed !== undefined) {
              resolve(parsed);
              return;
            }
          }
          resolve(decodeViaMagick(bytes));
        } finally {
          releaseDwebp();
          cleanup();
        }
      });
    });
  });
}

function decodeViaDwebpAsync(bytes: Uint8Array): Promise<DecodedImage | undefined> {
  return new Promise((resolve) => {
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), "bes-img-"));
    } catch {
      resolve(undefined);
      return;
    }
    const input = join(dir, "in.webp");
    const output = join(dir, "out.png");
    const cleanup = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Guest/page code may throw here; swallowed by design.
      }
    };
    try {
      writeFileSync(input, bytes);
    } catch {
      cleanup();
      resolve(undefined);
      return;
    }
    void acquireDwebp().then(() => {
      const child = spawn("dwebp", [input, "-quiet", "-o", output], { stdio: "ignore" });
      child.on("error", () => {
        releaseDwebp();
        cleanup();
        resolve(decodeViaMagick(bytes));
      });
      child.on("close", (code) => {
        try {
          if (code === 0) {
            resolve(decodePngFile(output));
          } else {
            resolve(decodeViaMagick(bytes));
          }
        } finally {
          releaseDwebp();
          cleanup();
        }
      });
    });
  });
}

const decodeCache = new Map<string, DecodedImage | null>();
const decodeAsyncInflight = new Map<string, Promise<DecodedImage | undefined>>();

function bytesKey(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

export function tryDecode(bytes: Uint8Array): DecodedImage | undefined {
  const key = bytesKey(bytes);
  if (decodeCache.has(key)) {
    return decodeCache.get(key) ?? undefined;
  }
  let decoded: DecodedImage | undefined;
  try {
    if (isPng(bytes)) {
      const raw = decodePng(bytes);
      decoded = {
        width: raw.width,
        height: raw.height,
        pixels: new Uint8ClampedArray(raw.data),
      };
    } else if (isJpeg(bytes)) {
      const raw = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
      decoded = {
        width: raw.width,
        height: raw.height,
        pixels: new Uint8ClampedArray(raw.data),
      };
    } else if (isWebp(bytes)) {
      decoded = decodeWebpSync(bytes);
    }
  } catch {
    decoded = undefined;
  }
  decodeCache.set(key, decoded ?? null);
  return decoded;
}

export function warmDecodeImageBytes(bytes: Uint8Array): Promise<DecodedImage | undefined> {
  return tryDecodeAsync(bytes);
}

export function collectFirstImageNodes(dom: DomTree, maxImages: number): NodeId[] {
  const ids: NodeId[] = [];
  const visit = (id: NodeId): void => {
    if (ids.length >= maxImages) return;
    const node = dom.nodes.get(id);
    if (node === undefined) return;
    if (node.kind === "element" && node.tag === "img") {
      ids.push(node.id);
    }
    for (const child of node.children) visit(child);
  };
  visit(dom.root);
  return ids;
}

async function tryDecodeAsync(bytes: Uint8Array): Promise<DecodedImage | undefined> {
  const key = bytesKey(bytes);
  if (decodeCache.has(key)) {
    return decodeCache.get(key) ?? undefined;
  }
  const existing = decodeAsyncInflight.get(key);
  if (existing !== undefined) return existing;

  const work = (async (): Promise<DecodedImage | undefined> => {
    try {
      if (isPng(bytes)) {
        const raw = decodePng(bytes);
        return {
          width: raw.width,
          height: raw.height,
          pixels: new Uint8ClampedArray(raw.data),
        };
      }
      if (isJpeg(bytes)) {
        const raw = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
        return {
          width: raw.width,
          height: raw.height,
          pixels: new Uint8ClampedArray(raw.data),
        };
      }
      if (isWebp(bytes)) {
        return (await decodeViaDwebpPamAsync(bytes)) ?? (await decodeViaDwebpAsync(bytes));
      }
    } catch {
      return undefined;
    }
    return undefined;
  })();

  decodeAsyncInflight.set(key, work);
  try {
    const decoded = await work;
    decodeCache.set(key, decoded ?? null);
    return decoded;
  } finally {
    decodeAsyncInflight.delete(key);
  }
}

function decodeDataUrl(src: string): Uint8Array | undefined {
  if (!src.startsWith("data:")) {
    return undefined;
  }
  const comma = src.indexOf(",");
  if (comma === -1) {
    return undefined;
  }
  const meta = src.slice(5, comma);
  const payload = src.slice(comma + 1);
  if (meta.toLowerCase().includes(";base64")) {
    return Uint8Array.from(Buffer.from(payload, "base64"));
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}
