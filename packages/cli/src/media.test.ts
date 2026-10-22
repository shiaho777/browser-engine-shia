/**
 * RFC 0035 — `<video>`/`<audio>`: decoder bridge (pure-TS WAV + ffmpeg
 * subprocess) and the MediaEngine state machine behind the HTMLMediaElement
 * IDL surface. Under test: probe/decode round-trips, resource selection
 * (`src` + `<source>` with type/media filters), the event sequence, the
 * playback clock on the virtual loop, seek/loop/pause semantics, error
 * codes, and the paint-frame channel.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";
import {
  MediaEngine,
  canPlayMime,
  defaultMediaDecoders,
  ffmpegDecoder,
  wavDecoder,
} from "./media.js";

const PAGE = "https://example.com/app.html";

/** Synthesize a real RIFF/WAVE resource — 16-bit PCM sine, no fixtures. */
function makeWav(seconds = 0.3, rate = 8000, channels = 1): Uint8Array {
  const frames = Math.floor(seconds * rate);
  const dataSize = frames * channels * 2;
  const out = new Uint8Array(44 + dataSize);
  const dv = new DataView(out.buffer);
  const w32 = (o: number, v: number): void => dv.setUint32(o, v, true);
  const w16 = (o: number, v: number): void => dv.setUint16(o, v, true);
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  w32(4, 36 + dataSize);
  tag(8, "WAVE");
  tag(12, "fmt ");
  w32(16, 16);
  w16(20, 1); // PCM
  w16(22, channels);
  w32(24, rate);
  w32(28, rate * channels * 2); // byteRate
  w16(32, channels * 2); // block align
  w16(34, 16);
  tag(36, "data");
  w32(40, dataSize);
  for (let i = 0; i < frames * channels; i++) {
    dv.setInt16(44 + i * 2, Math.round(Math.sin(i / 8) * 12000), true);
  }
  return out;
}

