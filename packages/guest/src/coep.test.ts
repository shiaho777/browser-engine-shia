/**
 * RFC 0031 — COEP/COOP/CORP policy module + network-stack integration:
 * header parsing, CORP authorization, the COOP opener-severing table,
 * `credentialless` credential stripping, `require-corp` per-hop CORP
 * enforcement (including redirect hops), and `crossOriginIsolated`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  coepApplies,
  coopSeversOpenerLink,
  corpAllows,
  createBrowserNetworkStack,
  crossOriginIsolated,
  parseCoep,
  parseCoop,
  parseCorp,
} from "./index.js";

const PAGE = "https://page.example/app";

// ---------- unit: header parsing ----------

void test("parseCoep: require-corp/credentialless; unknown + absent → unsafe-none", () => {
  assert.equal(parseCoep("require-corp"), "require-corp");
  assert.equal(parseCoep(" credentialless "), "credentialless");
  assert.equal(parseCoep("REQUIRE-CORP"), "require-corp");
  assert.equal(parseCoep("bogus"), "unsafe-none");
  assert.equal(parseCoep(null), "unsafe-none");
  assert.equal(parseCoep(undefined), "unsafe-none");
});

void test("parseCoop: four values; unknown + absent → unsafe-none", () => {
  assert.equal(parseCoop("same-origin"), "same-origin");
  assert.equal(parseCoop("same-origin-allow-popups"), "same-origin-allow-popups");
  assert.equal(parseCoop("noopener-allow-popups"), "noopener-allow-popups");
  assert.equal(parseCoop("SAME-ORIGIN"), "same-origin");
  assert.equal(parseCoop("junk"), "unsafe-none");
  assert.equal(parseCoop(null), "unsafe-none");
});

void test("parseCorp: three values; absent/unknown → null", () => {
  assert.equal(parseCorp("same-origin"), "same-origin");
  assert.equal(parseCorp("same-site"), "same-site");
  assert.equal(parseCorp("cross-origin"), "cross-origin");
  assert.equal(parseCorp("nope"), null);
  assert.equal(parseCorp(null), null);
});

// ---------- unit: corpAllows ----------

void test("corpAllows: cross-origin allows all; same-site/site; same-origin/origin; absent=same-origin", () => {
  const req = "https://a.example/x";
  const cross = "https://b.example/r";
  const sameSite = "https://sub.a.example/r";
  assert.equal(corpAllows("cross-origin", req, cross), true);
  assert.equal(corpAllows("same-site", req, sameSite), true, "same site tail");
  assert.equal(corpAllows("same-site", req, cross), false);
  assert.equal(corpAllows("same-origin", req, sameSite), false, "subdomain ≠ origin");
  assert.equal(corpAllows("same-origin", req, req), true);
  assert.equal(corpAllows(null, req, cross), false, "absent CORP defaults to same-origin");
  assert.equal(corpAllows(null, req, req), true);
});

// ---------- unit: coepApplies ----------

void test("coepApplies: no-cors + iframe nav gated; cors/top nav exempt", () => {
  assert.equal(coepApplies("no-cors", "image"), true);
  assert.equal(coepApplies("navigate", "iframe"), true);
  assert.equal(coepApplies("cors", "empty"), false, "CORS authorizes itself");
  assert.equal(coepApplies("navigate", "document"), false, "top-level nav exempt");
  assert.equal(coepApplies("same-origin", "empty"), false);
});

// ---------- unit: coopSeversOpenerLink ----------

void test("coopSeversOpenerLink: the spec table across coop × sameOrigin × popup", () => {
  // unsafe-none never severs.
  assert.equal(coopSeversOpenerLink("unsafe-none", "same-origin", false, false), false);
  // same-origin: keeps only a same-origin openee that ALSO opts in.
  assert.equal(coopSeversOpenerLink("same-origin", "same-origin", true, false), false);
  assert.equal(coopSeversOpenerLink("same-origin", "unsafe-none", true, false), true,
    "openee didn't opt in — severed");
  assert.equal(coopSeversOpenerLink("same-origin", "same-origin", false, false), true,
    "cross-origin always severs");
  // same-origin-allow-popups: same-origin lenient openee, or any
  // cross-origin POPUP that stays coop-free.
  assert.equal(
    coopSeversOpenerLink("same-origin-allow-popups", "same-origin-allow-popups", true, false),
    false,
  );
  assert.equal(
    coopSeversOpenerLink("same-origin-allow-popups", "unsafe-none", true, false),
    false,
  );
  assert.equal(
    coopSeversOpenerLink("same-origin-allow-popups", "unsafe-none", false, true),
    false,
    "cross-origin popup w/o coop keeps the link",
  );
  assert.equal(
    coopSeversOpenerLink("same-origin-allow-popups", "unsafe-none", false, false),
    true,
    "cross-origin non-popup severs",
  );
  // noopener-allow-popups: only popups keep a handle (opener is still gone
  // on the opened side — modeled as link severed).
  assert.equal(coopSeversOpenerLink("noopener-allow-popups", "unsafe-none", false, true), false);
  assert.equal(coopSeversOpenerLink("noopener-allow-popups", "unsafe-none", true, false), true);
});

// ---------- unit: crossOriginIsolated ----------

void test("crossOriginIsolated: COOP same-origin ∧ COEP require-corp|credentialless", () => {
  assert.equal(crossOriginIsolated("require-corp", "same-origin"), true);
  assert.equal(crossOriginIsolated("credentialless", "same-origin"), true);
  assert.equal(crossOriginIsolated("require-corp", "unsafe-none"), false);
  assert.equal(crossOriginIsolated("unsafe-none", "same-origin"), false);
  assert.equal(crossOriginIsolated("require-corp", "same-origin-allow-popups"), false,
    "allow-popups is not isolating (spec)");
});

// ---------- stack integration (stubbed transport) ----------

interface CapturedReq {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

type Responder = (req: CapturedReq) => {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

async function withStubbedFetch<T>(
  responders: ReadonlyMap<string, Responder>,
  run: () => Promise<T>,
): Promise<{ result: T; requests: CapturedReq[] }> {
  const requests: CapturedReq[] = [];
  const orig = globalThis.fetch;
  const origEnv = process.env["BROWSER_ENGINE_USE_CURL"];
  process.env["BROWSER_ENGINE_USE_CURL"] = "0";
  globalThis.fetch = ((input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = typeof input === "string" ? input : (input as URL).href;
    const captured: CapturedReq = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: { ...(init?.headers ?? {}) },
    };
    requests.push(captured);
    const responder = responders.get(url);
    if (responder === undefined) return Promise.resolve(new Response("nf", { status: 404 }));
    const r = responder(captured);
    return Promise.resolve(
      new Response(r.body ?? "", {
        status: r.status,
        ...(r.headers !== undefined ? { headers: r.headers } : {}),
      }),
    );
  }) as typeof fetch;
  try {
    return { result: await run(), requests };
  } finally {
    globalThis.fetch = orig;
    if (origEnv === undefined) delete process.env["BROWSER_ENGINE_USE_CURL"];
    else process.env["BROWSER_ENGINE_USE_CURL"] = origEnv;
  }
}

void test("require-corp: cross-origin no-cors fetch needs an allowing CORP", async () => {
  await withStubbedFetch(
    new Map<string, Responder>([
      ["https://cdn.example/ok.png", () => ({ status: 200, headers: { "cross-origin-resource-policy": "cross-origin" }, body: "ok" })],
      ["https://cdn.example/bare.png", () => ({ status: 200, body: "bare" })],
    ]),
    async () => {
      const s = createBrowserNetworkStack({ baseUrl: PAGE });
      const ok = await s.request({
        url: "https://cdn.example/ok.png",
        initiator: PAGE,
        destination: "image",
        mode: "no-cors",
        initiatorCoep: "require-corp",
      });
      assert.equal(new TextDecoder().decode(ok.body), "ok");
      await assert.rejects(
        s.request({
          url: "https://cdn.example/bare.png",
          initiator: PAGE,
          destination: "image",
          mode: "no-cors",
          initiatorCoep: "require-corp",
        }),
        /coep/i,
      );
    },
  );
});

void test("require-corp: same-origin subresources are exempt", async () => {
  const { result } = await withStubbedFetch(
    new Map([["https://page.example/self.png", () => ({ status: 200, body: "s" })]]),
    () =>
      createBrowserNetworkStack({ baseUrl: PAGE }).request({
        url: "https://page.example/self.png",
        initiator: PAGE,
        destination: "image",
        mode: "no-cors",
        initiatorCoep: "require-corp",
      }),
  );
  assert.equal(new TextDecoder().decode(result.body), "s");
});

void test("require-corp: CORP enforced per redirect hop (first hop clean, second bare → reject)", async () => {
  const { requests } = await withStubbedFetch(
    new Map<string, Responder>([
      [
        "https://cdn.example/go.png",
        () => ({
          status: 302,
          headers: {
            location: "https://other.example/final.png",
            "cross-origin-resource-policy": "cross-origin",
          },
        }),
      ],
      ["https://other.example/final.png", () => ({ status: 200, body: "x" })],
    ]),
    async () => {
      const s = createBrowserNetworkStack({ baseUrl: PAGE });
      await assert.rejects(
        s.request({
          url: "https://cdn.example/go.png",
          initiator: PAGE,
          destination: "image",
          mode: "no-cors",
          initiatorCoep: "require-corp",
        }),
        /coep/i,
      );
    },
  );
  assert.equal(requests.length, 2, "the CORP-less second hop was reached then rejected");
});

void test("credentialless: cross-origin gated request goes out anonymous", async () => {
  const jarPage = "https://page.example/";
  const { requests, result } = await withStubbedFetch(
    new Map<string, Responder>([
      [jarPage, () => ({ status: 200, headers: { "set-cookie": "sid=abc; Path=/; SameSite=Lax" } })],
      [
        "https://cdn.example/res.png",
        () => ({ status: 200, headers: { "set-cookie": "cd=1; Path=/; SameSite=None; Secure" }, body: "r" }),
      ],
    ]),
    async () => {
      const s = createBrowserNetworkStack({ baseUrl: PAGE });
      // Plant a cookie for the CDN origin via a normal credentialed hit.
      await s.request({ url: "https://cdn.example/res.png", initiator: PAGE, destination: "image", mode: "no-cors" });
      // Now the SAME url under credentialless must NOT send it back.
      return s.request({
        url: "https://cdn.example/res.png",
        initiator: PAGE,
        destination: "image",
        mode: "no-cors",
        credentials: "include",
        initiatorCoep: "credentialless",
        headers: { authorization: "Bearer T", cookie: "override=1" },
      });
    },
  );
  const gated = requests[1];
  assert.equal(gated?.headers["cookie"], undefined, "jar cookie suppressed");
  assert.equal(gated?.headers["authorization"], undefined, "caller Authorization stripped");
  assert.equal(new TextDecoder().decode(result.body), "r");
});

void test("credentialless: same-origin gated request keeps jar credentials", async () => {
  const { requests } = await withStubbedFetch(
    new Map<string, Responder>([
      // First request plants a same-origin cookie in the jar.
      [
        "https://page.example/seed",
        () => ({ status: 200, headers: { "set-cookie": "sid=abc; Path=/; SameSite=Lax" } }),
      ],
      ["https://page.example/img.png", () => ({ status: 200, body: "i" })],
    ]),
    async () => {
      const s = createBrowserNetworkStack({ baseUrl: PAGE });
      await s.request({
        url: "https://page.example/seed",
        initiator: PAGE,
        destination: "image",
        mode: "no-cors",
      });
      return s.request({
        url: "https://page.example/img.png",
        initiator: PAGE,
        destination: "image",
        mode: "no-cors",
        credentials: "include",
        initiatorCoep: "credentialless",
      });
    },
  );
  // `cookie` is a forbidden header callers can't set, but the JAR attaches
  // it — credentialless only anonymizes CROSS-ORIGIN hops.
  assert.equal(
    requests[1]?.headers["cookie"],
    "sid=abc",
    "same-origin hops stay credentialed",
  );
});

void test("require-corp iframe nav: child needs CORP AND its own non-unsafe COEP", async () => {
  await withStubbedFetch(
    new Map<string, Responder>([
      // CORP ok but no COEP → still rejected under a require-corp embedder.
      [
        "https://frame.example/nocoep",
        () => ({ status: 200, headers: { "cross-origin-resource-policy": "cross-origin" }, body: "f" }),
      ],
      [
        "https://frame.example/good",
        () => ({
          status: 200,
          headers: {
            "cross-origin-resource-policy": "cross-origin",
            "cross-origin-embedder-policy": "require-corp",
          },
          body: "f2",
        }),
      ],
    ]),
    async () => {
      const s = createBrowserNetworkStack({ baseUrl: PAGE });
      await assert.rejects(
        s.request({
          url: "https://frame.example/nocoep",
          initiator: PAGE,
          destination: "iframe",
          mode: "navigate",
          initiatorCoep: "require-corp",
        }),
        /embedder-policy/i,
      );
      const ok = await s.request({
        url: "https://frame.example/good",
        initiator: PAGE,
        destination: "iframe",
        mode: "navigate",
        initiatorCoep: "require-corp",
      });
      assert.equal(ok.status, 200);
    },
  );
});

void test("unsafe-none initiator: CORP never enforced (regression)", async () => {
  const { result } = await withStubbedFetch(
    new Map([["https://cdn.example/x.png", () => ({ status: 200, body: "p" })]]),
    () =>
      createBrowserNetworkStack({ baseUrl: PAGE }).request({
        url: "https://cdn.example/x.png",
        initiator: PAGE,
        destination: "image",
        mode: "no-cors",
      }),
  );
  assert.equal(new TextDecoder().decode(result.body), "p");
});
