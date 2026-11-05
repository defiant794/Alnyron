// TEMPORARY diagnostic (remove after). Reproduces EXACTLY what `next build`
// does to load the config, and prints the full (normally truncated) cause.
import { inspect } from "node:util";
const L = (...a) => console.log("[diag]", ...a);
const dump = (e) => inspect(e, { depth: 15, maxArrayLength: 60, breakLength: 200 });

L("node", process.version, process.platform, process.arch);

// 1) Reproduce Next's config loader (the exact failing path).
try {
  const { PHASE_PRODUCTION_BUILD } = await import("next/constants.js");
  const cfgMod = await import("next/dist/server/config.js");
  const loadConfig = (cfgMod.default && cfgMod.default.default) || cfgMod.default;
  L("calling next loadConfig()...");
  const cfg = await loadConfig(PHASE_PRODUCTION_BUILD, process.cwd());
  L("loadConfig OK, top keys:", Object.keys(cfg || {}).slice(0, 6).join(","));
} catch (e) {
  L("loadConfig FAIL message:", e && e.message);
  L("loadConfig FULL:", dump(e));
  if (e && e.cause != null) L("loadConfig CAUSE:", dump(e.cause));
}

// 2) Directly probe next's SWC loadBindings with its real error surfaced.
try {
  const swc = await import("next/dist/build/swc/index.js");
  if (typeof swc.loadBindings === "function") {
    await swc.loadBindings();
    L("swc loadBindings OK");
  }
} catch (e) {
  L("swc loadBindings FAIL:", dump(e));
  if (e && e.cause != null) L("swc CAUSE:", dump(e.cause));
}

L("=== END DIAG ===");
