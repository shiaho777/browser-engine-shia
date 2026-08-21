import test from "node:test";
import assert from "node:assert/strict";

import { CookieJar } from "./cookie-jar.js";
import { createBrowserNetworkStack, networkStackToFetchFn } from "./network.js";

void test("CookieJar stores Set-Cookie and returns Cookie header for matching host", () => {
  const jar = new CookieJar();
  jar.storeFromSetCookie("https://www.bilibili.com/", [
    "SESSDATA=abc; Path=/; Domain=.bilibili.com; Secure",
    "bili_jct=xyz; Path=/",
  ]);
  assert.ok(jar.size >= 2);
  const header = jar.cookieHeader("https://www.bilibili.com/index.html");
  assert.match(header, /SESSDATA=abc/);
  assert.match(header, /bili_jct=xyz/);
  const other = jar.cookieHeader("https://example.com/");
  assert.equal(other.includes("SESSDATA"), false);
});

void test("browser stack records events and can fetch example.com", async () => {
  const stack = createBrowserNetworkStack({ timeoutMs: 12_000 });
  const res = await stack.request({ url: "https://example.com/" });
  assert.equal(res.ok, true);
  assert.ok(res.body.byteLength > 100);
  assert.ok(stack.events.length >= 1);
  const fetchFn = networkStackToFetchFn(stack);
  const again = await fetchFn("https://example.com/");
  assert.ok(again && again.byteLength > 100);
});
