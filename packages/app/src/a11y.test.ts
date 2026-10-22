/**
 * RFC 0037 — accessibility tree: built from the same DOM+style+layout+focus
 * inputs as paint, pruned by display/visibility/hidden/aria-hidden, roles per
 * ARIA-in-HTML (with `role=` override), names per the accName order
 * (labelledby → label → element semantics → name-from-content subtree).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { axDump, axSnapshot, type AXNode } from "./a11y.js";
import { loadPage, repaintPage } from "./page.js";

const VIEWPORT = { width: 800, height: 600, devicePixelRatio: 1 };

function find(root: AXNode | null | undefined, role: string, name?: string): AXNode | undefined {
  if (root === null || root === undefined) return undefined;
  if (root.role === role && (name === undefined || root.name === name)) return root;
  for (const c of root.children) {
    const hit = find(c, role, name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function roles(root: AXNode | null | undefined): string[] {
  if (root === null || root === undefined) return [];
  return [root.role, ...root.children.flatMap(roles)];
}

function statesOfNode(n: AXNode | undefined): readonly string[] {
  return n?.states ?? [];
}

void test("implicit roles: landmarks, links, headings, lists, controls", async () => {
  const page = await loadPage(`<!doctype html><title>T</title>
    <nav><a href="/x">go</a></nav>
    <main><h2>Head</h2><ul><li>item</li></ul>
    <button>Press</button><input type="checkbox"><hr></main>`,
    { viewport: VIEWPORT, runScripts: false });
  const rs = roles(page?.axTree);
  for (const want of ["document", "navigation", "link", "main", "heading", "list", "listitem", "button", "checkbox", "separator"]) {
    assert.ok(rs.includes(want), `missing role ${want} in ${rs.join(",")}`);
  }
  const h = find(page?.axTree, "heading");
  assert.equal(h?.name, "Head");
  assert.ok(h?.states.includes("level:2"));
  const link = find(page?.axTree, "link");
  assert.equal(link?.name, "go");
  assert.ok(link?.states.includes("linked"));
});

void test("accName order: aria-labelledby > aria-label > alt/label > subtree", async () => {
  const page = await loadPage(`<!doctype html><title>T</title><body>
    <img id="i1" src="x" alt="alt text" aria-label="aria wins">
    <img id="i2" src="x" alt="fallback alt">
    <span id="lbl">via labelledby</span><button aria-labelledby="lbl">x</button>
    <label for="em">Email</label><input id="em" type="email">
    <a href="/y">subtree name</a>
  </body>`, { viewport: VIEWPORT, runScripts: false });
  assert.equal(find(page?.axTree, "img", "aria wins")?.name, "aria wins");
  assert.equal(find(page?.axTree, "img", "fallback alt")?.name, "fallback alt");
  assert.equal(find(page?.axTree, "button", "via labelledby")?.name, "via labelledby");
  assert.equal(find(page?.axTree, "textbox", "Email")?.name, "Email");
  assert.equal(find(page?.axTree, "link", "subtree name")?.name, "subtree name");
});

void test("hidden content is pruned: display:none, hidden attr, aria-hidden, head machinery", async () => {
  const page = await loadPage(`<!doctype html><head><style>*{}</style><title>T</title></head><body>
    <p>visible</p>
    <p style="display:none">gone a</p>
    <p hidden>gone b</p>
    <p aria-hidden="true">gone c</p>
    <div style="display:none"><button>gone d</button></div>
  </body>`, { viewport: VIEWPORT, runScripts: false });
  const dump = axDump(page?.axTree ?? null);
  assert.ok(dump.includes('"visible"'), dump);
  for (const gone of ["gone a", "gone b", "gone c", "gone d"]) {
    assert.ok(!dump.includes(gone), `${gone} leaked into AX tree:\n${dump}`);
  }
});

void test("states: checked/disabled/required/expanded/pressed/current", async () => {
  const page = await loadPage(`<!doctype html><title>T</title><body>
    <input type="checkbox" checked>
    <input type="text" required disabled>
    <details open><summary>d</summary></details>
    <button aria-pressed="true">b</button>
    <a href="#c" aria-current="page">c</a>
  </body>`, { viewport: VIEWPORT, runScripts: false });
  assert.ok(statesOfNode(find(page?.axTree, "checkbox")).includes("checked"));
  const tb = find(page?.axTree, "textbox");
  assert.ok(statesOfNode(tb).includes("required") && statesOfNode(tb).includes("disabled"));
  const det = find(page?.axTree, "group");
  assert.ok(statesOfNode(det).includes("expanded"), `details states: ${statesOfNode(det).join(",")}`);
  assert.ok(statesOfNode(find(page?.axTree, "button", "b")).includes("pressed"));
  assert.ok(statesOfNode(find(page?.axTree, "link")).includes("current"));
});

void test("AX nodes carry fragment geometry in absolute page coords", async () => {
  const page = await loadPage(`<!doctype html><title>T</title>
    <body><main><h1>H</h1><p>line</p></main></body>`,
    { viewport: VIEWPORT, runScripts: false });
  const main = find(page?.axTree, "main");
  assert.ok(main !== undefined, "main landmark should exist");
  const geo = main.geometry;
  assert.ok(geo !== null);
  // UA body margin applies (8px) — assert geometry exists + plausible bounds.
  assert.ok(geo.x >= 0 && geo.x < 24, `x=${geo.x}`);
  assert.ok(geo.y >= 0 && geo.y < 48, `y=${geo.y}`);
  assert.ok(geo.width > 700, `width=${geo.width}`);
  const h = find(page?.axTree, "heading");
  assert.ok((h?.geometry?.height ?? 0) > 8);
});

void test("AX tree rebuilds on repaint — DOM mutation flows to AT", async () => {
  const page = await loadPage(`<!doctype html><title>T</title><body><button>A</button></body>
    <script>window.__mutate = () => {
      const b = document.createElement('button'); b.textContent='New';
      document.body.appendChild(b); return true;
    };</script>`,
    { viewport: VIEWPORT, runScripts: true, keepAlive: true });
  assert.ok(page !== null);
  try {
    const win = page.runtime?.globals as Record<string, unknown> | null;
    const mutate = win?.["__mutate"] as (() => boolean) | undefined;
    assert.ok(mutate !== undefined, "keepAlive runtime must expose the guest hook");
    assert.equal(mutate(), true);
    const next = await repaintPage(page, page.viewport, page.focus, page.scrollY);
    assert.ok(find(next.axTree, "button", "New") !== undefined, axDump(next.axTree ?? null));
  } finally {
    page.runtime?.disposeWorkers?.();
  }
});

void test("axSnapshot serializes to a plain JSON-shaped structure", async () => {
  const page = await loadPage(`<!doctype html><title>T</title><body><h3>x</h3></body>`,
    { viewport: VIEWPORT, runScripts: false });
  const snap = axSnapshot(page?.axTree ?? null) as { role: string; children: unknown[] };
  assert.equal(snap.role, "document");
  assert.ok(JSON.parse(JSON.stringify(snap)) !== null); // JSON-safe
});

void test("role= override beats implicit; unknown role falls through to implicit", async () => {
  const page = await loadPage(`<!doctype html><title>T</title><body>
    <div role="button" tabindex="0">div button</div>
    <span role="notarealrole"><a href="/z">z</a></span>
  </body>`, { viewport: VIEWPORT, runScripts: false });
  assert.ok(find(page?.axTree, "button", "div button") !== undefined);
  assert.ok(find(page?.axTree, "link", "z") !== undefined); // bogus role ignored, a→link stands
});
