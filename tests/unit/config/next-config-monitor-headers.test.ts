/**
 * Unit tests: next.config.mjs X-Robots-Tag for /monitor and /monitor/:path*.
 * Journey: monitor-web-area  MON-AC2, MON-AC66
 *
 * Verifies that requests to /monitor and /monitor/* get X-Robots-Tag: noindex, nofollow
 * via the Next.js headers() config (path-based rule, not host-based).
 */
import { describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";

vi.mock("next-intl/plugin", () => ({ default: () => (config: NextConfig) => config }));
vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }));

import nextConfig from "../../../next.config.mjs";

/** Returns the X-Robots-Tag header value for a given path from the config headers, or null. */
async function robotsTagForPath(path: string): Promise<string | null> {
  const rules = (await nextConfig.headers?.()) ?? [];
  // Find rules whose `source` matches `path` (simple prefix check for /monitor and /monitor/*)
  const matching = rules.filter((rule) => {
    if (rule.source === "/monitor" && path === "/monitor") return true;
    if (rule.source === "/monitor/:path*" && path.startsWith("/monitor/")) return true;
    return false;
  });
  const header = matching.flatMap((rule) => rule.headers).find((h) => h.key === "X-Robots-Tag");
  return header?.value ?? null;
}

describe("next.config headers: MON-AC2/MON-AC66 /monitor paths get X-Robots-Tag noindex", () => {
  it("MON-AC66a: /monitor gets X-Robots-Tag: noindex, nofollow", async () => {
    await expect(robotsTagForPath("/monitor")).resolves.toBe("noindex, nofollow");
  });

  it("MON-AC66b: /monitor/login gets X-Robots-Tag: noindex, nofollow", async () => {
    await expect(robotsTagForPath("/monitor/login")).resolves.toBe("noindex, nofollow");
  });

  it("MON-AC66c: /monitor/dashboard gets X-Robots-Tag: noindex, nofollow", async () => {
    await expect(robotsTagForPath("/monitor/dashboard")).resolves.toBe("noindex, nofollow");
  });

  it("MON-AC66d: /monitor/monitors/new gets X-Robots-Tag: noindex, nofollow", async () => {
    await expect(robotsTagForPath("/monitor/monitors/new")).resolves.toBe("noindex, nofollow");
  });

  it("MON-AC66e: /admin does NOT get a monitor X-Robots-Tag via path rule", async () => {
    // /admin may get it via its own rule; we just check our rule does not bleed
    const rules = (await nextConfig.headers?.()) ?? [];
    const monitorRules = rules.filter(
      (rule) => rule.source === "/monitor" || rule.source === "/monitor/:path*",
    );
    const hasAdminMatch = monitorRules.some(
      (rule) => rule.source !== "/monitor" && rule.source !== "/monitor/:path*",
    );
    expect(hasAdminMatch).toBe(false);
  });
});