/** ffmpeg-generated mp4 (testsrc+sine) — skipped when ffmpeg is absent. */
function makeMp4(): Uint8Array | null {
  // mp4 needs a seekable mux target — route through a temp file.
  const dir = mkdtempSync(join(tmpdir(), "media-test-"));
  const p = join(dir, "clip.mp4");
  try {
    execFileSync(
      "ffmpeg",
      [
        "-v", "error",
        "-f", "lavfi", "-i", "testsrc=size=64x48:duration=0.4:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=330:duration=0.4:sample_rate=8000",
        "-pix_fmt", "yuv420p",
        "-shortest",
        p,
      ],
      { stdio: "ignore" },
    );
    return new Uint8Array(readFileSync(p));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FF = ffmpegDecoder();
const MP4 = FF === null ? null : makeMp4();

// ---------------------------------------------------------------------------
// Decoder units
// ---------------------------------------------------------------------------

void test("wav decoder: probe reads fmt+data chunks, decodeAudio yields interleaved PCM", async () => {
  const bytes = makeWav(0.25, 8000);
  const d = wavDecoder();
  const probe = await d.probe(bytes);
  assert.ok(probe !== null);
  assert.equal(probe.durationSec, 0.25);
  assert.equal(probe.audio?.sampleRate, 8000);
  assert.equal(probe.audio?.channels, 1);
  assert.equal(probe.mime, "audio/wav");
  const pcm = await d.decodeAudio?.(bytes);
  assert.ok(pcm !== null && pcm !== undefined);
  assert.equal(pcm.sampleRate, 8000);
  assert.equal(pcm.samples.length, 2000); // 0.25s * 8000Hz * 1ch
  assert.ok(Math.abs(pcm.samples[4]!) > 0.1); // real sine, not silence
});

void test("wav decoder: rejects non-WAVE bytes", async () => {
  assert.equal(await wavDecoder().probe(new Uint8Array([1, 2, 3, 4])), null);
});

void test("ffmpeg bridge: probe video+audio, frameAt returns RGBA, decodeAudio PCM", async (t) => {
  if (FF === null || MP4 === null) {
    t.skip("ffmpeg/ffprobe not on PATH");
    return;
  }
  const probe = await FF.probe(MP4);
  assert.ok(probe !== null);
  assert.ok(Math.abs(probe.durationSec - 0.4) < 0.15, `duration ${probe.durationSec}`);
  assert.equal(probe.video?.width, 64);
  assert.equal(probe.video?.height, 48);
  assert.equal(probe.audio?.sampleRate, 8000);
  const frame = await FF.frameAt?.(MP4, 0.1, probe);
  assert.ok(frame !== null && frame !== undefined);
  assert.equal(frame.width, 64);
  assert.equal(frame.height, 48);
  assert.equal(frame.pixels.length, 64 * 48 * 4);
  const audio = await FF.decodeAudio?.(MP4);
  assert.ok(audio !== null && audio !== undefined);
  assert.ok(audio.samples.length > 2000);
});

void test("canPlayType honors the live decoder set", () => {
  const all = defaultMediaDecoders();
  assert.equal(canPlayMime("audio/wav", all), "maybe");
  assert.equal(canPlayMime('audio/wav; codecs="pcm"', all), "probably");
  assert.equal(canPlayMime("text/plain", all), "");
  const wavOnly = [wavDecoder()];
  assert.equal(canPlayMime("video/mp4", wavOnly), "");
  assert.equal(canPlayMime("audio/mpeg", wavOnly), "");
});

// ---------------------------------------------------------------------------
// MediaEngine + element IDL (through the real sandbox)
// ---------------------------------------------------------------------------

function engineFor(
  session: FineSession,
  files: ReadonlyMap<string, Uint8Array>,
  extra: { allowed?: (u: string) => boolean } = {},
): MediaEngine {
  return new MediaEngine({
    dom: () => session.dom,
    baseUrl: () => session.url,
    setAttribute: (id, n, v) => session.setAttribute(id, n, v),
    removeAttribute: (id, n) => session.removeAttribute(id, n),
    fetchMedia: (u) => {
      const b = files.get(u);
      return Promise.resolve(b === undefined ? null : { bytes: b });
    },
    ...(extra.allowed !== undefined ? { mediaAllowed: extra.allowed } : {}),
  });
}

interface MediaRun {
  readonly sandbox: Record<string, unknown>;
  readonly drain: () => void;
  readonly engine: MediaEngine;
}

function runMedia(
  html: string,
  script: string,
  files: ReadonlyMap<string, Uint8Array>,
  extra: { allowed?: (u: string) => boolean } = {},
): MediaRun {
  const session = new FineSession(html, PAGE);
  const engine = engineFor(session, files, extra);
  const r = runScriptsOnSession(session, [script], new Map(), { media: engine });
  assert.equal(r.error, null);
  return { sandbox: r.sandbox as Record<string, unknown>, drain: () => r.drain?.(), engine };
}

const WAV_URL = "https://example.com/tone.wav";
const MP4_URL = "https://example.com/clip.mp4";

void test("media element: play() loads through events, ends on the loop clock", async (t) => {
  if (MP4 === null) {
    t.skip("ffmpeg not available");
    return;
  }
  const files = new Map([[MP4_URL, MP4]]);
  const { sandbox, drain } = runMedia(
    `<video id=v src="${MP4_URL}"></video>`,
    `
      const v = document.getElementById("v");
      globalThis.log = [];
      for (const ev of ["loadstart","durationchange","loadedmetadata","loadeddata","canplay","canplaythrough","play","playing","ended","timeupdate","pause"]) {
        v.addEventListener(ev, () => { log.push(ev); });
      }
      globalThis.done = v.play().then(() => { globalThis.playing = { paused: v.paused, w: v.videoWidth, h: v.videoHeight, dur: v.duration, ct: v.currentTime }; });
    `,
    files,
  );
  await (sandbox["done"] as Promise<void>);
  const playing = sandbox["playing"] as { paused: boolean; w: number; h: number; dur: number; ct: number };
  assert.equal(playing.paused, false);
  assert.equal(playing.w, 64);
  assert.equal(playing.h, 48);
  assert.ok(Math.abs(playing.dur - 0.4) < 0.15);
  const log = sandbox["log"] as string[];
  // Spec order: fetch lifecycle events, then play, then playing.
  for (const want of ["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "play", "playing"]) {
    assert.ok(log.includes(want), `missing ${want} in ${log.join(",")}`);
  }
  assert.ok(log.indexOf("loadstart") < log.indexOf("loadedmetadata"));
  assert.ok(log.indexOf("loadedmetadata") < log.indexOf("canplay"));
  assert.ok(log.indexOf("play") < log.indexOf("playing"));
  // Pump the loop — the 0.4s clip ends and `timeupdate` ticks on the way.
  drain();
  assert.ok(log.includes("ended"), `no ended in ${log.join(",")}`);
  assert.ok(log.includes("timeupdate"), `no timeupdate in ${log.join(",")}`);
  const v = sandbox["document"] === undefined ? null : null;
  void v;
});

void test("media element: pause() freezes the clock; seek clamps and events fire", async (t) => {
  if (MP4 === null) {
    t.skip("ffmpeg not available");
    return;
  }
  const files = new Map([[MP4_URL, MP4]]);
  const { sandbox, drain } = runMedia(
    `<audio id=a src="${MP4_URL}"></audio>`,
    `
      const a = document.getElementById("a");
      globalThis.log = [];
      for (const ev of ["seeking","seeked","timeupdate","pause","play","playing","ended"]) {
        a.addEventListener(ev, () => log.push(ev));
      }
      globalThis.done = a.play().then(() => {
        a.pause();
        a.currentTime = 0.2;
        globalThis.snap = { paused: a.paused, ct: a.currentTime, dur: a.duration };
      });
    `,
    files,
  );
  await (sandbox["done"] as Promise<void>);
  const snap = sandbox["snap"] as { paused: boolean; ct: number; dur: number };
  assert.equal(snap.paused, true);
  assert.ok(Math.abs(snap.ct - 0.2) < 0.01);
  const log = sandbox["log"] as string[];
  assert.ok(log.includes("pause"));
  assert.ok(log.includes("seeking"));
  assert.ok(log.includes("seeked"));
  assert.ok(log.indexOf("seeking") < log.indexOf("seeked"));
  // Paused media never reaches `ended`.
  drain();
  assert.equal((sandbox["log"] as string[]).includes("ended"), false);
});

void test("media element: <source> selection skips unplayable types; error on bad bytes", async () => {
  const wav = makeWav();
  const files = new Map([[WAV_URL, wav]]);
  // mp4 source unplayable under a wav-only decoder set → skipped to source #2.
  const session = new FineSession(
    `<audio id=a><source src="https://example.com/clip.mp4" type="video/mp4"><source src="${WAV_URL}"></audio>`,
    PAGE,
  );
  const engine = new MediaEngine({
    dom: () => session.dom,
    baseUrl: () => session.url,
    setAttribute: (id, n, v) => session.setAttribute(id, n, v),
    removeAttribute: (id, n) => session.removeAttribute(id, n),
    fetchMedia: (u) => {
      const b = files.get(u);
      return Promise.resolve(b === undefined ? null : { bytes: b });
    },
    decoders: [wavDecoder()],
  });
  const r = runScriptsOnSession(
    session,
    [
      `
        const a = document.getElementById("a");
        globalThis.log = [];
        a.addEventListener("loadedmetadata", () => log.push("meta:" + a.duration + ":" + a.currentSrc));
        globalThis.done = a.play();
      `,
    ],
    new Map(),
    { media: engine },
  );
  assert.equal(r.error, null);
  await ((r.sandbox as Record<string, unknown>)["done"] as Promise<void>);
  const log = (r.sandbox as Record<string, unknown>)["log"] as string[];
  assert.ok(log.some((x) => x.startsWith("meta:0.3")), `log=${log.join(",")}`);
  assert.ok(log.some((x) => x.includes("tone.wav")));

  // Corrupt bytes → MEDIA_ERR_DECODE(3) + error event.
  const bad = new Map([["https://example.com/bad.bin", new Uint8Array([9, 9, 9, 9])]]);
  const r2 = runMedia(
    `<audio id=a src="https://example.com/bad.bin"></audio>`,
    `
      const a = document.getElementById("a");
      a.addEventListener("error", () => { globalThis.errCode = a.error && a.error.code; });
      globalThis.done = a.play().catch((e) => { globalThis.playRej = e.name; });
    `,
    bad,
  );
  await (r2.sandbox["done"] as Promise<void>).catch(() => undefined);
  assert.equal(r2.sandbox["errCode"], 3);
  assert.equal(r2.sandbox["playRej"], "NotSupportedError");
});

void test("media element: loop replays; preload=none skips fetch; autoplay kicks", async (t) => {
  if (MP4 === null) {
    t.skip("ffmpeg not available");
    return;
  }
  // loop: ended never arrives; seeking/seeked do.
  const files = new Map([[MP4_URL, MP4]]);
  const { sandbox, drain } = runMedia(
    `<audio id=a src="${MP4_URL}" loop></audio>`,
    `
      const a = document.getElementById("a");
      globalThis.log = [];
      for (const ev of ["ended","seeking","seeked","playing"]) a.addEventListener(ev, () => log.push(ev));
      globalThis.done = a.play();
    `,
    files,
  );
  await (sandbox["done"] as Promise<void>);
  drain();
  const log = sandbox["log"] as string[];
  assert.ok(log.includes("seeking"), `no loop-seek in ${log.join(",")}`);
  assert.equal(log.includes("ended"), false);
  const a2 = sandbox;
  void a2;

  // preload="none" on a fresh page → prime() does not fetch.
  let fetched = 0;
  const session2 = new FineSession(`<video src="${MP4_URL}" preload="none"></video>`, PAGE);
  const engine2 = new MediaEngine({
    dom: () => session2.dom,
    baseUrl: () => session2.url,
    setAttribute: (id, n, v) => session2.setAttribute(id, n, v),
    removeAttribute: (id, n) => session2.removeAttribute(id, n),
    fetchMedia: (u) => {
      fetched += 1;
      const b = files.get(u);
      return Promise.resolve(b === undefined ? null : { bytes: b });
    },
  });
  await engine2.prime();
  assert.equal(fetched, 0);

  // autoplay inside a scripted doc — prime() drives load→play.
  const session3 = new FineSession(`<audio id=a src="${MP4_URL}" autoplay></audio>`, PAGE);
  const engine3 = new MediaEngine({
    dom: () => session3.dom,
    baseUrl: () => session3.url,
    setAttribute: (id, n, v) => session3.setAttribute(id, n, v),
    removeAttribute: (id, n) => session3.removeAttribute(id, n),
    fetchMedia: (u) => {
      const b = files.get(u);
      return Promise.resolve(b === undefined ? null : { bytes: b });
    },
  });
  const r3 = runScriptsOnSession(
    session3,
    [`const a=document.getElementById("a"); a.addEventListener("playing",()=>{globalThis.played=true;});`],
    new Map(),
    { media: engine3 },
  );
  await engine3.prime();
  r3.drain?.();
  assert.equal((r3.sandbox as Record<string, unknown>)["played"], true);
  engine3.dispose();
});

void test("media-src gate refuses disallowed media URLs", async () => {
  const files = new Map([[WAV_URL, makeWav()]]);
  const { sandbox } = runMedia(
    `<audio id=a src="${WAV_URL}"></audio>`,
    `
      const a = document.getElementById("a");
      a.addEventListener("error", () => { globalThis.errCode = a.error && a.error.code; });
      globalThis.done = a.play().catch((e) => { globalThis.playRej = e.name; });
    `,
    files,
    { allowed: () => false },
  );
  await (sandbox["done"] as Promise<void>).catch(() => undefined);
  assert.equal(sandbox["errCode"], 4);
});

void test("video frames land on engine.frames() after materialize", async (t) => {
  if (MP4 === null) {
    t.skip("ffmpeg not available");
    return;
  }
  const files = new Map([[MP4_URL, MP4]]);
  const session = new FineSession(`<video id=v src="${MP4_URL}"></video>`, PAGE);
  const engine = engineFor(session, files);
  const r = runScriptsOnSession(
    session,
    [`const v=document.getElementById("v"); globalThis.done=v.load ? (v.play(), Promise.resolve()) : Promise.resolve();`],
    new Map(),
    { media: engine },
  );
  assert.equal(r.error, null);
  await engine.prime();
  const frames = engine.frames();
  assert.equal(frames.size, 1);
  const frame = [...frames.values()][0]!;
  assert.equal(frame.width, 64);
  assert.equal(frame.height, 48);
  // Decoded PCM is reachable through the same engine for audio checks.
  const pcm = await engine.decodeAudio([...frames.keys()][0]!);
  assert.ok(pcm !== null && pcm.samples.length > 1000);
  engine.dispose();
});
