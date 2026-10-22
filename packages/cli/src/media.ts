/**
 * media.ts — RFC 0035: `<video>`/`<audio>` — real decode + playback through a
 * platform codec bridge.
 *
 * ## Architecture
 *
 * Three layers, matching how the rest of the engine is organized:
 *
 *  1. {@link MediaDecoder}s turn compressed bytes into IR values —
 *     {@link MediaProbeResult} (metadata), {@link DecodedAudio} (interleaved
 *     float32 PCM), and {@link DecodedImage} (one video frame, RGBA — the
 *     same shape `<img>`/`<canvas>` already feed paint). Two decoders ship:
 *     a pure-TS RIFF/WAVE parser and an ffmpeg/ffprobe subprocess bridge
 *     (`ffmpegDecoder()` self-disables when the tools aren't on PATH).
 *
 *  2. {@link MediaEngine} owns per-element state (HTMLMediaElement state
 *     machine): resource selection (`src` then `<source>` children with
 *     type/media filtering), fetch through the host's network adapter,
 *     probe, the playback clock, event emission, and frame/poster
 *     materialization for paint. Timers ride the PAGE'S loop — the same
 *     virtual clock `setTimeout`/rAF use — so playback is deterministic in
 *     tests and advances only when the host pumps the loop.
 *
 *  3. {@link mediaDescriptors} builds the IDL surface (`play()`,
 *     `currentTime`, `readyState`, `videoWidth`, …) that `script.ts`
 *     installs onto `<video>`/`<audio>` wrappers.
 *
 * ## Honest boundaries
 *
 *  - Whole-file buffering: resources download completely before use (no
 *    Range/streaming). `buffered`/`seekable` therefore always report
 *    [0, duration] once loaded. `stalled`/`waiting` never fire post-load.
 *  - No audible output: audio decodes to PCM ({@link MediaEngine.decodeAudio})
 *    and the timeline/events advance — the element behaves like a muted tab.
 *  - Video frames decode on demand via ffmpeg (`frameAt`), cached per
 *    millisecond — each repaint shows the frame at `currentTime`; the engine
 *    does not autonomously repaint (the host's render pass paints live time).
 *  - `<audio>` without `controls` renders nothing (UA `display:none`);
 *    `audio[controls]` gets a 300×54 placeholder box with no widget toolkit.
 *  - `track`/textTracks/EME/remote-playback are stubbed honestly.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DecodedImage, DomNode, DomTree, NodeId } from "@browser-engine/ir";
import { coerceGuestString } from "@browser-engine/guest";
import {
  DEFAULT_MEDIA_ENVIRONMENT,
  mediaQueryListMatches,
  type MediaEnvironment,
} from "@browser-engine/css-parser";

// ---------------------------------------------------------------------------
// Decoder layer
// ---------------------------------------------------------------------------

/** What a decoder can tell us about a media resource. */
export interface MediaProbeResult {
  /** Seconds. NaN when the container doesn't carry a duration (streamed). */
  readonly durationSec: number;
  readonly video?: { readonly width: number; readonly height: number };
  readonly audio?: { readonly channels: number; readonly sampleRate: number };
  /** Best-guess container MIME (for `currentSrc` diagnostics). */
  readonly mime?: string | undefined;
}

/** Interleaved float32 PCM (the shape a WebAudio path would consume). */
export interface DecodedAudio {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly channels: number;
}

export interface MediaDecoder {
  readonly name: string;
  /** Container metadata; `null` ⇒ "these bytes are not mine". */
  probe(bytes: Uint8Array, mimeHint?: string): Promise<MediaProbeResult | null>;
  /** Video frame nearest `timeSec` as RGBA; `null` ⇒ no video path. */
  frameAt?(
    bytes: Uint8Array,
    timeSec: number,
    meta: MediaProbeResult,
  ): Promise<DecodedImage | null>;
  /** Whole-track audio decode to interleaved float32; `null` ⇒ unsupported. */
  decodeAudio?(bytes: Uint8Array): Promise<DecodedAudio | null>;
}

// ---- RIFF/WAVE (pure TS — always available) --------------------------------

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

interface WavInfo {
  format: number; // 1=PCM int, 3=IEEE float
  channels: number;
  sampleRate: number;
  byteRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

function parseWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44) return null;
  const tag = (o: number): string =>
    String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt: { format: number; channels: number; sampleRate: number; byteRate: number; bits: number } | null = null;
  let data: { offset: number; size: number } | null = null;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = u32(bytes, o + 4);
    const body = o + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      fmt = {
        format: u16(bytes, body),
        channels: u16(bytes, body + 2),
        sampleRate: u32(bytes, body + 4),
        byteRate: u32(bytes, body + 8),
        bits: u16(bytes, body + 14),
      };
    } else if (id === "data") {
      data = { offset: body, size: Math.min(size, bytes.length - body) };
      break; // data is last meaningful chunk
    }
    o = body + size + (size % 2); // chunks are 2-byte aligned
  }
  if (fmt === null || data === null || fmt.byteRate <= 0) return null;
  return {
    format: fmt.format,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    byteRate: fmt.byteRate,
    bitsPerSample: fmt.bits,
    dataOffset: data.offset,
    dataSize: data.size,
  };
}

