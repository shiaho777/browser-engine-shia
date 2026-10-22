/**
 * webcontent-worker.ts — the web-content process entry (RFC 0004).
 *
 * One worker per tab: hosts a `TabSession` (the whole content pipeline —
 * fetch → parse → cascade → layout → paint → raster — plus the guest
 * FineSession, page state, and session history) behind the generated IPC
 * protocol. Requests are serialized through a promise queue: a renderer
 * handles one op at a time, in order.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { pipelinePrimaryFontName } from "@browser-engine/cli";
import {
  servePort,
  type AppReply,
  type AppRequest,
  type Frame,
  type NavState,
  type PortLike,
} from "@browser-engine/ipc";

import type { PageFrame, PageState } from "./page.js";
import { TabSession } from "./tab-session.js";
import { LocalStorageRegistry } from "./session.js";
import { normalizeViewport, type EngineViewport } from "./host-api.js";

function wireFrame(page: PageState, frame: PageFrame): Frame {
  return {
    url: frame.url,
    title: frame.title,
    width: frame.width,
    height: frame.height,
    png: page.pngBytes,
    durationMs: frame.durationMs,
    frameRev: frame.frameRev,
    scriptsRun: frame.scriptsRun,
    mutations: frame.mutations,
    scriptError: frame.scriptError,
    scriptsLoaded: frame.scriptsLoaded,
    scriptsFailed: frame.scriptsFailed,
    moduleUrls: frame.moduleUrls,
    cookies: frame.cookies,
    networkEvents: frame.networkEvents,
    modulesEvaluated: frame.modulesEvaluated,
    modulesLinked: frame.modulesLinked,
    esmSupported: frame.esmSupported,
    scrollY: page.scrollY,
    contentHeight: page.contentHeight,
  };
}

function navOf(tab: TabSession): NavState {
  return {
    canGoBack: tab.canGoBack(),
    canGoForward: tab.canGoForward(),
    url: tab.url,
    title: tab.title,
    hasPage: tab.page !== null,
    // `_blank` requests drain through nav state — the shell opens real tabs.
    pendingNewTabs: tab.takeNewTabRequests(),
    // Download completions ride the same drain for chrome notification.
    pendingDownloads: tab.takeDownloadEvents(),
    // `window.close()` on a script-opened tab — the shell closes it.
    closeRequested: tab.takeCloseRequested(),
    // Cross-tab postMessages the shell routes to their target tab's renderer.
    pendingPostMessages: tab.takePostMessages(),
    // `window.focus()` targets — the shell activates the referenced tab.
    focusRequests: tab.takeFocusRequests(),
    // RFC 0031: the committed document's isolation state for chrome surfaces.
    coep: tab.page?.coep ?? "unsafe-none",
    coop: tab.page?.coop ?? "unsafe-none",
    crossOriginIsolated: tab.page?.crossOriginIsolated ?? false,
    originAgentCluster: tab.page?.originAgentCluster ?? false,
  };
}

function viewportOrNull(v: { width: number; height: number; devicePixelRatio: number } | null): EngineViewport | undefined {
  if (v === null) return undefined;
  return normalizeViewport({ width: v.width, height: v.height, devicePixelRatio: v.devicePixelRatio });
}

async function dispatch(tab: TabSession, msg: AppRequest): Promise<AppReply> {
  const frameReply = (page: PageState | null): AppReply => ({
    kind: "frameReply",
    frame: page === null ? null : wireFrame(page, page.frame),
    nav: navOf(tab),
  });

  switch (msg.kind) {
    case "load": {
      await tab.navigate(msg.url, {
        viewport: normalizeViewport(msg.viewport, tab.viewport),
        push: msg.push,
        ...(msg.keepAlive ? { keepAlive: true } : {}),
        ...(msg.referrerPolicy !== null ? { referrerPolicy: msg.referrerPolicy } : {}),
      });
      return frameReply(tab.page);
    }
    case "loadHtml": {
      await tab.loadHtml(msg.html, msg.title, normalizeViewport(msg.viewport, tab.viewport));
      return frameReply(tab.page);
    }
    case "back": {
      const vp = viewportOrNull(msg.viewport);
      await tab.back(vp ?? undefined);
      return frameReply(tab.page);
    }
    case "forward": {
      const vp = viewportOrNull(msg.viewport);
      await tab.forward(vp ?? undefined);
      return frameReply(tab.page);
    }
    case "reload": {
      const vp = viewportOrNull(msg.viewport);
      await tab.reload(vp ?? undefined);
      return frameReply(tab.page);
    }
    case "setViewport": {
      await tab.applyViewport(normalizeViewport(msg.viewport, tab.viewport));
      return frameReply(tab.page);
    }
    case "scroll": {
      const vp = viewportOrNull(msg.viewport);
      if (vp !== undefined) tab.setViewport(vp);
      await tab.scrollBy(msg.dx, msg.dy, { settle: msg.settle });
      return frameReply(tab.page);
    }
    case "hitTest": {
      return { kind: "hitInfoReply", hit: tab.hitTestAt(msg.x, msg.y) };
    }
    case "clickAt": {
      const vp = viewportOrNull(msg.viewport);
      const result = await tab.clickAt(msg.x, msg.y, vp ?? undefined);
      return {
        kind: "clickReply",
        hit: result.hit,
        navigated: result.navigated,
        frame: tab.page === null ? null : wireFrame(tab.page, result.frame),
        editable: result.editable,
        nav: navOf(tab),
      };
    }
    case "commitText": {
      await tab.commitText(msg.nodeId, msg.text, {
        caret: msg.caret,
        selStart: msg.selStart,
        selEnd: msg.selEnd,
        preview: msg.preview,
      });
      return frameReply(tab.page);
    }
    case "pump": {
      const result = await tab.pump(msg.count, {
        settleMs: msg.settleMs,
        idleStop: msg.idleStop,
      });
      return {
        kind: "pumpReply",
        frames: result.frames,
        mutations: result.mutations,
        frameRev: result.frameRev,
        frame: tab.page === null ? null : wireFrame(tab.page, tab.page.frame),
        nav: navOf(tab),
      };
    }
    case "getFrame": {
      return {
        kind: "frameBytesReply",
        png: tab.pngBytes,
        frameRev: tab.frameRev,
      };
    }
    case "getNav": {
      return { kind: "navStateReply", nav: navOf(tab) };
    }
    case "exportSessionStorage": {
      return {
        kind: "sessionStorageReply",
        areas: tab.exportSessionStorage().areas.map((a) => ({
          origin: a.origin,
          keys: [...a.keys],
          values: [...a.values],
        })),
      };
    }
    case "importSessionStorage": {
      tab.importSessionStorage({ areas: msg.areas });
      return { kind: "statusReply", ok: true, fonts: "" };
    }
    case "exportHistory": {
      const snap = tab.exportSessionHistory();
      return {
        kind: "historyReply",
        snapshot: {
          index: snap.index,
          entries: snap.entries.map((e) => ({
            url: e.url,
            title: e.title,
            scrollY: e.scrollY,
            stateJson: e.stateJson,
            docKey: e.docKey,
          })),
        },
      };
    }
    case "importHistory": {
      await tab.importSessionHistory({
        index: msg.snapshot.index,
        entries: msg.snapshot.entries.map((e) => ({
          url: e.url,
          title: e.title,
          scrollY: e.scrollY,
          stateJson: e.stateJson,
          docKey: e.docKey,
        })),
      });
      return frameReply(tab.page);
    }
    case "deliverMessage": {
      // Cross-tab postMessage routed by the browser process — delivers into
      // this tab's top-level context (opener relationships are top-level).
      tab.deliverMessage({
        targetTabId: 0, // the shell resolved the target — irrelevant here
        fromTabId: msg.fromTabId,
        fromUrl: msg.fromUrl,
        dataJson: msg.dataJson,
        targetOrigin: msg.targetOrigin,
      });
      return frameReply(tab.page);
    }
    case "ping": {
      return { kind: "statusReply", ok: true, fonts: pipelinePrimaryFontName() };
    }
    case "dispose": {
      return { kind: "statusReply", ok: true, fonts: "" };
    }
  }
}

if (!isMainThread && parentPort !== null) {
  const channel = parentPort;
  // Profile dir flows via workerData — localStorage persists per profile so
  // tabs/restarts share it (RFC 0010 honest-boundary lift).
  const profileDir =
    typeof workerData === "object" && workerData !== null
      ? (workerData as { profileDir?: unknown }).profileDir
      : undefined;
  const downloadsDir =
    typeof workerData === "object" && workerData !== null
      ? (workerData as { downloadsDir?: unknown }).downloadsDir
      : undefined;
  // Tab identity — tabId tags outbound cross-tab postMessages; opener/scriptOpened
  // feed window.opener + window.close's script-closable gate (shell decisions).
  const wd =
    typeof workerData === "object" && workerData !== null
      ? (workerData as {
          tabId?: unknown;
          openerTabId?: unknown;
          scriptOpened?: unknown;
          openerInfo?: unknown;
        })
      : undefined;
  const tabId = typeof wd?.tabId === "number" && wd.tabId > 0 ? wd.tabId : 1;
  const rawOpenerInfo =
    typeof wd?.openerInfo === "object" && wd.openerInfo !== null
      ? (wd.openerInfo as { origin?: unknown; coop?: unknown; popup?: unknown })
      : undefined;
  const identity = {
    openerTabId: typeof wd?.openerTabId === "number" ? wd.openerTabId : null,
    scriptOpened: wd?.scriptOpened === true,
    ...(rawOpenerInfo !== undefined
      ? {
          // RFC 0031: the opener's identity rides workerData — the opened
          // document's COOP re-evaluates the pair inside its boot.
          openerInfo: {
            origin:
              typeof rawOpenerInfo.origin === "string" ? rawOpenerInfo.origin : null,
            coop:
              typeof rawOpenerInfo.coop === "string"
                ? (rawOpenerInfo.coop as import("@browser-engine/guest").Coop)
                : ("unsafe-none" as const),
            popup: rawOpenerInfo.popup === true,
          },
        }
      : {}),
  };
  const localRegistry =
    typeof profileDir === "string" && profileDir.length > 0
      ? new LocalStorageRegistry(`${profileDir}/local-storage.json`)
      : new LocalStorageRegistry();
  const tab = new TabSession(tabId, localRegistry, identity);
  if (typeof downloadsDir === "string" && downloadsDir.length > 0) {
    tab.downloadsDir = downloadsDir;
  }
  const port: PortLike = {
    postMessage: (data, transfer) =>
      channel.postMessage(data, transfer === undefined ? undefined : [...transfer]),
    onMessage: (cb) => channel.on("message", (d: ArrayBuffer) => cb(d)),
  };
  // One op at a time — the renderer serializes work on its single page state.
  let queue: Promise<unknown> = Promise.resolve();
  servePort(port, (msg) => {
    const p = queue.then(() => dispatch(tab, msg));
    queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  });
}
