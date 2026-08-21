import { spawn } from "node:child_process";
import { platform } from "node:os";
import { startAppServer } from "./server.js";

function openUrl(url: string): void {
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

export async function launchHost(options: {
  readonly host?: string;
  readonly port?: number;
  readonly open?: boolean;
} = {}): Promise<number> {
  const serverOptions: { host?: string; port?: number } = {};
  if (options.host !== undefined) serverOptions.host = options.host;
  if (options.port !== undefined) serverOptions.port = options.port;
  const server = await startAppServer(serverOptions);
  console.log(`browser-engine-shia engine host on ${server.url}`);
  console.log("open this URL if the window does not appear:");
  console.log(server.url);
  if (options.open !== false) {
    openUrl(server.url);
  }
  const stop = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("launch-host.js")) {
  void launchHost({ open: !process.argv.includes("--no-open") }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