export function wavDecoder(): MediaDecoder {
  return {
    name: "wav",
    probe(bytes: Uint8Array): Promise<MediaProbeResult | null> {
      const w = parseWav(bytes);
      if (w === null) return Promise.resolve(null);
      return Promise.resolve({
        durationSec: w.dataSize / w.byteRate,
        audio: { channels: w.channels, sampleRate: w.sampleRate },
        mime: "audio/wav",
      });
    },
    decodeAudio(bytes: Uint8Array): Promise<DecodedAudio | null> {
      const w = parseWav(bytes);
      if (w === null) return Promise.resolve(null);
      const frames = Math.floor(w.dataSize / Math.max(1, (w.bitsPerSample / 8) * w.channels));
      const total = frames * w.channels;
      const out = new Float32Array(total);
      const d = w.dataOffset;
      if (w.format === 3 && w.bitsPerSample === 32) {
        for (let i = 0; i < total; i++) {
          const o = d + i * 4;
          if (o + 4 > bytes.length) break;
          out[i] = new DataView(bytes.buffer, bytes.byteOffset + o, 4).getFloat32(0, true);
        }
      } else if (w.format === 1 && w.bitsPerSample === 16) {
        for (let i = 0; i < total; i++) {
          const o = d + i * 2;
          if (o + 2 > bytes.length) break;
          const v = u16(bytes, o);
          out[i] = ((v >= 0x8000 ? v - 0x10000 : v) / 0x8000);
        }
      } else if (w.format === 1 && w.bitsPerSample === 8) {
        for (let i = 0; i < total; i++) {
          if (d + i >= bytes.length) break;
          out[i] = (bytes[d + i]! - 128) / 128;
        }
      } else if (w.format === 1 && w.bitsPerSample === 24) {
        for (let i = 0; i < total; i++) {
          const o = d + i * 3;
          if (o + 3 > bytes.length) break;
          let v = bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16);
          if (v >= 0x800000) v -= 0x1000000;
          out[i] = v / 0x800000;
        }
      } else {
        return Promise.resolve(null); // A-law/mu-law/exotic — not this decoder's job
      }
      return Promise.resolve({ samples: out, sampleRate: w.sampleRate, channels: w.channels });
    },
  };
}

// ---- ffmpeg / ffprobe subprocess bridge -------------------------------------

/** One sync probe of PATH — resolved once at construction (spawnSync, ~ms). */
function toolExists(bin: string): boolean {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

interface FfprobeStream {
  readonly codec_type?: string;
  readonly width?: number;
  readonly height?: number;
  readonly channels?: number;
  readonly sample_rate?: string;
  readonly codec_name?: string;
}

interface FfprobeOut {
  readonly format?: { readonly duration?: string; readonly format_name?: string };
  readonly streams?: readonly FfprobeStream[];
}

function ffmpegMime(formatName: string | undefined, hasVideo: boolean): string | undefined {
  if (formatName === undefined) return undefined;
  const f = formatName.toLowerCase();
  if (f.includes("mp4") || f.includes("mov")) return hasVideo ? "video/mp4" : "audio/mp4";
  if (f.includes("webm") || f.includes("matroska")) return hasVideo ? "video/webm" : "audio/webm";
  if (f === "wav") return "audio/wav";
  if (f.includes("mp3")) return "audio/mpeg";
  if (f.includes("ogg")) return hasVideo ? "video/ogg" : "audio/ogg";
  if (f.includes("flac")) return "audio/flac";
  return undefined;
}

const execFileP = (
  bin: string,
  args: readonly string[],
  maxBuffer: number,
): Promise<{ stdout: Buffer; stderr: Buffer }> =>
  new Promise((resolve, reject) => {
    execFile(bin, args as string[], { maxBuffer, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(new Error(`${bin} failed: ${err.message} ${String(stderr)}`));
        return;
      }
      resolve({ stdout: stdout as unknown as Buffer, stderr: stderr as unknown as Buffer });
    });
  });

/**
 * The platform codec bridge. `ffmpeg`/`ffprobe` must be on PATH (or pass
 * explicit paths); without them `probe` returns null and the decoder is a
 * no-op — the WAV decoder remains as the always-available floor.
 */
export function ffmpegDecoder(
  paths: { ffmpeg?: string; ffprobe?: string } = {},
): MediaDecoder | null {
  const ffmpeg = paths.ffmpeg ?? "ffmpeg";
  const ffprobe = paths.ffprobe ?? "ffprobe";
  if (!toolExists(ffprobe) || !toolExists(ffmpeg)) return null;
  // Decoders see whole resources — one temp file per probe/decode call.
  const dirP = mkdtemp(join(tmpdir(), "engine-media-"));
  const writeTmp = async (bytes: Uint8Array): Promise<string> => {
    const p = join(await dirP, randomUUID());
    await writeFile(p, bytes);
    return p;
  };
  const cleanup = (p: string): void => {
    void rm(p, { force: true }).catch(() => undefined);
  };
  return {
    name: "ffmpeg",
    async probe(bytes: Uint8Array, mimeHint?: string): Promise<MediaProbeResult | null> {
      void mimeHint;
      const p = await writeTmp(bytes);
      try {
        const { stdout } = await execFileP(
          ffprobe,
          ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", p],
          8 << 20,
        );
        const out = JSON.parse(stdout.toString("utf8")) as FfprobeOut;
        if (out.streams === undefined || out.streams.length === 0) return null;
        const vs = out.streams.find((s) => s.codec_type === "video");
        const as = out.streams.find((s) => s.codec_type === "audio");
        if (vs === undefined && as === undefined) return null;
        const durationSec = Number(out.format?.duration);
        return {
          durationSec: Number.isFinite(durationSec) ? durationSec : NaN,
          ...(vs !== undefined && vs.width !== undefined && vs.height !== undefined
            ? { video: { width: vs.width, height: vs.height } }
            : {}),
          ...(as !== undefined
            ? {
                audio: {
                  channels: as.channels ?? 2,
                  sampleRate: Number(as.sample_rate) || 0,
                },
              }
            : {}),
          ...(ffmpegMime(out.format?.format_name, vs !== undefined) !== undefined
            ? { mime: ffmpegMime(out.format?.format_name, vs !== undefined) }
            : {}),
        };
      } catch {
        return null;
      } finally {
        cleanup(p);
      }
    },
    async frameAt(
      bytes: Uint8Array,
      timeSec: number,
      meta: MediaProbeResult,
    ): Promise<DecodedImage | null> {
      const v = meta.video;
      if (v === undefined || v.width <= 0 || v.height <= 0) return null;
      const p = await writeTmp(bytes);
      try {
        const { stdout } = await execFileP(
          ffmpeg,
          [
            "-v", "error",
            "-ss", String(Math.max(0, timeSec)),
            "-i", p,
            "-frames:v", "1",
            "-f", "rawvideo",
            "-pix_fmt", "rgba",
            "-",
          ],
          v.width * v.height * 4 + 1 << 20,
        );
        if (stdout.length < v.width * v.height * 4) return null;
        return {
          width: v.width,
          height: v.height,
          pixels: new Uint8ClampedArray(stdout.subarray(0, v.width * v.height * 4)),
          format: "raw",
        };
      } catch {
        return null;
      } finally {
        cleanup(p);
      }
    },
    async decodeAudio(bytes: Uint8Array): Promise<DecodedAudio | null> {
      const meta = await this.probe(bytes);
      if (meta === null || meta.audio === undefined) return null;
      const p = await writeTmp(bytes);
      try {
        const { stdout } = await execFileP(
          ffmpeg,
          ["-v", "error", "-i", p, "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-"],
          512 << 20,
        );
        const samples = new Float32Array(
          stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + (stdout.length & ~3)),
        );
        return { samples, sampleRate: meta.audio.sampleRate, channels: meta.audio.channels };
      } catch {
        return null;
      } finally {
        cleanup(p);
      }
    },
  };
}

