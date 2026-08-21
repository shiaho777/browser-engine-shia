import { app, BrowserWindow, ipcMain, screen } from "electron";
import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { SHELL_HTML } from "../dist/shell.js";
import { TabHost } from "../dist/tab-session.js";
import { HOME_URL } from "../dist/home.js";

const here = dirname(fileURLToPath(import.meta.url));
const shellPath = resolve(here, "../static/shell.html");
const preloadPath = resolve(here, "../preload/electron-preload.cjs");
const logPath = resolve(here, "../dist/electron-runtime.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
  }
  console.log(msg);
}

writeFileSync(shellPath, SHELL_HTML, "utf8");
log(`shell=${shellPath}`);
log(`preload=${preloadPath} exists=${existsSync(preloadPath)}`);
log(`esm SourceTextModule=${typeof vm.SourceTextModule === "function"}`);

let mainWindow = null;
const host = new TabHost();

function tab() {
  return host.active;
}

function navState() {
  const t = tab();
  return {
    canGoBack: t.canGoBack(),
    canGoForward: t.canGoForward(),
    url: t.url,
  };
}


function withDisplayDpr(viewport) {
  const vp = viewport && typeof viewport === "object" ? { ...viewport } : {};
  if (vp.devicePixelRatio == null) {
    try {
      vp.devicePixelRatio = screen.getPrimaryDisplay().scaleFactor || 2;
    } catch {
      vp.devicePixelRatio = 2;
    }
  }
  return vp;
}

function okFrame(frame, extra = {}) {
  return {
    ok: true,
    frame,
    nav: navState(),
    viewport: tab().viewport,
    tabs: host.list(),
    activeTabId: host.activeId,
    frameMode: "base64",
    frameRev: frame?.frameRev,
    width: frame?.width,
    height: frame?.height,
    bytes: frame?.bytes,
    durationMs: frame?.durationMs,
    source: frame?.url,
    title: frame?.title,
    url: frame?.url,
    scriptsRun: frame?.scriptsRun,
    mutations: frame?.mutations,
    scriptError: frame?.scriptError,
    engine: frame?.engine,
    pngBase64: frame?.pngBase64,
    ...extra,
  };
}

function emptyFrame(extra = {}) {
  return {
    ok: true,
    frame: null,
    nav: navState(),
    viewport: tab().viewport,
    tabs: host.list(),
    activeTabId: host.activeId,
    ...extra,
  };
}

function fail(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    nav: navState(),
    viewport: tab().viewport,
    tabs: host.list(),
    activeTabId: host.activeId,
  };
}

