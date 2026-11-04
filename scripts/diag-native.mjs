// TEMPORARY diagnostic (remove after): reveal why the native SWC binding fails
// to load in the Cloudflare Workers Builds image. Prints the hidden [cause].
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const line = (...a) => console.log("[diag]", ...a);

line("node", process.version, process.platform, process.arch);
try {
  line("glibc:", execSync("ldd --version 2>&1").toString().split("\n")[0]);
} catch (e) {
  line("ldd failed:", e.message);
}

for (const pkg of [
  "@next/swc-linux-x64-gnu",
  "@next/swc-linux-x64-musl",
  "@next/swc-wasm-nodejs",
]) {
  try {
    const resolved = require.resolve(pkg);
    line("RESOLVED", pkg, "->", resolved);
    try {
      require(pkg);
      line("LOADED OK", pkg);
    } catch (e) {
      line("LOAD FAIL", pkg, "::", e.message);
    }
  } catch (e) {
    line("NOT INSTALLED", pkg, "::", e.code || e.message);
  }
}

try {
  const swc = await import("next/dist/build/swc/index.js");
  if (typeof swc.loadBindings === "function") {
    await swc.loadBindings();
    line("next loadBindings OK");
  } else {
    line("next loadBindings not a function");
  }
} catch (e) {
  line("next loadBindings FAIL ::", e.message);
  const cause = e && e.cause;
  if (cause != null) {
    try {
      const arr = Array.isArray(cause) ? cause : [cause];
      arr.forEach((c, i) =>
        line(`cause[${i}] ::`, c && (c.stack || c.message || String(c))),
      );
    } catch (inner) {
      line("cause stringify failed:", inner.message);
    }
  }
}
line("=== END DIAG ===");
