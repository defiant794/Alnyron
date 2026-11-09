/**
 * Static-content tests: recovery.html, config.toml, wrangler.jsonc (cron),
 * next.config.mjs host-based X-Robots-Tag rule, and runbook files.
 * Journey: monitor-ship-routing  SHIP-AC3a..SHIP-AC3c, SHIP-AC5d..SHIP-AC5f,
 *   SHIP-AC6a..SHIP-AC6c, SHIP-AC9a..SHIP-AC9c, SHIP-AC10a..SHIP-AC10h
 *
 * These tests assert the exact literal tokens that production infrastructure
 * reads.  They fail (Red) when the files have not yet been updated.
 */
import { readFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import * as path from "node:path";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { parse, type ParseError } from "jsonc-parser";
import type { NextConfig } from "next";
import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";
import { isMonitorHost, MONITOR_FETCH_USER_AGENT } from "@/config/monitor";

vi.mock("next-intl/plugin", () => ({ default: () => (config: NextConfig) => config }));
vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }));

// ── File loaders ─────────────────────────────────────────────────────────────

const root = path.resolve(process.cwd());

function readFile(rel: string): string {
  return readFileSync(path.join(root, rel), "utf-8");
}

// ── SHIP-AC5d/AC5e/AC5f: recovery.html monitor branch ───────────────────────

describe("recovery.html — SHIP-AC5d/AC5e: Monitor recovery branch", () => {
  // The Monitor branch, line for line: the condition admits exactly the two Monitor origins as
  // RedirectTo, and the line under it builds the link from RedirectTo (not the Site URL).
  const MONITOR_BRANCH_CONDITION =
    '{{ else if or (eq .RedirectTo "https://monitor.alnyron.dk") (eq .RedirectTo "http://monitor.localhost:3000") }}';
  const MONITOR_BRANCH_LINK =
    '<a href="{{ .RedirectTo }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=recovery&amp;next=/monitor/reset">Vælg en ny adgangskode</a>';
  let html: string;
  let lines: string[];

  beforeAll(() => {
    html = readFile("supabase/templates/recovery.html");
    lines = html.split(/\r?\n/).map((line) => line.trim());
  });

  it("SHIP-AC5d-1/AC5e-1: the Monitor branch condition line is exactly RedirectTo == https://monitor.alnyron.dk or http://monitor.localhost:3000", () => {
    expect(lines.filter((line) => line === MONITOR_BRANCH_CONDITION)).toHaveLength(1);
  });

  it("SHIP-AC5d-2/AC5e-2: the line under the Monitor condition is exactly the {{ .RedirectTo }}/auth/confirm link with type=recovery and next=/monitor/reset", () => {
    expect(lines[lines.indexOf(MONITOR_BRANCH_CONDITION) + 1]).toBe(MONITOR_BRANCH_LINK);
  });

  it("SHIP-AC5f-1: MyLife branch still present (eq .RedirectTo 'https://mylife.alnyron.dk')", () => {
    expect(html).toContain('"https://mylife.alnyron.dk"');
  });

  it("SHIP-AC5f-2: MyLife branch still uses next=/mylife/set-password", () => {
    expect(html).toContain("next=/mylife/set-password");
  });
});

// ── SHIP-AC6a/AC6b/AC6c: supabase/config.toml ────────────────────────────────