function registerIpc() {
  ipcMain.removeHandler("shell:navigate");
  ipcMain.removeHandler("shell:loadHtml");
  ipcMain.removeHandler("shell:back");
  ipcMain.removeHandler("shell:forward");
  ipcMain.removeHandler("shell:reload");
  ipcMain.removeHandler("shell:setViewport");
  ipcMain.removeHandler("shell:hitTest");
  ipcMain.removeHandler("shell:click");
  ipcMain.removeHandler("shell:type");
  ipcMain.removeHandler("shell:newTab");
  ipcMain.removeHandler("shell:selectTab");
  ipcMain.removeHandler("shell:closeTab");
  ipcMain.removeHandler("shell:tabs");
  ipcMain.removeHandler("shell:ping");

  ipcMain.handle("shell:navigate", async (_event, target, viewport) => {
    try {
      log(`navigate ${String(target ?? "")}`);
      return okFrame(await tab().navigate(String(target ?? ""), { viewport: withDisplayDpr(viewport) }));
    } catch (error) {
      log(`navigate error ${error instanceof Error ? error.message : String(error)}`);
      return fail(error);
    }
  });
  ipcMain.handle("shell:loadHtml", async (_event, html, title, viewport) => {
    try {
      return okFrame(await tab().loadHtml(String(html ?? ""), String(title ?? "upload.html"), viewport));
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:back", async (_event, viewport) => {
    try {
      const frame = await tab().back(withDisplayDpr(viewport));
      return frame === null ? emptyFrame() : okFrame(frame);
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:forward", async (_event, viewport) => {
    try {
      const frame = await tab().forward(withDisplayDpr(viewport));
      return frame === null ? emptyFrame() : okFrame(frame);
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:reload", async (_event, viewport) => {
    try {
      const frame = await tab().reload(withDisplayDpr(viewport));
      return frame === null ? emptyFrame() : okFrame(frame);
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:setViewport", async (_event, viewport) => {
    try {
      const vp = withDisplayDpr(viewport)
      const frame = await tab().applyViewport(vp);
      return frame === null ? emptyFrame() : okFrame(frame);
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:scroll", async (_event, deltaX, deltaY, viewport, extra) => {
    try {
      const vp = withDisplayDpr(viewport)
      if (viewport) tab().setViewport(vp);
      const settle = extra && extra.settle === true;
      const frame = await tab().scrollBy(Number(deltaX) || 0, Number(deltaY) || 0, { settle });
      return frame === null ? emptyFrame() : okFrame(frame);
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:hitTest", (_event, x, y) => tab().hitTestAt(Number(x), Number(y)));
  ipcMain.handle("shell:click", async (_event, x, y, viewport) => {
    try {
      const result = await tab().clickAt(Number(x), Number(y), withDisplayDpr(viewport));
      return okFrame(result.frame, {
        navigated: result.navigated,
        hit: result.hit,
        editable: result.editable,
      });
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:type", async (_event, nodeId, text, options) => {
    try {
      const opts = options && typeof options === "object" ? options : {};
      const frame = await tab().commitText(String(nodeId ?? ""), String(text ?? ""), {
        caret: typeof opts.caret === "number" ? opts.caret : undefined,
        selStart: typeof opts.selStart === "number" ? opts.selStart : undefined,
        selEnd: typeof opts.selEnd === "number" ? opts.selEnd : undefined,
        preview: opts.preview === true,
      });
      if (frame === null) return fail(new Error("no page"));
      return okFrame(frame, { typed: true });
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:newTab", async () => {
    try {
      host.create();
      const frame = await tab().navigate(HOME_URL, { push: true });
      return okFrame(frame, { newTab: true });
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:selectTab", async (_event, id) => {
    try {
      if (!host.select(Number(id))) return fail(new Error("tab not found"));
      let frame = tab().frame;
      if (frame === null) {
        frame = await tab().navigate(HOME_URL, { push: true });
      }
      return okFrame(frame, { tabSwitch: true });
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:closeTab", async (_event, id) => {
    try {
      host.close(Number(id ?? host.activeId));
      let frame = tab().frame;
      if (frame === null) {
        frame = await tab().navigate(HOME_URL, { push: true });
      }
      return okFrame(frame, { tabClosed: true });
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("shell:tabs", () => ({
    ok: true,
    tabs: host.list(),
    activeTabId: host.activeId,
  }));
  ipcMain.handle("shell:ping", () => ({
    ok: true,
    mode: "electron-ipc",
    features: ["multi-tab", "text-input", "base64-frame", "caret"],
    fonts: "system+builtin",
    tabs: host.list(),
    activeTabId: host.activeId,
  }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    title: "browser-engine-shia",
    backgroundColor: "#0b1220",
    show: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.webContents.on("preload-error", (_event, path, error) => {
    log(`preload-error ${path} ${error}`);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    log("did-finish-load");
    void mainWindow.webContents
      .executeJavaScript(`Boolean(window.engineShell && window.engineShell.navigate && window.engineShell.type && window.engineShell.newTab)`)
      .then((ok) => log(`bridge-present=${ok}`))
      .catch((e) => log(`bridge-check-failed ${e}`));
  });
  mainWindow.webContents.on("console-message", (_e, _level, message) => {
    log(`console ${message}`);
  });

  const startUrl = process.env.ENGINE_START_URL ? String(process.env.ENGINE_START_URL).trim() : "";
  const loadOpts = startUrl ? { query: { start: startUrl } } : undefined;
  if (startUrl) log(`start-url ${startUrl}`);
  void mainWindow.loadFile(shellPath, loadOpts);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

process.on("uncaughtException", (error) => {
  log(`uncaughtException ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
process.on("unhandledRejection", (error) => {
  log(`unhandledRejection ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
