import test from "node:test";
import assert from "node:assert/strict";

import { FineSession } from "./fine.js";
import { isEsmSupported, runModuleScripts } from "./esm-runner.js";

void test("ESM runner evaluates a simple module graph when SourceTextModule is available", async () => {
  if (!isEsmSupported()) {
    const result = await runModuleScripts(
      new FineSession("<html><body></body></html>", "https://example.test/"),
      [{ url: "https://example.test/a.js", source: "export const n = 1;" }],
    );
    assert.equal(result.supported, false);
    assert.match(result.errors[0] ?? "", /experimental-vm-modules/);
    return;
  }

  const sources = new Map<string, string>([
    [
      "https://example.test/entry.js",
      `import { value } from "./dep.js";
globalThis.__esmValue = value;
export const ok = true;`,
    ],
    ["https://example.test/dep.js", "export const value = 42;"],
  ]);

  const fetchFn = (url: string) => {
    const body = sources.get(url);
    return Promise.resolve(body === undefined ? undefined : new TextEncoder().encode(body));
  };

  const session = new FineSession("<html><body><div id='x'></div></body></html>", "https://example.test/");
  const result = await runModuleScripts(
    session,
    [{ url: "https://example.test/entry.js", source: sources.get("https://example.test/entry.js")! }],
    fetchFn,
  );
  assert.equal(result.supported, true);
  assert.equal(result.evaluated, 1);
  assert.ok(result.linked >= 2);
  assert.equal(result.failed, 0, result.errors.join(" | "));
});


void test("classic and ESM share the same window sandbox", async () => {
  if (!isEsmSupported()) return;

  const { runScriptsOnSessionReal } = await import("./event-loop.js");
  const session = new FineSession(
    "<html><body><div id='app'></div></body></html>",
    "https://example.test/",
  );
  const classic = await runScriptsOnSessionReal(session, [
    "window.__HOME_PAGE_PERFORMANCE__ = { fromClassic: true }; window.__sharedMarker = 7;",
  ]);
  assert.ok(classic.sandbox);
  assert.ok(classic.context);

  const result = await runModuleScripts(
    session,
    [
      {
        url: "https://example.test/entry.js",
        source: `
          if (!globalThis.__HOME_PAGE_PERFORMANCE__) throw new Error("missing home perf");
          globalThis.__HOME_PAGE_PERFORMANCE__.client_entry = 1;
          globalThis.__esmSawMarker = globalThis.__sharedMarker;
          export const ok = true;
        `,
      },
    ],
    () => Promise.resolve(undefined),
    { sandbox: classic.sandbox, context: classic.context },
  );
  assert.equal(result.failed, 0, result.errors.join(" | "));
  assert.equal(result.evaluated, 1);
  assert.equal(classic.sandbox?.["__esmSawMarker"], 7);
  assert.equal(
    (classic.sandbox?.["__HOME_PAGE_PERFORMANCE__"] as { client_entry?: number } | undefined)?.client_entry,
    1,
  );
});
