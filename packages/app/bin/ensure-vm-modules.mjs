// ensure-vm-modules.mjs — import FIRST in every user-facing bin entry.
//
// ESM (`<script type=module>`) execution needs `vm.SourceTextModule`, which
// Node only exposes with `--experimental-vm-modules`. Without it the engine
// boots with `esmSupported=false` and every module page (e.g. bilibili)
// silently degrades to zero evaluated modules. Mechanism over docs: re-exec
// with the flag instead of asking humans to remember it.
import { spawnSync } from "node:child_process";
import vm from "node:vm";

if (
  typeof vm.SourceTextModule !== "function" &&
  process.env["BE_VM_MODULES_RETRY"] !== "1"
) {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-vm-modules",
      ...process.execArgv,
      ...(process.argv[1] === undefined ? [] : [process.argv[1]]),
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      env: { ...process.env, BE_VM_MODULES_RETRY: "1" },
    },
  );
  process.exit(child.status ?? 1);
}
