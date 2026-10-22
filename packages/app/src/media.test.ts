/**
 * RFC 0035 — `<video>`/`<audio>` end-to-end: media bytes arrive through the
 * document's real network stack (media-src CSP gated, fetch-metadata
 * destination "video"/"audio"), get probed + decoded by the MediaEngine, and
 * the decoded frame rides the same `imageOf` channel as `<img>`/`<canvas>`
 * into paint. Also under test: play/ended event delivery on the real-time
 * virtual loop and `preload="none"` fetch suppression.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decodePng } from "@browser-engine/test-harness";

import { loadHtmlDocument } from "./page.js";
import { pumpFrame } from "./page.js";

process.env["BROWSER_ENGINE_USE_CURL"] = "0";

const VP = { width: 800, height: 600, devicePixelRatio: 1 };

function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string; hits: Map<string, number> }> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    req.on("end", () => {
      const p = req.url ?? "/";
      hits.set(p, (hits.get(p) ?? 0) + 1);
      handler(req, res);
    });
    req.resume();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, hits });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Solid-red 64×48 mp4 (plus a sine track) — skipped when ffmpeg is absent. */
function makeRedMp4(seconds = 0.4): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "app-media-test-"));
  const p = join(dir, "clip.mp4");
  try {
    execFileSync(
      "ffmpeg",
      [
        "-v", "error",
        "-f", "lavfi", "-i", `color=c=red:size=64x48:duration=${seconds}:rate=10`,
        "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}:sample_rate=8000`,
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

const MP4 = makeRedMp4();

void test("page <video>: real-network fetch → decoded frame lands in the PNG", async (t) => {
  if (MP4 === null) {
    t.skip("ffmpeg not on PATH");
    return;
  }
  const { server, url, hits } = await serve((req, res) => {
    if (req.url === "/clip.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(MP4);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const page = await loadHtmlDocument(
      `<!doctype html><title>t</title><body style="margin:0"><video src="/clip.mp4"></video></body>`,
      url,
      VP,
      { runScripts: true },
    );
    assert.ok(page.pngBytes !== undefined);
    assert.equal(hits.get("/clip.mp4"), 1, "media must ride the page network stack");
    // The decoded red frame letterboxes inside the element box — scan for a
    // red-dominant region ≈ the video's painted rect.
    const d = decodePng(page.pngBytes).data;
    let reds = 0;
    let minX = -1;
    let maxX = -1;
    for (let y = 0; y < VP.height; y++) {
      for (let x = 0; x < VP.width; x++) {
        const i = (y * VP.width + x) * 4;
        if (d[i]! > 200 && d[i + 1]! < 60 && d[i + 2]! < 60 && d[i + 3] === 255) {
          reds++;
          if (minX < 0 || x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    assert.ok(reds > 1500, `expected a painted red video frame, got ${reds} px`);
    assert.ok(maxX - minX + 1 >= 60, `frame should be ≈64px wide, got ${maxX - minX + 1}`);
  } finally {
    await close(server);
  }
});

void test("play() delivers play/playing/ended through the real-time loop", async (t) => {
  if (MP4 === null) {
    t.skip("ffmpeg not on PATH");
    return;
  }
  const { server, url } = await serve((req, res) => {
    if (req.url === "/clip.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(MP4);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const page = await loadHtmlDocument(
      `<!doctype html><title>t</title><body><video id="v" src="/clip.mp4"></video>
      <script>
        const v = document.getElementById("v");
        window.__events = [];
        for (const n of ["play", "playing", "timeupdate", "ended"]) {
          v.addEventListener(n, () => window.__events.push(n));
        }
        window.__ended = false;
        v.addEventListener("ended", () => { window.__ended = true; });
        v.play();
      </script></body>`,
      url,
      VP,
      { runScripts: true, keepAlive: true },
    );
    try {
      const win = page.runtime?.globals as Record<string, unknown> | null;
      assert.ok(win !== null && win !== undefined, "keepAlive runtime required");
      // Real-time loop: pump until `ended` or the watchdog expires.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && win["__ended"] !== true) {
        await pumpFrame(page, 30);
        await new Promise((r) => setTimeout(r, 60));
      }
      const events = (win["__events"] as unknown[]).map(String);
      assert.equal(win["__ended"], true, `ended never fired; events=${events.join(",")}`);
      assert.ok(events.includes("play"), "play event must fire");
      assert.ok(events.includes("playing"), "playing event must fire");
      assert.ok(events.includes("ended"), "ended event must fire");
      assert.ok(
        events.indexOf("play") < events.indexOf("playing"),
        `order: play before playing, got ${events.join(",")}`,
      );
    } finally {
      page.runtime?.disposeWorkers?.();
      page.media?.dispose();
    }
  } finally {
    await close(server);
  }
});

void test("media-src 'none' blocks the media fetch — no wire hit, element errors", async (t) => {
  if (MP4 === null) {
    t.skip("ffmpeg not on PATH");
    return;
  }
  const { server, url, hits } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(MP4);
  });
  try {
    const page = await loadHtmlDocument(
      `<!doctype html><title>t</title><body><video id="v" src="/clip.mp4"></video>
      <script>
        const v = document.getElementById("v");
        window.__snapshot = () => ({
          readyState: v.readyState,
          networkState: v.networkState,
          error: v.error === null ? null : v.error.code,
        });
      </script></body>`,
      url,
      VP,
      {
        runScripts: true,
        keepAlive: true,
        responseHeaders: { "content-security-policy": "media-src 'none'" },
      },
    );
    try {
      const win = page.runtime?.globals as Record<string, unknown> | null;
      const snap = (win?.["__snapshot"] as () => { readyState: number; networkState: number; error: number | null })();
      assert.equal(hits.get("/clip.mp4") ?? 0, 0, "media-src 'none' must stop the wire hit");
      assert.equal(snap.readyState, 0);
      assert.ok(snap.error !== null, "element must carry a media error");
    } finally {
      page.runtime?.disposeWorkers?.();
      page.media?.dispose();
    }
  } finally {
    await close(server);
  }
});

void test("preload=none suppresses the fetch; play() fetches on demand", async (t) => {
  if (MP4 === null) {
    t.skip("ffmpeg not on PATH");
    return;
  }
  const { server, url, hits } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(MP4);
  });
  try {
    const page = await loadHtmlDocument(
      `<!doctype html><title>t</title><body><video id="v" preload="none" src="/clip.mp4"></video>
      <script>
        const v = document.getElementById("v");
        window.__start = () => { v.play(); };
        window.__state = () => v.readyState;
      </script></body>`,
      url,
      VP,
      { runScripts: true, keepAlive: true },
    );
    try {
      const win = page.runtime?.globals as Record<string, unknown> | null;
      assert.equal(hits.get("/clip.mp4") ?? 0, 0, "preload=none must not fetch at load");
      (win?.["__start"] as () => void)();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (hits.get("/clip.mp4") ?? 0) === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(hits.get("/clip.mp4"), 1, "play() must trigger the deferred fetch");
    } finally {
      page.runtime?.disposeWorkers?.();
      page.media?.dispose();
    }
  } finally {
    await close(server);
  }
});
