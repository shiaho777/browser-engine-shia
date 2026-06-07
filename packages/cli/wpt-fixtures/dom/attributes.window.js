// META: title=testharness window-script format smoke test
"use strict";

test(function () {
  assert_array_equals([1, 2, 3].map(function (n) { return n * 2; }), [2, 4, 6]);
}, "sync test in a .window.js file");

async_test(function (t) {
  t.step(function () {
    assert_equals(typeof document, "object", "a document global is present");
  });
  t.done();
}, "async_test step + done in a .window.js file");

promise_test(function () {
  return Promise.resolve(7).then(function (v) {
    assert_equals(v, 7, "promise value flows to the assertion");
  });
}, "promise_test in a .window.js file");
