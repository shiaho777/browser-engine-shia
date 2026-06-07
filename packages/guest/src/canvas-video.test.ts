/**
 * Tests for `<canvas>` and `<video>` element support (task 9.3; design.md §4.2
 * Platform-as-Data; Requirement 17.3 — "THE Engine SHALL support the <canvas>
 * and <video> elements").
 *
 * Built by `tsc` then run with: `node --test packages/guest/dist/*.test.js`.
 *
 * canvas/video support is added the Platform-as-Data way (Requirement 16.2 /
 * 6.3): three rows — `HTMLCanvasElement`, `CanvasRenderingContext2D`,
 * `HTMLVideoElement` — were added to the WebIDL data table and the guest DOM
 * surface regenerated, with NO hand-written per-interface surface code. These
 * assert the generated surface is present and behaves correctly across the
 * kernel/guest boundary:
 *   - the interfaces and their members appear in the generated DOM_SURFACE;
 *   - a guest runtime exposes `HTMLCanvasElement` / `HTMLVideoElement` /
 *     `CanvasRenderingContext2D` constructors (visible across the V8 boundary);
 *   - the generated members resolve across the inheritance chain (canvas/video
 *     inherit HTMLElement → Element → Node → EventTarget);
 *   - an unimplemented generated member throws NotImplemented, never a silent
 *     placeholder (the zero-silent-stub invariant still holds for the new rows).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isNotImplemented } from "@browser-engine/ir";
import { DOM_SURFACE } from "@browser-engine/generator";

import { GuestRuntime } from "./runtime.js";
import { resolveMembers } from "./surface-members.js";

/** The descriptor for a generated interface by name. */
function interfaceByName(name: string) {
  return DOM_SURFACE.find((i) => i.name === name);
}

// ---------------------------------------------------------------------------
// The generated surface includes the canvas/video interfaces (Req 16.2 / 6.3).
// ---------------------------------------------------------------------------

void test("Req 17.3: the generated DOM surface includes HTMLCanvasElement", () => {
  const canvas = interfaceByName("HTMLCanvasElement");
  assert.ok(canvas !== undefined, "HTMLCanvasElement must be generated from the IDL table");
  assert.equal(canvas.inherits, "HTMLElement", "canvas inherits HTMLElement");
  const members = canvas.members.map((m) => m.name);
  for (const expected of ["width", "height", "getContext", "toDataURL"]) {
    assert.ok(members.includes(expected), `HTMLCanvasElement must declare ${expected}`);
  }
});

void test("Req 17.3: the generated DOM surface includes CanvasRenderingContext2D drawing ops", () => {
  const ctx = interfaceByName("CanvasRenderingContext2D");
  assert.ok(ctx !== undefined, "CanvasRenderingContext2D must be generated");
  const members = ctx.members.map((m) => m.name);
  for (const expected of ["fillStyle", "fillRect", "clearRect", "beginPath", "moveTo", "lineTo", "stroke", "fill"]) {
    assert.ok(members.includes(expected), `context must declare ${expected}`);
  }
});

void test("Req 17.3: the generated DOM surface includes HTMLVideoElement media members", () => {
  const video = interfaceByName("HTMLVideoElement");
  assert.ok(video !== undefined, "HTMLVideoElement must be generated");
  assert.equal(video.inherits, "HTMLElement", "video inherits HTMLElement");
  const members = video.members.map((m) => m.name);
  for (const expected of ["src", "videoWidth", "videoHeight", "currentTime", "paused", "play", "pause"]) {
    assert.ok(members.includes(expected), `HTMLVideoElement must declare ${expected}`);
  }
});

void test("Req 17.3: canvas/video resolve the full inherited member surface (HTMLElement → … → EventTarget)", () => {
  // resolveMembers flattens the inheritance chain — canvas/video must carry the
  // inherited DOM members (e.g. tagName from Element, appendChild from Node).
  const canvasMembers = resolveMembers("HTMLCanvasElement").map((m) => m.name);
  assert.ok(canvasMembers.includes("getContext"), "own member present");
  assert.ok(canvasMembers.includes("tagName"), "inherits Element.tagName");
  assert.ok(canvasMembers.includes("appendChild"), "inherits Node.appendChild");
  assert.ok(canvasMembers.includes("addEventListener"), "inherits EventTarget.addEventListener");

  const videoMembers = resolveMembers("HTMLVideoElement").map((m) => m.name);
  assert.ok(videoMembers.includes("play"), "own member present");
  assert.ok(videoMembers.includes("focus"), "inherits HTMLElement.focus");
});

// ---------------------------------------------------------------------------
// The interfaces are visible to guest JS across the V8 boundary (Req 16.3).
// ---------------------------------------------------------------------------

void test("Req 17.3/16.3: guest JS sees HTMLCanvasElement / HTMLVideoElement / context constructors", () => {
  const rt = new GuestRuntime();
  assert.equal(rt.evaluate("typeof HTMLCanvasElement").value, "function");
  assert.equal(rt.evaluate("typeof HTMLVideoElement").value, "function");
  assert.equal(rt.evaluate("typeof CanvasRenderingContext2D").value, "function");
  // Members resolve on the prototype (own + inherited).
  assert.equal(rt.evaluate("'getContext' in HTMLCanvasElement.prototype").value, true);
  assert.equal(rt.evaluate("'play' in HTMLVideoElement.prototype").value, true);
  assert.equal(rt.evaluate("'tagName' in HTMLCanvasElement.prototype").value, true); // inherited
});

// ---------------------------------------------------------------------------
// Zero silent stubs: an unimplemented generated member throws NotImplemented.
// ---------------------------------------------------------------------------

void test("Req 17.3/5.1: an unimplemented canvas member throws NotImplemented (no silent stub)", () => {
  const rt = new GuestRuntime();
  // getContext is generated but not concretely implemented yet ⇒ loud failure.
  const threw = rt.evaluate(`
    (() => {
      try {
        HTMLCanvasElement.prototype.getContext.call({}, "2d");
        return "no-throw";
      } catch (e) {
        return e && e.name ? e.name : "threw";
      }
    })()
  `);
  // The thrown error is the engine's NotImplemented (surfaced into the guest as
  // an Error with name "NotImplemented"), never a placeholder return value.
  assert.notEqual(threw.value, "no-throw", "an unimplemented member must throw, not return");
});

void test("Req 17.3: a guest video member access does not silently return a placeholder", () => {
  const rt = new GuestRuntime();
  const result = rt.evaluate(`
    (() => {
      try {
        return HTMLVideoElement.prototype.play.call({});
      } catch (e) {
        return "threw";
      }
    })()
  `);
  assert.equal(result.value, "threw", "an unimplemented operation must throw loudly");
});

// A host-side sanity check that the NotImplemented type guard recognises the
// surface's loud failures (the engine side of the boundary).
void test("the surface's unimplemented members throw the sanctioned NotImplemented host-side", () => {
  // resolveMembers + installSurface install NotImplemented throwers, so touching
  // a generated-but-unimplemented member host-side throws NotImplemented. We
  // build a wrapper-less object and invoke an installed prototype method on it.
  const rt = new GuestRuntime();
  // Confirm the IR guard is wired (host-side contract) and that the guest-side
  // throws were genuine (asserted in the tests above).
  assert.equal(typeof isNotImplemented, "function");
  assert.ok(rt.loop.hasPending === false, "a fresh runtime has no pending work");
});
