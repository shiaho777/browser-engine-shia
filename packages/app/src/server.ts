import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { pipelinePrimaryFontName } from "@browser-engine/cli";
import { coerceGuestString } from "@browser-engine/guest";

import { HOME_URL } from "./home.js";
import { normalizeViewport, type EngineViewport } from "./host-api.js";
import { SHELL_HTML } from "./shell.js";
import { TabHost, type TabSession } from "./tab-session.js";
import { loadPage, type PageFrame } from "./page.js";

export interface AppServerOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface NavigateSuccess {
  readonly ok: true;
  readonly pngBase64?: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly source: string;
  readonly title?: string;
  readonly url?: string;
  readonly viewport?: EngineViewport;
  readonly scriptsRun?: number;
  readonly mutations?: number;
  readonly scriptError?: string | null;
  readonly engine?: "fine";
  readonly frameRev?: number;
  readonly scriptsLoaded?: number;
  readonly scriptsFailed?: number;
  readonly moduleUrls?: number;
  readonly cookies?: number;
  readonly networkEvents?: number;
  readonly modulesEvaluated?: number;
  readonly modulesLinked?: number;
  readonly esmSupported?: boolean;
  readonly frameMode?: "base64" | "binary";
  readonly nav?: { canGoBack: boolean; canGoForward: boolean; url: string };
  readonly tabs?: ReturnType<TabHost["list"]>;
  readonly activeTabId?: number;
  readonly editable?: unknown;
  readonly navigated?: boolean;
}

export interface NavigateFailure {
  readonly ok: false;
  readonly error: string;
  readonly nav?: { canGoBack: boolean; canGoForward: boolean; url: string };
  readonly viewport?: EngineViewport;
  readonly tabs?: ReturnType<TabHost["list"]>;
  readonly activeTabId?: number;
}

export type NavigateResult = NavigateSuccess | NavigateFailure;

export interface AppServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sendPng(res: ServerResponse, bytes: Uint8Array, frameRev: number): void {
  res.writeHead(200, {
    "content-type": "image/png",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    "x-frame-rev": String(frameRev),
  });
  res.end(Buffer.from(bytes));
}

function navState(tab: TabSession): { canGoBack: boolean; canGoForward: boolean; url: string } {
  return {
    canGoBack: tab.canGoBack(),
    canGoForward: tab.canGoForward(),
    url: tab.url,
  };
}

function frameToResult(
  frame: PageFrame,
  host: TabHost,
  options: { binary?: boolean; navigated?: boolean; editable?: unknown } = {},
): NavigateSuccess {
  const tab = host.active;
  const binary = options.binary === true;
  return {
    ok: true,
    ...(binary ? {} : { pngBase64: frame.pngBase64 }),
    width: frame.width,
    height: frame.height,
    bytes: frame.bytes,
    durationMs: frame.durationMs,
    source: frame.url,
    title: frame.title,
    url: frame.url,
    viewport: tab.viewport,
    scriptsRun: frame.scriptsRun,
    mutations: frame.mutations,
    scriptError: frame.scriptError,
    engine: frame.engine,
    frameRev: frame.frameRev,
    scriptsLoaded: frame.scriptsLoaded,
    scriptsFailed: frame.scriptsFailed,
    moduleUrls: frame.moduleUrls,
    cookies: frame.cookies,
    networkEvents: frame.networkEvents,
    modulesEvaluated: frame.modulesEvaluated,
    modulesLinked: frame.modulesLinked,
    esmSupported: frame.esmSupported,
    frameMode: binary ? "binary" : "base64",
    nav: navState(tab),
    tabs: host.list(),
    activeTabId: host.activeId,
    ...(options.navigated !== undefined ? { navigated: options.navigated } : {}),
    ...(options.editable !== undefined ? { editable: options.editable } : {}),
  };
}

function readViewport(body: Record<string, unknown>): EngineViewport | Partial<EngineViewport> {
  const viewport: { width?: number; height?: number; devicePixelRatio?: number } = {};
  if (typeof body["width"] === "number") viewport.width = body["width"];
  if (typeof body["height"] === "number") viewport.height = body["height"];
  if (typeof body["devicePixelRatio"] === "number") viewport.devicePixelRatio = body["devicePixelRatio"];
  return viewport;
}

function wantsBinary(body: Record<string, unknown>): boolean {
  return body["frameMode"] === "binary" || body["binary"] === true;
}

