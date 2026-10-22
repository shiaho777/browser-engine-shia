import test from "node:test";
import assert from "node:assert/strict";

import { canonicalTrackList, resolveTrackList, trackListValid } from "./grid-tracks.js";

const empty = { breadth: 1, em: 1, items: 0, content: 0 };

void test("track lists reject negative sizes and accept a plain length", () => {
  assert.equal(trackListValid("-10px"), false);
  assert.equal(trackListValid("minmax(5fr, 10px)"), false);
  assert.equal(trackListValid("[one]"), false);
  assert.equal(trackListValid("repeat(auto-fill, auto)"), false);
  assert.equal(canonicalTrackList("subgrid"), "subgrid");
  assert.equal(canonicalTrackList("subgrid [a] repeat(auto-fill, [b]) [c]"), "subgrid [a] repeat(auto-fill, [b]) [c]");
  assert.equal(canonicalTrackList("subgrid [span]"), null);
  assert.equal(canonicalTrackList("subgrid repeat(auto-fit, [a])"), null);
  assert.equal(trackListValid("minmax(auto, 0)"), true);
  assert.equal(canonicalTrackList("0"), "0px");
  assert.equal(trackListValid("none"), true);
  assert.equal(trackListValid("10px"), true);
  assert.equal(trackListValid("calc(-0.5em + 10px)"), true);
  assert.equal(trackListValid("repeat(auto-fill, minmax(100px, 5fr))"), true);
});

void test("an empty grid resolves repeats, percentages, and merged line names", () => {
  assert.equal(resolveTrackList("1px repeat(1, 2px) 3px", empty), "1px 2px 3px");
  assert.equal(resolveTrackList("1px repeat(auto-fit, 2px) 3px", empty), "1px 0px 3px");
  assert.equal(resolveTrackList("1px [a] repeat(1, [b] 2px [c]) [d] 3px", empty), "1px [a b] 2px [c d] 3px");
  assert.equal(resolveTrackList("100% [a] repeat(1, [b] 200% [c]) [d] 300%", empty), "1px [a b] 2px [c d] 3px");
  assert.equal(
    resolveTrackList("5fr", { breadth: 300, em: 40, items: 1, content: 30 }),
    "300px",
  );
  assert.equal(
    resolveTrackList("20%", { breadth: 300, em: 40, items: 1, content: 30 }),
    "60px",
  );
  assert.equal(
    resolveTrackList("min-content", { breadth: 300, em: 40, items: 1, content: 30 }),
    "30px",
  );
  const columns = { breadth: 300, em: 40, items: 1, content: 30 };
  assert.equal(resolveTrackList("minmax(auto, 0)", columns), "30px");
  assert.equal(resolveTrackList("repeat(2, minmax(10px, auto))", columns), "160px 140px");
  assert.equal(
    resolveTrackList("repeat(2, fit-content(20%) [three four] 30px 40px [five six])", columns),
    "30px [three four] 30px 40px [five six] 0px [three four] 30px 40px [five six]",
  );
  assert.equal(
    resolveTrackList("min-content repeat(5, minmax(10px, auto))", columns),
    "30px 54px 54px 54px 54px 54px",
  );
  const rows = { breadth: 600, em: 40, items: 1, content: 60 };
  assert.equal(resolveTrackList("minmax(auto, 0)", rows), "60px");
  assert.equal(resolveTrackList("repeat(2, minmax(10px, auto))", rows), "325px 275px");
  assert.equal(
    resolveTrackList("repeat(auto-fit, [three] minmax(max-content, 6em) [four])", rows),
    "[three] 240px [four three] 0px [four]",
  );
});