describe("config.toml — SHIP-AC6a/AC6b/AC6c: local auth config", () => {
  let toml: string;

  beforeAll(() => {
    toml = readFile("supabase/config.toml");
  });

  it("SHIP-AC6a-1: [auth] enable_signup = true", () => {
    // Top-level [auth] section
    const authSection = toml.match(/\[auth\]([\s\S]*?)\[auth\./)?.[1] ?? "";
    expect(authSection).toMatch(/enable_signup\s*=\s*true/);
  });

  it("SHIP-AC6a-2: [auth.email] enable_signup = true", () => {
    const emailSection = toml.match(/\[auth\.email\]([\s\S]*?)\[auth\./)?.[1] ?? "";
    expect(emailSection).toMatch(/enable_signup\s*=\s*true/);
  });

  it("SHIP-AC6b-1: additional_redirect_urls includes http://monitor.localhost:3000", () => {
    expect(toml).toContain('"http://monitor.localhost:3000"');
  });

  it("SHIP-AC6c-1: [auth.rate_limit] email_sent = 10", () => {
    const rateLimitSection = toml.match(/\[auth\.rate_limit\]([\s\S]*?)(?:\[|$)/)?.[1] ?? "";
    expect(rateLimitSection).toMatch(/^email_sent\s*=\s*10\s*$/m);
  });
});

// ── SHIP-AC9a/AC9b/AC9c: workers/monitor-cron/wrangler.jsonc ─────────────────

type CronWranglerConfig = {
  vars?: Record<string, string>;
  routes?: unknown;
  route?: unknown;
};

describe("wrangler.jsonc (cron) — SHIP-AC9a/AC9b: MONITOR_SITE_URL + no routes", () => {
  let cronConfig: CronWranglerConfig;
  let cronParseErrors: ParseError[];

  beforeAll(() => {
    const raw = readFile("workers/monitor-cron/wrangler.jsonc");
    cronParseErrors = [];
    cronConfig = parse(raw, cronParseErrors, { allowTrailingComma: true }) as CronWranglerConfig;
  });

  it("SHIP-AC9a-1: parses without JSONC errors", () => {
    expect(cronParseErrors).toEqual([]);
  });

  it("SHIP-AC9a-2: vars.MONITOR_SITE_URL is 'https://monitor.alnyron.dk'", () => {
    expect(cronConfig.vars?.["MONITOR_SITE_URL"]).toBe("https://monitor.alnyron.dk");
  });

  it("SHIP-AC9b-1: no routes field (cron only, no HTTP ingress)", () => {
    expect(cronConfig.routes).toBeUndefined();
  });

  it("SHIP-AC9b-2: no route field", () => {
    expect(cronConfig.route).toBeUndefined();
  });
});

// ── SHIP-AC9c: MONITOR_FETCH_USER_AGENT contains +https://monitor.alnyron.dk ──

describe("MONITOR_FETCH_USER_AGENT — SHIP-AC9c: user-agent pinned to subdomain URL", () => {
  it("SHIP-AC9c-1: MONITOR_FETCH_USER_AGENT is 'AlnyronMonitor/1.0 (+https://monitor.alnyron.dk)'", () => {
    expect(MONITOR_FETCH_USER_AGENT).toBe("AlnyronMonitor/1.0 (+https://monitor.alnyron.dk)");
  });
});

// ── SHIP-AC3a..SHIP-AC3c: next.config.mjs host-based X-Robots-Tag ────────────

import nextConfig from "../../../next.config.mjs";

/**
 * The X-Robots-Tag the catch-all host rules give a request on `host`, or null. The rules
 * run through Next's own `matchHas` (the server's matcher: `^value$`, case-insensitive,
 * against the Host header without its port), so a rule that only matches unanchored fails.
 */
async function robotsTagForHost(host: string): Promise<string | null> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const request = new IncomingMessage(new Socket());
  request.headers.host = host;
  const header = rules
    .filter((rule) => rule.source === "/:path*" && rule.has && matchHas(request, {}, rule.has, rule.missing) !== false)
    .flatMap((rule) => rule.headers)
    .find((entry) => entry.key === "X-Robots-Tag");
  return header?.value ?? null;
}

describe("next.config.mjs — SHIP-AC3a/AC3b/AC3c: host-based X-Robots-Tag for Monitor", () => {
  it("SHIP-AC3a-1: a catch-all rule matches the Monitor host forms and sets X-Robots-Tag: noindex, nofollow", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toContainEqual({
      source: "/:path*",
      has: [{ type: "host", value: "monitor\\.(?:alnyron\\.dk|localhost)\\.?" }],
      headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
    });
  });

  it.each([
    "monitor.alnyron.dk",
    "monitor.alnyron.dk:443",
    "MONITOR.ALNYRON.DK",
    "monitor.alnyron.dk.",
    "monitor.alnyron.dk.:443",
  ])("SHIP-AC3b-1: a request on %s gets X-Robots-Tag noindex, nofollow", async (host) => {
    expect(isMonitorHost(host)).toBe(true);
    await expect(robotsTagForHost(host)).resolves.toBe("noindex, nofollow");
  });

  it.each(["monitor.localhost", "monitor.localhost:3000", "monitor.localhost."])(
    "SHIP-AC3c-1: a request on %s gets X-Robots-Tag noindex, nofollow",
    async (host) => {
      expect(isMonitorHost(host)).toBe(true);
      await expect(robotsTagForHost(host)).resolves.toBe("noindex, nofollow");
    },
  );

  it.each([
    "alnyron.dk",
    "www.alnyron.dk",
    "localhost:3000",
    "evil-monitor.alnyron.dk",
    "xmonitor.localhost",
    "monitor.alnyron.dk.evil.com",
    "monitor.localhost.evil.com",
    "monitor.alnyron.dk..",
  ])("SHIP-AC3a-3: a request on %s (not a Monitor host) gets no host-based X-Robots-Tag", async (host) => {
    expect(isMonitorHost(host)).toBe(false);
    await expect(robotsTagForHost(host)).resolves.toBeNull();
  });
});

// ── SHIP-AC10a..SHIP-AC10h: runbook files ────────────────────────────────────

describe("docs/runbooks/monitor-go-live.md — SHIP-AC10a..SHIP-AC10g: runbook completeness", () => {
  let runbook: string;

  beforeAll(() => {
    runbook = readFile("docs/runbooks/monitor-go-live.md");
  });

  it("SHIP-AC10a-1: file exists and is non-empty", () => {
    expect(runbook.length).toBeGreaterThan(100);
  });

  it("SHIP-AC10b-1: contains exact allow-list entry 'https://monitor.alnyron.dk'", () => {
    expect(runbook).toContain("https://monitor.alnyron.dk");
  });

  it("SHIP-AC10c-1: contains exact MyLife allow-list entry 'https://mylife.alnyron.dk'", () => {
    expect(runbook).toContain("https://mylife.alnyron.dk");
  });

  it("SHIP-AC10d-1: contains 'rate_limit_email_sent'", () => {
    expect(runbook).toContain("rate_limit_email_sent");
  });

  it("SHIP-AC10e-1: contains 'disable_signup' (rollback step)", () => {
    expect(runbook).toContain("disable_signup");
  });

  it("SHIP-AC10e-2: contains a rollback section or instruction", () => {
    expect(runbook.toLowerCase()).toContain("rollback");
  });

  it("SHIP-AC10f-1: contains 'generate_link' (pre-flip canary)", () => {
    expect(runbook).toContain("generate_link");
  });

  it("SHIP-AC10g-1: contains 'WAF' (Cloudflare WAF rate-limit step)", () => {
    expect(runbook).toContain("WAF");
  });
});

describe("docs/runbooks/area-user-onboarding.md — SHIP-AC10h: stale caveat removed", () => {
  let onboardingDoc: string;

  beforeAll(() => {
    onboardingDoc = readFile("docs/runbooks/area-user-onboarding.md");
  });

  it("SHIP-AC10h-1: the stale 'Production gets … in slice C' caveat is removed (any wording)", () => {
    expect(onboardingDoc).not.toMatch(/Production gets .* in slice C/i);
  });

  it("SHIP-AC10h-2: mentions go-live runbook as the reference for production verification", () => {
    expect(onboardingDoc).toContain("monitor-go-live");
  });
});