export async function renderTarget(input: {
  target?: string;
  html?: string;
  title?: string;
  width?: number;
  height?: number;
}): Promise<NavigateResult> {
  try {
    const viewportInput: { width?: number; height?: number } = {};
    if (typeof input.width === "number") viewportInput.width = input.width;
    if (typeof input.height === "number") viewportInput.height = input.height;
    const viewport = normalizeViewport(viewportInput);
    if (typeof input.html === "string") {
      const host = new TabHost();
      const frame = await host.active.loadHtml(
        input.html,
        typeof input.title === "string" && input.title.trim() !== "" ? input.title : "upload.html",
        viewport,
      );
      return frameToResult(frame, host);
    }
    if (typeof input.target !== "string" || input.target.trim() === "") {
      return { ok: false, error: "missing target or html" };
    }
    const page = await loadPage(input.target, { viewport });
    return {
      ok: true,
      pngBase64: page.frame.pngBase64,
      width: page.frame.width,
      height: page.frame.height,
      bytes: page.frame.bytes,
      durationMs: page.frame.durationMs,
      source: page.frame.url,
      title: page.frame.title,
      url: page.frame.url,
      viewport: page.viewport,
      scriptsRun: page.frame.scriptsRun,
      mutations: page.frame.mutations,
      scriptError: page.frame.scriptError,
      engine: page.frame.engine,
      frameRev: page.frame.frameRev,
      frameMode: "base64",
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to bind app server"));
        return;
      }
      resolvePort(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startAppServer(options: AppServerOptions = {}): Promise<AppServer> {
  const host = options.host ?? "127.0.0.1";
  const preferredPort = options.port ?? 7788;
  const tabs = new TabHost();

  const create = (): Server =>
    createServer((req, res) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        sendHtml(res, SHELL_HTML);
        return;
      }
      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          engine: "browser-engine-shia",
          mode: "interactive",
          viewport: tabs.active.viewport,
          fonts: pipelinePrimaryFontName(),
          tabs: tabs.list(),
          activeTabId: tabs.activeId,
          features: ["binary-frame", "multi-tab", "text-input", "caret"],
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/frame") {
        const bytes = tabs.active.pngBytes;
        if (bytes === null) {
          sendJson(res, 404, { ok: false, error: "no frame" });
          return;
        }
        sendPng(res, bytes, tabs.active.frameRev);
        return;
      }
      if (method === "GET" && url.pathname === "/api/tabs") {
        sendJson(res, 200, {
          ok: true,
          tabs: tabs.list(),
          activeTabId: tabs.activeId,
        });
        return;
      }

      void (async () => {
        try {
          if (method === "POST" && url.pathname === "/api/tabs/new") {
            const list = tabs.create();
            const frame = await tabs.active.navigate(HOME_URL, { push: true });
            sendJson(res, 200, {
              ...frameToResult(frame, tabs, { binary: true }),
              tabs: list,
            });
            return;
          }
          if (method === "POST" && url.pathname === "/api/tabs/select") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const id = Number(body["id"]);
            if (!tabs.select(id)) {
              sendJson(res, 404, { ok: false, error: "tab not found" });
              return;
            }
            const frame = tabs.active.frame;
            if (frame === null) {
              const loaded = await tabs.active.navigate(HOME_URL, { push: true });
              sendJson(res, 200, frameToResult(loaded, tabs, { binary: wantsBinary(body) || true }));
              return;
            }
            sendJson(res, 200, frameToResult(frame, tabs, { binary: true }));
            return;
          }
          if (method === "POST" && url.pathname === "/api/tabs/close") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const id = Number(body["id"] ?? tabs.activeId);
            tabs.close(id);
            let frame = tabs.active.frame;
            if (frame === null) {
              frame = await tabs.active.navigate(HOME_URL, { push: true });
            }
            sendJson(res, 200, frameToResult(frame, tabs, { binary: true }));
            return;
          }
          if (method === "POST" && url.pathname === "/api/navigate") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const viewport = readViewport(body);
            const binary = wantsBinary(body);
            if (typeof body["html"] === "string") {
              const frame = await tabs.active.loadHtml(
                body["html"],
                typeof body["title"] === "string" ? body["title"] : "upload.html",
                viewport,
              );
              sendJson(res, 200, frameToResult(frame, tabs, { binary }));
              return;
            }
            const target = typeof body["target"] === "string" ? body["target"] : HOME_URL;
            const frame = await tabs.active.navigate(target, { viewport, push: true });
            sendJson(res, 200, frameToResult(frame, tabs, { binary }));
            return;
          }
          if (method === "POST" && url.pathname === "/api/scroll") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const dx = typeof body["deltaX"] === "number" ? body["deltaX"] : 0;
            const dy = typeof body["deltaY"] === "number" ? body["deltaY"] : 0;
            if (typeof body["width"] === "number" || typeof body["height"] === "number" || typeof body["devicePixelRatio"] === "number") {
              tabs.active.setViewport(readViewport(body));
            }
            const settle = body["settle"] === true;
            const frame = await tabs.active.scrollBy(dx, dy, { settle });
            if (frame === null) {
              sendJson(res, 200, {
                ok: true,
                frame: null,
                nav: navState(tabs.active),
                viewport: tabs.active.viewport,
                tabs: tabs.list(),
                activeTabId: tabs.activeId,
              });
              return;
            }
            sendJson(res, 200, frameToResult(frame, tabs, { binary: wantsBinary(body) || true }));
            return;
          }
          if (method === "POST" && url.pathname === "/api/viewport") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const frame = await tabs.active.applyViewport(readViewport(body));
            if (frame === null) {
              sendJson(res, 200, {
                ok: true,
                frame: null,
                nav: navState(tabs.active),
                viewport: tabs.active.viewport,
                tabs: tabs.list(),
                activeTabId: tabs.activeId,
              });
              return;
            }
            sendJson(res, 200, frameToResult(frame, tabs, { binary: wantsBinary(body) || true }));
            return;
          }
          if (method === "POST" && url.pathname === "/api/back") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const frame = await tabs.active.back(readViewport(body));
            if (frame === null) {
              sendJson(res, 200, {
                ok: true,
                frame: null,
                nav: navState(tabs.active),
                viewport: tabs.active.viewport,
                tabs: tabs.list(),
                activeTabId: tabs.activeId,
              });
              return;
            }
            sendJson(res, 200, frameToResult(frame, tabs, { binary: wantsBinary(body) || true }));
            return;
          }
          if (method === "POST" && url.pathname === "/api/forward") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const frame = await tabs.active.forward(readViewport(body));
            if (frame === null) {
              sendJson(res, 200, {
                ok: true,
                frame: null,
                nav: navState(tabs.active),
                viewport: tabs.active.viewport,
                tabs: tabs.list(),
                activeTabId: tabs.activeId,
              });
              return;
            }
            sendJson(res, 200, frameToResult(frame, tabs, { binary: wantsBinary(body) || true }));
            return;
          }
          if (method === "POST" && url.pathname === "/api/reload") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const frame = await tabs.active.reload(readViewport(body));
            if (frame === null) {
              sendJson(res, 200, {
                ok: true,
                frame: null,
                nav: navState(tabs.active),
                viewport: tabs.active.viewport,
                tabs: tabs.list(),
                activeTabId: tabs.activeId,
              });
              return;
            }
            sendJson(res, 200, frameToResult(frame, tabs, { binary: wantsBinary(body) || true }));
            return;
          }
          if (method === "POST" && url.pathname === "/api/hit-test") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const hit = tabs.active.hitTestAt(Number(body["x"] ?? 0), Number(body["y"] ?? 0));
            sendJson(res, 200, { ok: true, ...hit });
            return;
          }
          if (method === "POST" && url.pathname === "/api/click") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const result = await tabs.active.clickAt(
              Number(body["x"] ?? 0),
              Number(body["y"] ?? 0),
              readViewport(body),
            );
            sendJson(
              res,
              200,
              frameToResult(result.frame, tabs, {
                binary: wantsBinary(body) || true,
                navigated: result.navigated,
                editable: result.editable,
              }),
            );
            return;
          }
          if (method === "POST" && url.pathname === "/api/type") {
            const raw = await readBody(req);
            const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
            const nodeId = coerceGuestString(body["nodeId"]);
            const text = coerceGuestString(body["text"]);
            const typeOpts: {
              caret?: number;
              selStart?: number;
              selEnd?: number;
              preview?: boolean;
            } = {};
            if (typeof body["caret"] === "number") typeOpts.caret = body["caret"];
            if (typeof body["selStart"] === "number") typeOpts.selStart = body["selStart"];
            if (typeof body["selEnd"] === "number") typeOpts.selEnd = body["selEnd"];
            if (body["preview"] === true) typeOpts.preview = true;
            const frame = await tabs.active.commitText(nodeId, text, typeOpts);
            if (frame === null) {
              sendJson(res, 400, { ok: false, error: "no page" });
              return;
            }
            sendJson(res, 200, frameToResult(frame, tabs, { binary: true }));
            return;
          }
          sendJson(res, 404, { ok: false, error: `no route ${method} ${url.pathname}` });
        } catch (error: unknown) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            nav: navState(tabs.active),
            viewport: tabs.active.viewport,
            tabs: tabs.list(),
            activeTabId: tabs.activeId,
          });
        }
      })();
    });

  let server = create();
  let port: number;
  try {
    port = await listen(server, host, preferredPort);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EADDRINUSE") throw error;
    server.close();
    server = create();
    port = await listen(server, host, 0);
  }

  return {
    host,
    port,
    url: `http://${host}:${port}/`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((closeError) => {
          if (closeError) rejectClose(closeError);
          else resolveClose();
        });
      }),
  };
}
