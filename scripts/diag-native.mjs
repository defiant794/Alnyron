// TEMPORARY diagnostic (remove after). Pinpoints which native module fails to
// load while next.config.ts is evaluated, and whether its binary is on disk.
import { createRequire } from "node:module";
import { inspect } from "node:util";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const L = (...a) => console.log("[diag]", ...a);

L("node", process.version, process.platform, process.arch);

const dirs = [
  "node_modules/@unrs/resolver-binding-linux-x64-gnu",
  "node_modules/@swc/core-linux-x64-gnu",
  "node_modules/@esbuild/linux-x64",
  "node_modules/@next/swc-linux-x64-gnu",
  "node_modules/@parcel/watcher-linux-x64-glibc",
];
for (const d of dirs) {
  try {
    L("disk", d, fs.existsSync(d) ? "EXISTS [" + fs.readdirSync(d).join(",") + "]" : "MISSING");
  } catch (e) {
    L("disk", d, "ERR", e.message);
  }
}

for (const m of ["unrs-resolver", "@swc/core", "@parcel/watcher", "esbuild"]) {
  try {
    require(m);
    L("require OK", m);
  } catch (e) {
    L("require FAIL", m, "::", inspect(e, { depth: 6 }));
  }
}

try {
  await import("@opennextjs/cloudflare");
  L("import OK @opennextjs/cloudflare");
} catch (e) {
  L("import FAIL @opennextjs/cloudflare ::", inspect(e, { depth: 6 }));
}

L("=== END DIAG ===");
