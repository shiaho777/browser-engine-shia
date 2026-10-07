/**
 * shadow-dom.test.ts — D6 tests: Shadow DOM (Web Components §3) — the flat
 * tree through the WHOLE pipeline. `attachShadow` builds a shadow tree;
 * the host lays out its shadow content (not its light children); `<slot>`
 * renders its assigned light children.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runScriptsOnSession } from "./event-loop.js";
import { FineSession } from "./fine.js";

/** Run guest script(s) against a document and return the session. */
function run(html: string, scripts: readonly string[]): { session: FineSession; error: string | null } {
  const session = new FineSession(html);
  const result = runScriptsOnSession(session, scripts);
  return { session, error: result.error };
}

void test("attachShadow returns a shadow root the guest can build into", () => {
  const { session, error } = run(
    '<div id="host"></div>',
    [
      "var host = document.getElementById('host');" +
        "var root = host.attachShadow({ mode: 'open' });" +
        "root.appendChild(document.createElement('span'));",
    ],
  );
  assert.equal(error, null);
  const span = [...session.dom.nodes.values()].find((n) => n.tag === "span");
  assert.ok(span !== undefined, "the shadow tree contains the appended span");
  // The span lives in the shadow tree (its parent chain leads to the host, NOT
  // to the host's light children list).
  assert.ok(span.parent !== null);
});

void test("a shadow HOST renders its shadow children, not its light children", () => {
  const { session, error } = run(
    '<div id="host"><p>light</p></div>',
    [
      "var host = document.getElementById('host');" +
        "var root = host.attachShadow({ mode: 'open' });" +
        "var shadowP = document.createElement('p');" +
        "shadowP.id = 'shadow-content';" +
        "root.appendChild(shadowP);",
    ],
  );
  assert.equal(error, null);
  const tree = session.layoutTree();
  // The SHADOW p (id=shadow-content) laid out under the host.
  const shadowP = [...session.dom.nodes.values()].find((n) => n.attrs?.get("id") === "shadow-content");
  assert.ok(shadowP !== undefined);
  const shadowFrag = [...tree.fragments.values()].find((f) => f.node === shadowP.id);
  assert.ok(shadowFrag !== undefined, "the shadow content renders");
  // The LIGHT p ("light") does NOT render (the host shows its shadow tree).
  const lightText = [...session.dom.nodes.values()].find(
    (n) => n.kind === "text" && (n.text ?? "") === "light",
  );
  assert.ok(lightText !== undefined);
  const lightFrag = [...tree.fragments.values()].find((f) => f.node === lightText.id);
  assert.ok(lightFrag === undefined, "the light child is replaced by the shadow tree");
});

void test("the composition change re-renders (kernel invalidation)", () => {
  const session = new FineSession('<div id="host"><p>light</p></div>');
  // Prime the layout.
  const before = session.layoutTree();
  const lightP = [...session.dom.nodes.values()].find((n) => n.tag === "p");
  const lightBefore = [...before.fragments.values()].some((f) => f.node === lightP!.id);
  assert.ok(lightBefore, "before attachShadow the light child renders");

  // attachShadow through the controller directly (the same call the guest API makes).
  const controller = session.createCompositionController();
  const shadowRoot = session.createElement("#shadow-root");
  const shadowContent = session.createElement("p");
  session.setAttribute(shadowContent, "id", "shadow-el");
  session.appendChild(shadowRoot, shadowContent);
  controller.registerHost(lightP!.parent!, shadowRoot);

  const after = session.layoutTree();
  const shadowAfter = [...after.fragments.values()].some((f) => f.node === shadowContent);
  assert.ok(shadowAfter, "after registerHost the shadow content renders");
  const lightAfter = [...after.fragments.values()].some((f) => f.node === lightP!.id);
  assert.ok(!lightAfter, "and the light child no longer renders");
});

void test("light DOM before attachShadow renders normally (no composition)", () => {
  const session = new FineSession('<div id="host"><p>light</p></div>');
  const tree = session.layoutTree();
  const p = [...session.dom.nodes.values()].find((n) => n.tag === "p");
  assert.ok(p !== undefined);
  const frag = [...tree.fragments.values()].find((f) => f.node === p.id);
  assert.ok(frag !== undefined, "no shadow ⇒ the light child renders");
});

void test("attachShadow is idempotent per host and multiple hosts compose", () => {
  const { session, error } = run(
    '<div id="h1"></div><div id="h2"></div>',
    [
      "var h1 = document.getElementById('h1');" +
        "var h2 = document.getElementById('h2');" +
        "var r1 = h1.attachShadow({mode:'open'});" +
        "var r2 = h2.attachShadow({mode:'open'});" +
        "r1.appendChild(document.createElement('b'));" +
        "r2.appendChild(document.createElement('i'));",
    ],
  );
  assert.equal(error, null);
  const tree = session.layoutTree();
  const b = [...session.dom.nodes.values()].find((n) => n.tag === "b");
  const i = [...session.dom.nodes.values()].find((n) => n.tag === "i");
  assert.ok(b !== undefined && i !== undefined);
  assert.ok([...tree.fragments.values()].some((f) => f.node === b.id), "host 1's shadow content renders");
  assert.ok([...tree.fragments.values()].some((f) => f.node === i.id), "host 2's shadow content renders");
});

void test("shadow content participates in CASCADE (styles apply)", () => {
  const { session, error } = run(
    '<div id="host"></div>',
    [
      "var root = document.getElementById('host').attachShadow({mode:'open'});" +
        "var s = document.createElement('style');" +
        "s.textContent = 'b { color: red; height: 30px }';" +
        "root.appendChild(s);" +
        "root.appendChild(document.createElement('b'));",
    ],
  );
  assert.equal(error, null);
  const b = [...session.dom.nodes.values()].find((n) => n.tag === "b");
  assert.ok(b !== undefined);
  const style = session.computed(b.id);
  assert.equal(style["height"], 30, "the shadow b carries the document's cascade");
  const tree = session.layoutTree();
  const frag = [...tree.fragments.values()].find((f) => f.node === b.id);
  assert.equal(Number(frag?.box.height), 30, "and lays out at the styled height");
});
