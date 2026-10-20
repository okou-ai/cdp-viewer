import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The optional raw-transfer AST buffer cannot be allocated in this sandbox.
// Knip's supported non-raw parser performs the same dependency analysis.
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("../node_modules/knip/bin/knip.js", import.meta.url))],
  {
    stdio: "inherit",
    env: { ...process.env, KNIP_DISABLE_RAW_TRANSFER: "1" },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
