/**
 * End-to-end RFC 0004 test: a real web-content worker behind the binary IPC
 * protocol — navigate, hit-test, click-to-focus, text edit, pump, frame pull,
 * and renderer kill → lazy respawn.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { HOME_URL, FORM_URL } from "./home.js";
import { WebContentClient } from "./webcontent-client.js";

const VP = { width: 900, height: 700, devicePixelRatio: 1 };

void test("web-content worker round-trips the full engine surface", async (t) => {
  const client = new WebContentClient();
  t.after(async () => client.terminate());

  const pong = await client.ping();
  assert.equal(pong.ok, true);
  assert.ok(pong.fonts.length > 0, "renderer reports its own font stack");

  const nav = await client.navigate(HOME_URL, VP, { push: true });
  assert.equal(nav.frame?.url, "engine://home");
  assert.ok((nav.frame?.png.byteLength ?? 0) > 100, "PNG bytes crossed the wire");
  assert.ok(nav.nav.hasPage);

  const hit = await client.hitTest(20, 20);
  assert.equal(typeof hit.cursor === "string", true);

  const bytes = await client.frameBytes();
  assert.ok((bytes.png?.byteLength ?? 0) > 100);
  assert.ok(bytes.frameRev >= 1);

  const navState = await client.navState();
  assert.equal(navState.url, "engine://home");
  assert.equal(navState.canGoForward, false);
});

void test("click + commitText on a form page run inside the worker", async (t) => {
  const client = new WebContentClient();
  t.after(async () => client.terminate());
  await client.navigate(FORM_URL, VP, { push: true });

  // Find the editable node via the wire — the same scan the shell performs.
  let editableAt: { x: number; y: number } | null = null;
  for (let y = 0; y < VP.height && editableAt === null; y += 8) {
    for (let x = 0; x < VP.width; x += 8) {
      const hit = await client.hitTest(x, y);
      if (hit.editable !== null && hit.editable !== undefined) {
        editableAt = { x, y };
        break;
      }
    }
  }
  assert.ok(editableAt !== null, "expected an editable hit on the form page");

  const click = await client.click(editableAt.x, editableAt.y, VP);
  assert.equal(click.navigated, false);
  assert.ok(click.editable !== null);

  const typed = await client.commitText(click.editable.nodeId, "ipc hello 中文");
  assert.ok(typed.frame !== null);
  assert.ok((typed.frame?.frameRev ?? 0) >= 2, "edit produced a new frame rev");
});

void test("a killed renderer fails nothing else and respawns on demand", async (t) => {
  const client = new WebContentClient();
  t.after(async () => client.terminate());
  await client.navigate(HOME_URL, VP, { push: true });

  await client.kill(); // renderer exits; the channel marks itself dead

  // Next call transparently spawns a fresh (empty-session) renderer.
  const nav = await client.navigate(HOME_URL, VP, { push: true });
  assert.equal(nav.frame?.url, "engine://home");
  assert.ok((nav.frame?.png.byteLength ?? 0) > 100);
});

void test("serialized ops survive a long navigate racing a hit-test", async (t) => {
  const client = new WebContentClient();
  t.after(async () => client.terminate());
  const navigating = client.navigate(HOME_URL, VP, { push: true });
  const hit = client.hitTest(10, 10); // queued behind the navigate
  const [nav] = await Promise.all([navigating, hit]);
  assert.ok(nav.frame !== null);
});