/** The always-on WAV decoder plus the platform bridge when ffmpeg exists. */
export function defaultMediaDecoders(paths?: { ffmpeg?: string; ffprobe?: string }): MediaDecoder[] {
  const out: MediaDecoder[] = [wavDecoder()];
  const ff = ffmpegDecoder(paths);
  if (ff !== null) out.push(ff);
  return out;
}

// ---------------------------------------------------------------------------
// MIME playability (canPlayType / <source type> selection)
// ---------------------------------------------------------------------------

const MIME_FAMILIES: ReadonlyArray<readonly [RegExp, "audio" | "video", "wav" | "ffmpeg"]> = [
  [/^audio\/(x-?)?(wav|wave|vnd\.wave)$/i, "audio", "wav"],
  [/^audio\/(mpeg|mp3)$/i, "audio", "ffmpeg"],
  [/^audio\/(mp4|m4a|aac|ogg|flac|webm|x-m4a)$/i, "audio", "ffmpeg"],
  [/^video\/(mp4|webm|ogg|quicktime|x-matroska|3gpp2?)$/i, "video", "ffmpeg"],
];

function codecsKnown(mime: string): boolean {
  const m = /codecs\s*=\s*"([^"]+)"/i.exec(mime);
  if (m === null) return true; // bare mime
  return m[1]!.split(",").every((c) => {
    const t = c.trim().toLowerCase();
    return /^(avc1|av01|vp8|vp9|vp09|hvc1|hev1|mp4a|mp3|opus|vorbis|flac|aac|pcm|theora|h264|h265)/.test(t);
  });
}

/** HTMLMediaElement.canPlayType semantics over the live decoder set. */
export function canPlayMime(mime: string, decoders: readonly MediaDecoder[]): "" | "maybe" | "probably" {
  const base = mime.split(";")[0]!.trim();
  if (base === "") return "";
  const fam = MIME_FAMILIES.find(([re]) => re.test(base));
  if (fam === undefined) return "";
  const need = fam[2];
  const have = decoders.some((d) => (need === "wav" ? d.name === "wav" : d.name === "ffmpeg"));
  if (!have) return "";
  return codecsKnown(mime) ? (/codecs\s*=/.test(mime) ? "probably" : "maybe") : "";
}

// ---------------------------------------------------------------------------
// MediaEngine — per-document HTMLMediaElement state machines
// ---------------------------------------------------------------------------

export const NETWORK_EMPTY = 0;
export const NETWORK_IDLE = 1;
export const NETWORK_LOADING = 2;
export const NETWORK_NO_SOURCE = 3;
export const HAVE_NOTHING = 0;
export const HAVE_METADATA = 1;
export const HAVE_CURRENT_DATA = 2;
export const HAVE_FUTURE_DATA = 3;
export const HAVE_ENOUGH_DATA = 4;
export const MEDIA_ERR_ABORTED = 1;
export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

export interface MediaClock {
  now(): number; // ms — the page loop's clock (virtual or real)
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/**
 * A {@link MediaClock} backed by the host's real timers — used where no
 * virtual event loop exists (module-script runner, detached `Audio()`).
 * Numeric ids wrap Node's opaque Timeout handles so callers stay typed.
 */
export function nodeMediaClock(): MediaClock {
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 0;
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => {
      const id = ++next;
      handles.set(id, setTimeout(fn, ms));
      return id;
    },
    clearTimeout: (id) => {
      const h = handles.get(id);
      handles.delete(id);
      if (h !== undefined) clearTimeout(h);
    },
  };
}

export interface MediaFetchInit {
  readonly destination: "video" | "audio";
  /** Present ⇒ mode:"cors" fetch (the element's `crossorigin` mapping). */
  readonly cors?: { readonly credentials: "same-origin" | "include" } | undefined;
}

export interface MediaEngineDeps {
  dom(): DomTree;
  baseUrl(): string;
  setAttribute(id: NodeId, name: string, value: string): void;
  removeAttribute(id: NodeId, name: string): void;
  /**
   * The document's media fetch channel — `destination:"video"|"audio"`,
   * `mode` per `crossorigin`, COEP/COOP/CSP already enforced by the host
   * adapter. `null` ⇒ fetch failed; `undefined` deps ⇒ never fetch.
   */
  fetchMedia?(
    url: string,
    init: MediaFetchInit,
  ): Promise<{ bytes: Uint8Array; mime?: string } | null>;
  /** `media-src` CSP gate on the RESOLVED url — false ⇒ refuse like a network failure. */
  mediaAllowed?(url: string): boolean;
  /** `img-src` channel for `poster` — poster fetches are image fetches (Fetch §images). */
  fetchPoster?(url: string): Promise<DecodedImage | undefined>;
  mediaEnv?: MediaEnvironment;
  decoders?: MediaDecoder[];
}

interface MediaResource {
  readonly src: string;
  readonly bytes: Uint8Array;
  readonly mime?: string;
  readonly probe: MediaProbeResult;
  readonly decoder: MediaDecoder;
}

