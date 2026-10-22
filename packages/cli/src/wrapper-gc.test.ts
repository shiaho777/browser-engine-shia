/**
 * RFC 0041 GC'd DOM wrappers: the session-side wrapper caches
 * (`wrapperCache`, `styleWrappers`) hold wrappers through WeakRef, so a
 * wrapper no guest code references is collectible — identity holds while
 * anyone can observe it, nothing pins a node wrapper for the session's life.
 *
 * Real GC needs `--expose-gc`, which only applies at process startup — so
 * collection assertions run in a spawned driver (wrapper-gc.driver.js);
 * identity assertions that need no GC run in-process.
 *
 * Built by `tsc` then run with: `node --test packages/cli/dist/*.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FineSession } from "./fine.js";
import { runScriptsOnSessionReal, type EventDrivenRun } from "./event-loop.js";

const DOC = "<html><body><p id='p'>x</p></body></html>";

const pump = async (r: EventDrivenRun): Promise<Record<string, unknown>> => {
  const sandbox = r.sandbox as Record<string, unknown>;
  for (let i = 0; i < 200 && sandbox["__r"] === undefined; i += 1) {
    await r.flushAsync?.();
    r.drain?.();
    await new Promise((res) => setTimeout(res, 5));
  }
  return sandbox;
};

void test("wrappers: unreferenced element/style/detached wrappers are collectible", () => {
  const driver = fileURLToPath(new URL("./wrapper-gc.driver.js", import.meta.url));
  const r = spawnSync(process.execPath, ["--expose-gc", driver], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    r.status,
    0,
    `driver failed (status ${String(r.status)}):\n${r.stdout}\n${r.stderr}`,
  );
});

void test("wrappers: identity is stable while a wrapper is referenced", async () => {
  const out = await runScriptsOnSessionReal(new FineSession(DOC, "http://gc.local/"), [
    `__keep = document.getElementById("p");
     __r = [document.getElementById("p") === __keep,
            document.querySelector("#p") === __keep,
            document.body === document.querySelector("body")]`,
  ]);
  const sandbox = await pump(out);
  assert.equal(out.error, null);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__r"])), [true, true, true]);
});

void test("wrappers: referenced style keeps identity and expando state", async () => {
  const out = await runScriptsOnSessionReal(new FineSession(DOC, "http://gc.local/"), [
    `const s = document.getElementById("p").style;
     s.foo = 42;
     __r = [document.getElementById("p").style === s, s.foo]`,
  ]);
  const sandbox = await pump(out);
  assert.equal(out.error, null);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__r"])), [true, 42]);
});
