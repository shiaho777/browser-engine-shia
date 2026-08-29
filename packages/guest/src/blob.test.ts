import test from "node:test";
import assert from "node:assert/strict";

import { makeBlobClass, makeFileClass, globalObjectUrls } from "./blob.js";

void test("Blob exposes size/type, slice, arrayBuffer, text", async () => {
  const Blob = makeBlobClass();
  const blob = new Blob(["hello ", "world"], { type: "text/plain" });
  assert.equal(blob.size, 11);
  assert.equal(blob.type, "text/plain");
  assert.equal(await blob.text(), "hello world");
  const tail = blob.slice(6, 11, "text/plain");
  assert.equal(tail.size, 5);
  assert.equal(await tail.text(), "world");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes.byteLength, 11);
});

void test("File carries name and lastModified", () => {
  const File = makeFileClass();
  const f = new File(["abc"], "a.txt", { type: "text/plain" });
  assert.equal(f.name, "a.txt");
  assert.equal(f.size, 3);
  assert.ok(f.lastModified > 0);
});

void test("object URLs mint, resolve, and revoke through the registry", () => {
  const Blob = makeBlobClass();
  const blob = new Blob(["payload"], { type: "application/octet-stream" });
  const url = globalObjectUrls.createObjectURL(blob);
  assert.match(url, /^blob:/);
  assert.equal(globalObjectUrls.resolve(url), blob);
  globalObjectUrls.revokeObjectURL(url);
  assert.equal(globalObjectUrls.resolve(url), undefined);
});