interface PendingPlay {
  resolve(): void;
  reject(err: unknown): void;
}

/** Internal per-element state — the DOM interface reflects over this. */
export interface MediaElementState {
  readonly id: NodeId;
  readonly kind: "video" | "audio";
  networkState: 0 | 1 | 2 | 3;
  readyState: 0 | 1 | 2 | 3 | 4;
  error: { readonly code: number; readonly message: string } | null;
  currentSrc: string;
  resource: MediaResource | null;
  /** In-flight resource selection/generation — `load()` bumps to cancel. */
  generation: number;
  loading: Promise<void> | null;
  // playback clock
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  baseTimeSec: number;
  clockStartMs: number | null;
  playbackRate: number;
  defaultPlaybackRate: number;
  volume: number;
  muted: boolean;
  pendingSeek: number | null;
  readonly pendingPlays: PendingPlay[];
  readonly timers: Set<number>;
  /** ms-quantized playback-time → decoded frame (null cached = decode failed). */
  readonly frameCache: Map<number, DecodedImage | null>;
  poster: DecodedImage | null | undefined; // undefined = not attempted
  paintFrame: DecodedImage | null; // what `frames()` hands paint right now
}

const emptyRanges = { length: 0, start: (_i: number): number => 0, end: (_i: number): number => 0 };
const timeRanges = (pairs: readonly (readonly [number, number])[]): {
  readonly length: number;
  start(i: number): number;
  end(i: number): number;
} => ({
  length: pairs.length,
  start: (i: number): number => {
    if (i < 0 || i >= pairs.length) throw new Error("IndexSizeError");
    return pairs[i]![0];
  },
  end: (i: number): number => {
    if (i < 0 || i >= pairs.length) throw new Error("IndexSizeError");
    return pairs[i]![1];
  },
});

export class MediaEngine {
  readonly deps: MediaEngineDeps;
  readonly #decoders: readonly MediaDecoder[];
  readonly #states = new Map<NodeId, MediaElementState>();
  #emit: ((id: NodeId, type: string) => void) | null = null;
  #clock: MediaClock | null = null;
  #disposed = false;

  constructor(deps: MediaEngineDeps) {
    this.deps = deps;
    this.#decoders = deps.decoders ?? defaultMediaDecoders();
  }

  /** The document API binds dispatch + the page clock once it exists. */
  readonly bindRuntime = (rt: { emit: (id: NodeId, type: string) => void; clock: MediaClock }): void => {
    this.#emit = rt.emit;
    this.#clock = rt.clock;
  };

  get decoders(): readonly MediaDecoder[] {
    return this.#decoders;
  }

  state(id: NodeId): MediaElementState {
    let st = this.#states.get(id);
    if (st === undefined) {
      const tag = this.deps.dom().nodes.get(id)?.tag;
      st = {
        id,
        kind: tag === "video" ? "video" : "audio",
        networkState: NETWORK_EMPTY,
        readyState: HAVE_NOTHING,
        error: null,
        currentSrc: "",
        resource: null,
        generation: 0,
        loading: null,
        paused: true,
        ended: false,
        seeking: false,
        baseTimeSec: 0,
        clockStartMs: null,
        playbackRate: 1,
        defaultPlaybackRate: 1,
        volume: 1,
        muted: this.#attr(id, "muted") !== undefined,
        pendingSeek: null,
        pendingPlays: [],
        timers: new Set(),
        frameCache: new Map(),
        poster: undefined,
        paintFrame: null,
      };
      this.#states.set(id, st);
    }
    return st;
  }

