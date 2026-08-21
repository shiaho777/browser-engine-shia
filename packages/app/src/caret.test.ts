import test from "node:test";
import assert from "node:assert/strict";

import { TabSession } from "./tab-session.js";

void test("focus paints a different frame than unfocused form", async () => {
  const tab = new TabSession();
  await tab.navigate("engine://form", { viewport: { width: 900, height: 700 } });
  const before = tab.frame!.bytes;
  const page = tab.page!;
  let x = 80;
  let y = 180;
  for (const fragment of page.fragmentTree.fragments.values()) {
    const node = page.dom.nodes.get(fragment.node);
    if (node?.kind === "element" && node.tag === "textarea") {
      const box = fragment.box.borderBox;
      x = Number(box.x) + 8;
      y = Number(box.y) + 8;
      break;
    }
  }
  const click = await tab.clickAt(x, y);
  assert.ok(click.editable);
  assert.ok(tab.focus !== null);
  assert.notEqual(tab.frame!.bytes, before);
  assert.ok(tab.frame!.frameRev > page.frameRev);

  const typed = await tab.commitText(click.editable.nodeId, "caret-demo 中文", {
    caret: 5,
    selStart: 0,
    selEnd: 5,
  });
  assert.ok(typed);
  assert.ok(tab.focus !== null);
  assert.equal(tab.focus.caret, 5);
  assert.equal(tab.focus.selStart, 0);
  assert.equal(tab.focus.selEnd, 5);
});
