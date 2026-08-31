import test from "node:test";
import assert from "node:assert/strict";

import { nodeFetchNetworkStack } from "./network.js";

type HeaderBag = Record<string, string>;

async function captureRequest(req: {
  url: string;
  destination?: string;
  mode?: string;
  headers?: HeaderBag;
}): Promise<{ url: string | undefined; headers: HeaderBag }> {
  let captured: { url: string | undefined; headers: HeaderBag } = { url: undefined, headers: {} };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: { headers?: HeaderBag }) => {
    captured = { url: input, headers: { ...(init?.headers ?? {}) } };
    return new Response("<html></html>", { status: 200 });
  }) as typeof fetch;
  try {
    await nodeFetchNetworkStack.request(req);
    return captured;
  } finally {
    globalThis.fetch = origFetch;
  }
}

void test("raw stack requests carry UA, Accept, and Fetch Metadata defaults", async () => {
  const { headers } = await captureRequest({ url: "https://example.test/x" });
  assert.match(headers["user-agent"] ?? "", /Chrome/);
  assert.ok(headers["sec-ch-ua"] !== undefined, "UA-CH hint present");
  assert.equal(headers["sec-fetch-dest"], "empty");
  assert.equal(headers["sec-fetch-mode"], "cors");
  assert.ok(headers["sec-fetch-site"] !== undefined);
  assert.ok((headers["accept"] ?? "").length > 0);
});

void test("navigations get sec-fetch-dest document + sec-fetch-user ?1", async () => {
  const { headers } = await captureRequest({
    url: "https://example.test/",
    destination: "document",
    mode: "navigate",
  });
  assert.equal(headers["sec-fetch-dest"], "document");
  assert.equal(headers["sec-fetch-mode"], "navigate");
  assert.equal(headers["sec-fetch-user"], "?1");
  assert.equal(headers["upgrade-insecure-requests"], "1");
});

void test("explicit request headers win over defaults", async () => {
  const { headers } = await captureRequest({
    url: "https://example.test/x",
    headers: { "x-requested-with": "fetch" },
  });
  assert.equal(headers["x-requested-with"], "fetch");
  assert.ok(headers["user-agent"] !== undefined, "defaults still present");
});