  #emitEvent(st: MediaElementState, type: string): void {
    this.#emit?.(st.id, type);
  }

  /** `video`/`audio` elements in tree order. */
  collect(): NodeId[] {
    const out: NodeId[] = [];
    const dom = this.deps.dom();
    const visit = (id: NodeId): void => {
      const n = dom.nodes.get(id);
      if (n === undefined) return;
      if (n.tag === "video" || n.tag === "audio") out.push(id);
      for (const c of n.children) visit(c);
    };
    visit(dom.root);
    return out;
  }

  #attr(id: NodeId, name: string): string | undefined {
    return this.deps.dom().nodes.get(id)?.attrs?.get(name);
  }

  #boolAttr(id: NodeId, name: string): boolean {
    return this.#attr(id, name) !== undefined;
  }

  #resolveUrl(raw: string): string | null {
    try {
      return new URL(raw, this.deps.baseUrl()).href;
    } catch {
      return null;
    }
  }

  /** crossorigin → fetch init (HTML §media element crossorigin mapping). */
  #corsInit(id: NodeId): { readonly credentials: "same-origin" | "include" } | undefined {
    const raw = this.#attr(id, "crossorigin");
    if (raw === undefined) return undefined;
    return raw.trim().toLowerCase() === "use-credentials"
      ? { credentials: "include" }
      : { credentials: "same-origin" };
  }

  /**
   * Resource selection (HTML §4.8.12.3): `src` wins; else `<source>` children
   * in tree order filtered by `type` (canPlayType over live decoders) and
   * `media` (media-query match). Returns the resolved URL + candidate node.
   */
  selectSource(st: MediaElementState): { url: string; sourceNode: NodeId | null } | null {
    const src = this.#attr(st.id, "src");
    if (src !== undefined && src.trim() !== "") {
      const url = this.#resolveUrl(src.trim());
      return url === null ? null : { url, sourceNode: null };
    }
    const node = this.deps.dom().nodes.get(st.id);
    if (node === undefined) return null;
    const env = this.deps.mediaEnv ?? DEFAULT_MEDIA_ENVIRONMENT;
    for (const childId of node.children) {
      const child = this.deps.dom().nodes.get(childId);
      if (child === undefined || child.tag !== "source") continue;
      const s = child.attrs?.get("src");
      if (s === undefined || s.trim() === "") continue;
      const type = child.attrs?.get("type");
      if (type !== undefined && type.trim() !== "" && canPlayMime(type.trim(), this.#decoders) === "") {
        continue;
      }
      const media = child.attrs?.get("media");
      if (media !== undefined && media.trim() !== "" && !mediaQueryListMatches(media.trim(), env)) {
        continue;
      }
      const url = this.#resolveUrl(s.trim());
      if (url !== null) return { url, sourceNode: childId };
    }
    return null;
  }

  /**
   * The resource-selection + decode step (`load()` and implicit triggers
   * funnel here). Cancellable per generation; events fire through the bound
   * emit channel (no-op on scriptless pages).
   */
  ensureLoaded(st: MediaElementState): Promise<void> {
    if (st.loading !== null) return st.loading;
    const generation = ++st.generation;
    const alive = (): boolean => !this.#disposed && st.generation === generation;
    const job = (async (): Promise<void> => {
      st.error = null;
      st.ended = false;
      const picked = this.selectSource(st);
      if (picked === null) {
        st.networkState = NETWORK_NO_SOURCE;
        return;
      }
      st.networkState = NETWORK_LOADING;
      st.currentSrc = picked.url;
      this.#emitEvent(st, "loadstart");
      if (this.deps.mediaAllowed !== undefined && !this.deps.mediaAllowed(picked.url)) {
        if (alive()) this.#fail(st, MEDIA_ERR_SRC_NOT_SUPPORTED, "blocked by Content Security Policy");
        return;
      }
      if (this.deps.fetchMedia === undefined) {
        if (alive()) this.#fail(st, MEDIA_ERR_SRC_NOT_SUPPORTED, "no media fetch channel");
        return;
      }
      const dest: "video" | "audio" = st.kind;
      const res = await this.deps
        .fetchMedia(picked.url, { destination: dest, ...(this.#corsInit(st.id) !== undefined ? { cors: this.#corsInit(st.id) } : {}) })
        .catch(() => null);
      if (!alive()) return;
      if (res === null || res.bytes.length === 0) {
        this.#fail(st, MEDIA_ERR_NETWORK, "media fetch failed");
        return;
      }
      this.#emitEvent(st, "progress");
      let probed: { probe: MediaProbeResult; decoder: MediaDecoder } | null = null;
      for (const d of this.#decoders) {
        const probe = await d.probe(res.bytes, res.mime).catch(() => null);
        if (!alive()) return;
        if (probe !== null) {
          probed = { probe, decoder: d };
          break;
        }
      }
      if (probed === null) {
        this.#fail(st, MEDIA_ERR_DECODE, "no decoder claimed the resource");
        return;
      }
      st.resource = {
        src: picked.url,
        bytes: res.bytes,
        ...(res.mime !== undefined ? { mime: res.mime } : {}),
        probe: probed.probe,
        decoder: probed.decoder,
      };
      st.readyState = HAVE_METADATA;
      st.networkState = NETWORK_IDLE;
      this.#emitEvent(st, "durationchange");
      this.#emitEvent(st, "loadedmetadata");
      if (st.pendingSeek !== null) {
        const t = Math.max(0, Math.min(st.pendingSeek, this.duration(st)));
        st.pendingSeek = null;
        this.#applySeek(st, t);
      }
      st.readyState = HAVE_CURRENT_DATA;
      this.#emitEvent(st, "loadeddata");
      st.readyState = HAVE_FUTURE_DATA;
      this.#emitEvent(st, "canplay");
      st.readyState = HAVE_ENOUGH_DATA;
      this.#emitEvent(st, "canplaythrough");
      // Poster + first frame materialize lazily for paint.
      await this.materialize(st);
      if (alive() && this.#boolAttr(st.id, "autoplay")) void this.play(st);
      this.#flushPendingPlays(st);
    })().finally(() => {
      if (st.generation === generation) st.loading = null;
    });
    st.loading = job;
    return job;
  }

  #fail(st: MediaElementState, code: number, message: string): void {
    st.error = { code, message };
    st.readyState = HAVE_NOTHING;
    st.networkState = st.currentSrc === "" ? NETWORK_NO_SOURCE : NETWORK_IDLE;
    this.#emitEvent(st, "error");
    const err = new Error(`MediaError: ${message}`);
    (err as { name?: string }).name = "NotSupportedError";
    for (const p of st.pendingPlays.splice(0)) p.reject(err);
  }

  duration(st: MediaElementState): number {
    return st.resource === null ? NaN : st.resource.probe.durationSec;
  }

  currentTime(st: MediaElementState): number {
    if (st.pendingSeek !== null && st.readyState === HAVE_NOTHING) return st.pendingSeek;
    if (st.clockStartMs === null || this.#clock === null) return st.baseTimeSec;
    const elapsed = ((this.#clock.now() - st.clockStartMs) / 1000) * st.playbackRate;
    const d = this.duration(st);
    const t = st.baseTimeSec + elapsed;
    return Number.isFinite(d) ? Math.min(t, d) : t;
  }

  /** Seek (`currentTime` setter / fastSeek). Sync seeked — full-buffer model. */
  seek(st: MediaElementState, toSec: number): void {
    const d = this.duration(st);
    const t = Math.max(0, Number.isFinite(d) ? Math.min(toSec, d) : toSec);
    if (st.readyState === HAVE_NOTHING) {
      st.pendingSeek = t;
      return;
    }
    this.#applySeek(st, t);
  }

  #applySeek(st: MediaElementState, t: number): void {
    if (this.currentTime(st) === t && !st.seeking) return;
    st.seeking = true;
    this.#emitEvent(st, "seeking");
    st.baseTimeSec = t;
    if (st.clockStartMs !== null && this.#clock !== null) {
      st.clockStartMs = this.#clock.now();
      this.#armEndTimer(st);
    }
    if (t < this.duration(st)) st.ended = false;
    st.seeking = false;
    this.#emitEvent(st, "seeked");
    this.#emitEvent(st, "timeupdate");
    void this.materialize(st);
  }

  #timer(st: MediaElementState, fn: () => void, ms: number): void {
    const clock = this.#clock;
    if (clock === null) return;
    const id = clock.setTimeout(() => {
      st.timers.delete(id);
      fn();
    }, ms);
    st.timers.add(id);
  }

  #clearTimers(st: MediaElementState): void {
    const clock = this.#clock;
    if (clock === null) return;
    for (const id of st.timers) clock.clearTimeout(id);
    st.timers.clear();
  }

  #armEndTimer(st: MediaElementState): void {
    if (this.#clock === null || st.clockStartMs === null) return;
    const d = this.duration(st);
    if (!Number.isFinite(d) || d <= 0) return;
    const remaining = Math.max(1, ((d - st.baseTimeSec) / Math.max(0.0001, st.playbackRate)) * 1000);
    this.#timer(st, () => this.#onEnded(st), remaining);
    // HTML ~4Hz–66Hz timeupdate cadence during playback — 250ms fixed.
    this.#timer(st, () => {
      if (st.clockStartMs !== null) {
        this.#emitEvent(st, "timeupdate");
        this.#armTimeupdate(st);
      }
    }, 250);
  }

  #armTimeupdate(st: MediaElementState): void {
    this.#timer(st, () => {
      if (st.clockStartMs !== null) {
        this.#emitEvent(st, "timeupdate");
        this.#armTimeupdate(st);
      }
    }, 250);
  }

  #onEnded(st: MediaElementState): void {
    if (st.clockStartMs === null) return;
    const d = this.duration(st);
    st.baseTimeSec = Number.isFinite(d) ? d : st.baseTimeSec;
    if (this.#boolAttr(st.id, "loop")) {
      // HTML: loop → seek to earliest possible position and keep playing.
      st.seeking = true;
      this.#emitEvent(st, "seeking");
      st.baseTimeSec = 0;
      if (this.#clock !== null) st.clockStartMs = this.#clock.now();
      st.seeking = false;
      this.#emitEvent(st, "seeked");
      this.#emitEvent(st, "timeupdate");
      this.#armEndTimer(st);
      return;
    }
    st.clockStartMs = null;
    this.#clearTimers(st);
    st.paused = true;
    st.ended = true;
    this.#emitEvent(st, "timeupdate");
    this.#emitEvent(st, "ended");
  }

  play(st: MediaElementState): Promise<void> {
    if (this.#disposed) {
      const rejected = Promise.reject<void>(
        Object.assign(new Error("media disposed"), { name: "AbortError" }),
      );
      rejected.catch(() => undefined); // see pendingPlays note below
      return rejected;
    }
    // Spec: play() during/after end → seek to the start first.
    if (st.ended) this.seek(st, 0);
    st.paused = false;
    if (st.readyState < HAVE_ENOUGH_DATA) {
      const promise = new Promise<void>((resolve, reject) => {
        st.pendingPlays.push({ resolve, reject });
      });
      // A guest's bare `v.play()` shares this process: without a handler an
      // engine-side rejection is a HOST unhandled rejection (fatal under
      // node --test). Marking it handled here does NOT stop later guest
      // .then/.catch from observing the same rejection.
      promise.catch(() => undefined);
      if (st.loading === null) void this.ensureLoaded(st);
      return promise;
    }
    if (st.clockStartMs === null) {
      if (this.#clock === null) {
        // Scriptless/no-clock run: mark playing honestly without a timeline.
        st.paused = false;
        this.#emitEvent(st, "play");
        this.#emitEvent(st, "playing");
        return Promise.resolve();
      }
      st.clockStartMs = this.#clock.now();
      st.ended = false;
      this.#emitEvent(st, "play");
      this.#emitEvent(st, "playing");
      this.#armEndTimer(st);
    }
    return Promise.resolve();
  }

  #flushPendingPlays(st: MediaElementState): void {
    if (st.pendingPlays.length === 0) return;
    if (st.paused) {
      for (const p of st.pendingPlays.splice(0)) p.resolve();
      return;
    }
    const pending = st.pendingPlays.splice(0);
    void this.play(st).then(() => {
      for (const p of pending) p.resolve();
    });
  }

  pause(st: MediaElementState): void {
    if (!st.paused || st.clockStartMs !== null) {
      st.baseTimeSec = this.currentTime(st);
      st.clockStartMs = null;
      this.#clearTimers(st);
      for (const p of st.pendingPlays.splice(0)) {
        p.reject(Object.assign(new Error("play() interrupted by pause()"), { name: "AbortError" }));
      }
      this.#emitEvent(st, "timeupdate");
      this.#emitEvent(st, "pause");
    }
    st.paused = true;
  }

  /** `load()` — re-run resource selection (also invoked implicitly). */
  load(st: MediaElementState): void {
    const had = st.resource !== null || st.networkState !== NETWORK_EMPTY;
    this.pause(st);
    st.generation += 1;
    st.loading = null;
    st.resource = null;
    st.readyState = HAVE_NOTHING;
    st.networkState = NETWORK_EMPTY;
    st.error = null;
    st.currentSrc = "";
    st.ended = false;
    st.frameCache.clear();
    st.paintFrame = null;
    st.poster = undefined;
    if (had) this.#emitEvent(st, "emptied");
    void this.ensureLoaded(st);
  }

  /** A `src` attribute write re-triggers selection (spec: src setter → load). */
  srcChanged(id: NodeId): void {
    const st = this.#states.get(id);
    if (st === undefined) return;
    this.load(st);
  }

  /**
   * Decode a video frame at the element's current time and the poster —
   * whichever should paint. Sync callers read {@link frames}.
   */
  async materialize(st: MediaElementState): Promise<void> {
    if (st.kind === "video") {
      const poster = this.#attr(st.id, "poster");
      if (poster !== undefined && st.poster === undefined && this.deps.fetchPoster !== undefined) {
        const url = this.#resolveUrl(poster.trim());
        st.poster = url === null ? null : await this.deps.fetchPoster(url).catch(() => null);
      }
      if (st.poster !== null && st.poster !== undefined) {
        st.paintFrame = st.poster;
        return;
      }
      if (st.resource !== null && st.resource.probe.video !== undefined && st.resource.decoder.frameAt !== undefined) {
        const qt = Math.round(this.currentTime(st) * 1000);
        let frame = st.frameCache.get(qt);
        if (frame === undefined) {
          frame = await st.resource.decoder
            .frameAt(st.resource.bytes, qt / 1000, st.resource.probe)
            .catch(() => null);
          if (st.frameCache.size > 60) st.frameCache.clear();
          st.frameCache.set(qt, frame);
        }
        st.paintFrame = frame ?? st.paintFrame;
      }
    }
  }

  /** PCM for a loaded audio resource (WebAudio-precursor surface + tests). */
  async decodeAudio(id: NodeId): Promise<DecodedAudio | null> {
    const st = this.#states.get(id);
    if (st?.resource === null || st === undefined || st.resource === null) return null;
    if (st.resource.decoder.decodeAudio === undefined) return null;
    return st.resource.decoder.decodeAudio(st.resource.bytes).catch(() => null);
  }

  /**
   * Render-pass entry: for every media element, honor `preload`/`autoplay`
   * (HTML: absent preload ⇒ "metadata" behavior — we still fetch the whole
   * file, the honest no-Range boundary) then materialize paint frames.
   */
  async prime(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const id of this.collect()) {
      const st = this.state(id);
      const preload = (this.#attr(id, "preload") ?? "auto").trim().toLowerCase();
      const want = preload !== "none" || this.#boolAttr(id, "autoplay") || !st.paused;
      if (st.loading !== null) {
        // A load is already in flight (script-initiated play()/load()) — the
        // paint pass materializes once it lands instead of racing a second load.
        jobs.push(st.loading.then(() => this.materialize(st)));
      } else if (want && st.readyState === HAVE_NOTHING && st.error === null) {
        jobs.push(this.ensureLoaded(st));
      } else {
        jobs.push(this.materialize(st));
      }
    }
    await Promise.all(jobs);
  }

  /** Paint's view: element → current frame (poster or decoded video frame). */
  frames(): ReadonlyMap<NodeId, DecodedImage> {
    const out = new Map<NodeId, DecodedImage>();
    for (const st of this.#states.values()) {
      if (st.kind === "video" && st.paintFrame !== null) out.set(st.id, st.paintFrame);
    }
    return out;
  }

  /** Public event channel — the IDL setters fire through it (volumechange/ratechange). */
  emit(id: NodeId, type: string): void {
    this.#emit?.(id, type);
  }

  /**
   * `playbackRate` write: re-anchor the clock base at the new rate and
   * re-arm the end timer (HTML §4.8.12.5 effective playback rate change).
   */
  setPlaybackRate(st: MediaElementState, rate: number): void {
    st.baseTimeSec = this.currentTime(st);
    st.playbackRate = rate;
    if (st.clockStartMs !== null && this.#clock !== null) {
      st.clockStartMs = this.#clock.now();
      this.#clearTimers(st);
      this.#armEndTimer(st);
    }
    this.#emitEvent(st, "ratechange");
  }

  /** Page teardown — every pending timer and in-flight selection dies here. */
  dispose(): void {
    this.#disposed = true;
    for (const st of this.#states.values()) {
      this.#clearTimers(st);
      for (const p of st.pendingPlays.splice(0)) {
        p.reject(Object.assign(new Error("media disposed"), { name: "AbortError" }));
      }
    }
    this.#states.clear();
  }
}

