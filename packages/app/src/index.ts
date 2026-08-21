import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startAppServer } from "./server.js";

export { startAppServer, renderTarget, type AppServer, type NavigateResult } from "./server.js";
export { HOME_HTML, HOME_URL, DEMO_HTML, DEMO_URL, LIVE_HTML, LIVE_URL, FONTS_HTML, FONTS_URL, FORM_HTML, FORM_URL } from "./home.js";
export { bootFineSession, collectDocumentScripts } from "./engine-runtime.js";
export { TabSession, TabHost, type ClickResult, type HitInfo, type TabSnapshot } from "./tab-session.js";
export { loadPage, findLinkHref, type PageFrame, type PageState } from "./page.js";
export {
  DEFAULT_APP_VIEWPORT,
  normalizeViewport,
  type EngineHost,
  type EngineViewport,
  type EngineFrame,
  type EngineNavState,
  type EngineHitInfo,
  type EngineClickResult,
} from "./host-api.js";

export interface RunAppOptions {
  readonly host?: string;
  readonly port?: number;
  readonly open?: boolean;
  readonly mode?: "electron" | "web" | "auto";
  readonly argv?: readonly string[];
}

function parseArgs(argv: readonly string[]): {
  host?: string;
  port?: number;
  open: boolean;
  mode: "electron" | "web" | "auto";
} {
  let host: string | undefined;
  let port: number | undefined;
  let open = true;
  let mode: "electron" | "web" | "auto" = "auto";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      host = argv[i + 1];
      i += 1;
    } else if (arg === "--port") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`invalid --port ${String(argv[i + 1])}`);
      }
      port = value;
      i += 1;
    } else if (arg === "--no-open") {
      open = false;
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--web") {
      mode = "web";
    } else if (arg === "--electron") {
      mode = "electron";
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: browser-engine-app [--auto|--electron|--web] [--port N] [--host 127.0.0.1] [--no-open]",
      );
    } else if (arg !== undefined) {
      throw new Error(`unknown option ${arg}`);
    }
  }
  const result: { host?: string; port?: number; open: boolean; mode: "electron" | "web" | "auto" } = {
    open,
    mode,
  };
  if (host !== undefined) result.host = host;
  if (port !== undefined) result.port = port;
  return result;
}

function openInAppWindow(url: string): void {
  const os = platform();
  if (os === "darwin") {
    const chrome = spawn("open", ["-na", "Google Chrome", "--args", `--app=${url}`], {
      detached: true,
      stdio: "ignore",
    });
    chrome.on("error", () => {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    });
    chrome.unref();
    return;
  }
  if (os === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function tryResolveElectronBinary(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require("electron") as string;
  } catch {
    return null;
  }
}

async function runElectronMode(): Promise<number> {
  const electronBin = tryResolveElectronBinary();
  if (electronBin === null) {
    throw new Error(
      "electron is not installed. Run: npm install electron --workspace @browser-engine/app",
    );
  }
  const main = join(dirname(fileURLToPath(import.meta.url)), "../electron/main.mjs");
  const electronArgs = [main];
  const preexisting = typeof process.env["NODE_OPTIONS"] === "string" ? process.env["NODE_OPTIONS"] : "";
  const nodeOptions = preexisting.includes("--experimental-vm-modules")
    ? preexisting
    : `${preexisting} --experimental-vm-modules`.trim();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    NODE_OPTIONS: nodeOptions,
  };
  const child = spawn(electronBin, electronArgs, {
    stdio: "inherit",
    env: childEnv,
  });
  return await new Promise<number>((resolvePromise) => {
    child.on("exit", (code) => {
      resolvePromise(code ?? 0);
    });
    child.on("error", (error) => {
      console.error(error.message);
      resolvePromise(1);
    });
  });
}

async function runWebMode(options: {
  host?: string;
  port?: number;
  open: boolean;
}): Promise<number> {
  const serverOptions: { host?: string; port?: number } = {};
  if (options.host !== undefined) serverOptions.host = options.host;
  if (options.port !== undefined) serverOptions.port = options.port;
  const server = await startAppServer(serverOptions);
  console.log(`browser-engine-shia interactive shell on ${server.url}`);
  console.log("features: FineSession scripts, viewport layout, zoom, hit-test clicks");
  if (options.open) {
    openInAppWindow(server.url);
  }
  const stop = (): void => {
    void server.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
  return 0;
}

export async function runApp(options: RunAppOptions = {}): Promise<number> {
  try {
    const parsed =
      options.argv !== undefined
        ? parseArgs(options.argv)
        : {
            open: options.open ?? true,
            mode: options.mode ?? "auto",
            host: options.host,
            port: options.port,
          };
    let mode = options.mode ?? parsed.mode;
    if (mode === "auto") {
      mode = tryResolveElectronBinary() === null ? "web" : "electron";
    }
    if (mode === "electron") {
      console.log("starting Electron shell (engine content + hit-test navigation)");
      return await runElectronMode();
    }
    return await runWebMode({
      open: options.open ?? parsed.open,
      ...(parsed.host !== undefined || options.host !== undefined
        ? { host: options.host ?? parsed.host }
        : {}),
      ...(parsed.port !== undefined || options.port !== undefined
        ? { port: options.port ?? parsed.port }
        : {}),
    });
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runApp({ argv: process.argv.slice(2) });
}
