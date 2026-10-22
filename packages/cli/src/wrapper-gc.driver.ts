/**
 * RFC 0041 wrapper-GC driver — spawned by wrapper-gc.test.ts as
 * `node --expose-gc dist/wrapper-gc.driver.js` because V8's `--expose-gc`
 * flag can only be applied at process startup, not at runtime.
 *
 * Each case boots a real session, weakly references a wrapper produced by
 * guest code, forces a full GC, and asserts the wrapper was collected —
 * proving the session-side caches hold WeakRefs, not strong refs.
 */
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { FineSession } from "./fine.js";
import { runScriptsOnSessionReal } from "./event-loop.js";

const gc = (globalThis as { gc?: () => void }).gc;
if (typeof gc !== "function") {
  console.error("wrapper-gc driver requires node --expose-gc");
  process.exit(2);
}

const DOC = "<html><body><p id='p'>x</p></body></html>";
type WR = { deref(): object | undefined };

const collect = async (): Promise<void> => {
  // Two passes + task turns: major GC clears weak refs; FinalizationRegistry
  // callbacks are posted as tasks.
  gc();
  await tick();
  gc();
  await tick();
};

const cases: readonly (readonly [string, string, string?])[] = [
  ["element wrapper collectible", `__wr = new WeakRef(document.createElement("div"))`],
  [
    "detached subtree releases with the root",
    `(() => {
       const h = document.createElement("div");
       h.innerHTML = "<span><b>deep</b></span>";
       __wr = new WeakRef(h);
       __w2 = new WeakRef(h.firstChild.firstChild);
     })()`,
    "__w2",
  ],
  ["style declaration collectible", `__wr = new WeakRef(document.createElement("div").style)`],
];

for (const [name, src, extra] of cases) {
  const out = await runScriptsOnSessionReal(new FineSession(DOC, "http://gc.local/"), [src]);
  assert.equal(out.error, null, `${name}: script errored`);
  const sandbox = out.sandbox;
  assert.ok(sandbox !== undefined, `${name}: no sandbox`);
  const wr = sandbox["__wr"] as WR;
  const w2 = extra !== undefined ? (sandbox[extra] as WR) : undefined;
  assert.ok(wr.deref() !== undefined, `${name}: dead before GC`);
  await collect();
  assert.equal(wr.deref(), undefined, `${name}: retained after GC (strong cache ref)`);
  if (w2 !== undefined) {
    assert.equal(w2.deref(), undefined, `${name}: inner wrapper retained after GC`);
  }
  console.log(`ok - ${name}`);
}
process.exit(0);