// ---------------------------------------------------------------------------
// IDL surface — PropertyDescriptorMap installed on video/audio wrappers
// ---------------------------------------------------------------------------

const coerceStr = coerceGuestString;

/**
 * The HTMLMediaElement/HTMLVideoElement/HTMLAudioElement IDL surface.
 * Returns descriptors so `Object.defineProperties` installs them as OWN
 * properties on the wrapper (they must shadow the generic wrapper's
 * same-named members — e.g. `width` on every element).
 */
export function mediaDescriptors(engine: MediaEngine, nodeId: NodeId): PropertyDescriptorMap {
  const st = (): MediaElementState => engine.state(nodeId);
  const node = (): DomNode | undefined => engine.deps.dom().nodes.get(nodeId);
  const attr = (name: string): string | undefined => node()?.attrs?.get(name);
  const hasAttr = (name: string): boolean => attr(name) !== undefined;
  const setBool = (name: string, v: unknown): void => {
    if (v === true || v === "true" || v === "") {
      if (!hasAttr(name)) engine.deps.setAttribute(nodeId, name, "");
    } else if (hasAttr(name)) {
      engine.deps.setAttribute(nodeId, name, "");
      // boolean removal — the session has no removeAttribute hook exposed
      // through deps; setAttribute("") keeps the attr PRESENT so use the
      // dedicated removal below.
    }
  };
  const desc = (d: PropertyDescriptor): PropertyDescriptor => ({ enumerable: true, configurable: true, ...d });
  const consts: Record<string, PropertyDescriptor> = {
    NETWORK_EMPTY: desc({ value: NETWORK_EMPTY }),
    NETWORK_IDLE: desc({ value: NETWORK_IDLE }),
    NETWORK_LOADING: desc({ value: NETWORK_LOADING }),
    NETWORK_NO_SOURCE: desc({ value: NETWORK_NO_SOURCE }),
    HAVE_NOTHING: desc({ value: HAVE_NOTHING }),
    HAVE_METADATA: desc({ value: HAVE_METADATA }),
    HAVE_CURRENT_DATA: desc({ value: HAVE_CURRENT_DATA }),
    HAVE_FUTURE_DATA: desc({ value: HAVE_FUTURE_DATA }),
    HAVE_ENOUGH_DATA: desc({ value: HAVE_ENOUGH_DATA }),
    MEDIA_ERR_ABORTED: desc({ value: MEDIA_ERR_ABORTED }),
    MEDIA_ERR_NETWORK: desc({ value: MEDIA_ERR_NETWORK }),
    MEDIA_ERR_DECODE: desc({ value: MEDIA_ERR_DECODE }),
    MEDIA_ERR_SRC_NOT_SUPPORTED: desc({ value: MEDIA_ERR_SRC_NOT_SUPPORTED }),
  };
  const isVideo = (): boolean => st().kind === "video";
  return {
    ...consts,
    src: desc({
      get: () => {
        const raw = attr("src");
        if (raw === undefined) return "";
        try {
          return new URL(raw, engine.deps.baseUrl()).href;
        } catch {
          return raw;
        }
      },
      set: (v: unknown) => {
        engine.deps.setAttribute(nodeId, "src", coerceStr(v));
        engine.srcChanged(nodeId);
      },
    }),
    currentSrc: desc({ get: () => st().currentSrc }),
    crossOrigin: desc({
      get: () => {
        const raw = attr("crossorigin");
        if (raw === undefined) return null;
        const t = raw.trim().toLowerCase();
        return t === "use-credentials" ? "use-credentials" : "anonymous";
      },
      set: (v: unknown) => {
        if (v === null || v === undefined) {
          if (hasAttr("crossorigin")) engine.deps.removeAttribute(nodeId, "crossorigin");
        } else {
          const t = coerceStr(v).trim().toLowerCase();
          engine.deps.setAttribute(
            nodeId,
            "crossorigin",
            t === "use-credentials" ? "use-credentials" : "anonymous",
          );
        }
      },
    }),
    preload: desc({
      get: () => attr("preload") ?? "auto",
      set: (v: unknown) => engine.deps.setAttribute(nodeId, "preload", coerceStr(v)),
    }),
    autoplay: desc({
      get: () => hasAttr("autoplay"),
      set: (v: unknown) => setBool("autoplay", v),
    }),
    loop: desc({
      get: () => hasAttr("loop"),
      set: (v: unknown) => setBool("loop", v),
    }),
    controls: desc({
      get: () => hasAttr("controls"),
      set: (v: unknown) => setBool("controls", v),
    }),
    defaultMuted: desc({
      get: () => hasAttr("muted"),
      set: (v: unknown) => setBool("muted", v),
    }),
    muted: desc({
      get: () => st().muted,
      set: (v: unknown) => {
        const m = v === true;
        const s = st();
        if (s.muted !== m) {
          s.muted = m;
          engine.emit(nodeId, "volumechange");
        }
      },
    }),
    volume: desc({
      get: () => st().volume,
      set: (v: unknown) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new RangeError("volume must be between 0 and 1");
        }
        const s = st();
        if (s.volume !== n) {
          s.volume = n;
          engine.emit(nodeId, "volumechange");
        }
      },
    }),
    playbackRate: desc({
      get: () => st().playbackRate,
      set: (v: unknown) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n === 0) return;
        const s = st();
        if (s.playbackRate !== n) engine.setPlaybackRate(s, n);
      },
    }),
    defaultPlaybackRate: desc({
      get: () => st().defaultPlaybackRate,
      set: (v: unknown) => {
        const n = Number(v);
        if (Number.isFinite(n) && n !== 0) st().defaultPlaybackRate = n;
      },
    }),
    currentTime: desc({
      get: () => engine.currentTime(st()),
      set: (v: unknown) => {
        const n = Number(v);
        if (Number.isFinite(n)) engine.seek(st(), n);
      },
    }),
    fastSeek: desc({
      value: (v: unknown) => {
        const n = Number(v);
        if (Number.isFinite(n)) engine.seek(st(), n);
      },
    }),
    duration: desc({ get: () => engine.duration(st()) }),
    paused: desc({ get: () => st().paused }),
    ended: desc({ get: () => st().ended }),
    seeking: desc({ get: () => st().seeking }),
    readyState: desc({ get: () => st().readyState }),
    networkState: desc({ get: () => st().networkState }),
    error: desc({ get: () => st().error }),
    buffered: desc({
      get: () => {
        const d = engine.duration(st());
        return st().readyState >= HAVE_METADATA && Number.isFinite(d)
          ? timeRanges([[0, d]])
          : emptyRanges;
      },
    }),
    seekable: desc({
      get: () => {
        const d = engine.duration(st());
        return st().readyState >= HAVE_METADATA && Number.isFinite(d)
          ? timeRanges([[0, d]])
          : emptyRanges;
      },
    }),
    played: desc({
      get: () => {
        const t = engine.currentTime(st());
        return st().readyState >= HAVE_CURRENT_DATA ? timeRanges([[0, t]]) : emptyRanges;
      },
    }),
    videoWidth: desc({ get: () => (isVideo() ? st().resource?.probe.video?.width ?? 0 : 0) }),
    videoHeight: desc({ get: () => (isVideo() ? st().resource?.probe.video?.height ?? 0 : 0) }),
    poster: desc({
      get: () => attr("poster") ?? "",
      set: (v: unknown) => {
        engine.deps.setAttribute(nodeId, "poster", coerceStr(v));
        st().poster = undefined;
        void engine.materialize(st());
      },
    }),
    load: desc({ value: () => engine.load(st()) }),
    play: desc({ value: () => engine.play(st()) }),
    pause: desc({ value: () => engine.pause(st()) }),
    canPlayType: desc({ value: (mime: unknown) => canPlayMime(coerceStr(mime), engine.decoders) }),
    addTextTrack: desc({
      value: (kind?: unknown, label?: unknown, language?: unknown) => ({
        kind: coerceStr(kind) || "subtitles",
        label: coerceStr(label),
        language: coerceStr(language),
        mode: "hidden",
        cues: null,
        activeCues: null,
      }),
    }),
    textTracks: desc({ get: () => ({ length: 0, item: () => null }) }),
    audioTracks: desc({ get: () => ({ length: 0 }) }),
    videoTracks: desc({ get: () => ({ length: 0 }) }),
    mediaKeys: desc({ get: () => null }),
    disableRemotePlayback: desc({
      get: () => hasAttr("disableremoteplayback"),
      set: (v: unknown) => setBool("disableremoteplayback", v),
    }),
    preservesPitch: desc({ get: () => true, set: () => undefined }),
    controlsList: desc({ get: () => ({ contains: () => false }) }),
  };
}


