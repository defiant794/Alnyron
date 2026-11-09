/**
 * Unit tests: src/config/monitor.ts — path constants, public paths, free limit, confirmation template, config.toml, engine constants.
 * Journey: monitor-web-area  MON-AC44, MON-AC58, MON-AC64, MON-AC65, MON-AC67; monitor-chrome  MCH-AC1, MCH-AC4, MCH-AC5; monitor-engine  ENG-AC7
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MONITOR_HOME_PATH,
  MONITOR_LOGIN_PATH,
  MONITOR_SIGNUP_PATH,
  MONITOR_FORGOT_PASSWORD_PATH,
  MONITOR_SET_PASSWORD_PATH,
  MONITOR_NO_ACCESS_PATH,
  MONITOR_DASHBOARD_PATH,
  MONITOR_NEW_PATH,
  MONITOR_SETTINGS_PATH,
  MONITOR_SITE_HOME_HREF,
  MONITOR_FREE_LIMIT,
  MONITOR_PUBLIC_PATHS,
  monitorDetailPath,
  monitorEditPath,
} from "@/config/monitor";

// ── Path constants ────────────────────────────────────────────────────────────

describe("MONITOR_* path constants — MON-AC58/MON-AC67", () => {
  it("MON-AC58a: MONITOR_HOME_PATH is /monitor", () => {
    expect(MONITOR_HOME_PATH).toBe("/monitor");
  });

  it("MON-AC58b: MONITOR_LOGIN_PATH is /monitor/login", () => {
    expect(MONITOR_LOGIN_PATH).toBe("/monitor/login");
  });

  it("MON-AC58c: MONITOR_SIGNUP_PATH is /monitor/signup", () => {
    expect(MONITOR_SIGNUP_PATH).toBe("/monitor/signup");
  });

  it("MON-AC58d: MONITOR_FORGOT_PASSWORD_PATH is /monitor/forgot-password", () => {
    expect(MONITOR_FORGOT_PASSWORD_PATH).toBe("/monitor/forgot-password");
  });

  it("MON-AC58e: MONITOR_SET_PASSWORD_PATH is /monitor/reset", () => {
    expect(MONITOR_SET_PASSWORD_PATH).toBe("/monitor/reset");
  });

  it("MON-AC58f: MONITOR_NO_ACCESS_PATH is /monitor/no-access", () => {
    expect(MONITOR_NO_ACCESS_PATH).toBe("/monitor/no-access");
  });

  it("MON-AC58g: MONITOR_DASHBOARD_PATH is /monitor/dashboard", () => {
    expect(MONITOR_DASHBOARD_PATH).toBe("/monitor/dashboard");
  });

  it("MON-AC58h: MONITOR_NEW_PATH is /monitor/monitors/new", () => {
    expect(MONITOR_NEW_PATH).toBe("/monitor/monitors/new");
  });

  it("MON-AC58i: MONITOR_SETTINGS_PATH is /monitor/settings", () => {
    expect(MONITOR_SETTINGS_PATH).toBe("/monitor/settings");
  });

  it("MCH-AC1b / MCH-AC4b: MONITOR_SITE_HOME_HREF is /", () => {
    expect(MONITOR_SITE_HOME_HREF).toBe("/");
  });

  it("MCH-AC5a / MON-AC67: MONITOR_FREE_LIMIT is 2", () => {
    expect(MONITOR_FREE_LIMIT).toBe(2);
  });

  it("MON-AC58j: monitorDetailPath returns /monitor/monitors/<id>", () => {
    expect(monitorDetailPath("abc-123")).toBe("/monitor/monitors/abc-123");
  });

  it("MON-AC58k: monitorEditPath returns /monitor/monitors/<id>/edit", () => {
    expect(monitorEditPath("abc-123")).toBe("/monitor/monitors/abc-123/edit");
  });
});

// ── MONITOR_PUBLIC_PATHS ──────────────────────────────────────────────────────

describe("MONITOR_PUBLIC_PATHS — MON-AC44", () => {
  it("MON-AC44a: home is public", () => {
    expect(MONITOR_PUBLIC_PATHS.has(MONITOR_HOME_PATH)).toBe(true);
  });

  it("MON-AC44b: login is public", () => {
    expect(MONITOR_PUBLIC_PATHS.has(MONITOR_LOGIN_PATH)).toBe(true);
  });

  it("MON-AC44c: signup is public", () => {
    expect(MONITOR_PUBLIC_PATHS.has(MONITOR_SIGNUP_PATH)).toBe(true);
  });

  it("MON-AC44d: forgot-password is public", () => {
    expect(MONITOR_PUBLIC_PATHS.has(MONITOR_FORGOT_PASSWORD_PATH)).toBe(true);
  });

  it("MON-AC44e: dashboard is NOT public (requires auth)", () => {
    expect(MONITOR_PUBLIC_PATHS.has(MONITOR_DASHBOARD_PATH)).toBe(false);
  });

  it("MON-AC44f: settings is NOT public", () => {
    expect(MONITOR_PUBLIC_PATHS.has(MONITOR_SETTINGS_PATH)).toBe(false);
  });
});

// ── supabase/config.toml — confirmation template + enable_signup: MON-AC65 ───

describe("supabase/config.toml: MON-AC65 confirmation template + enable_signup=false", () => {
  it("MON-AC65a: has [auth.email.template.confirmation] section", () => {
    const toml = readFileSync(resolve("supabase/config.toml"), "utf-8");
    expect(toml).toContain("[auth.email.template.confirmation]");
  });

  it("MON-AC65b: confirmation template has a subject", () => {
    const toml = readFileSync(resolve("supabase/config.toml"), "utf-8");
    const sectionIndex = toml.indexOf("[auth.email.template.confirmation]");
    expect(toml.slice(sectionIndex)).toMatch(/subject\s*=/);
  });

  it("MON-AC65c: confirmation template has a content_path", () => {
    const toml = readFileSync(resolve("supabase/config.toml"), "utf-8");
    const sectionIndex = toml.indexOf("[auth.email.template.confirmation]");
    expect(toml.slice(sectionIndex)).toMatch(/content_path\s*=/);
  });

  it("MON-AC65d: enable_signup is false (prod flip is slice C)", () => {
    const toml = readFileSync(resolve("supabase/config.toml"), "utf-8");
    expect(toml).toMatch(/enable_signup\s*=\s*false/);
  });
});

// ── supabase/templates/confirmation.html: MON-AC64 ───────────────────────────

describe("supabase/templates/confirmation.html: MON-AC64 signup confirmation link", () => {
  it("MON-AC64a: template link uses SiteURL + /auth/confirm", () => {
    const html = readFileSync(resolve("supabase/templates/confirmation.html"), "utf-8");
    expect(html).toContain("{{ .SiteURL }}/auth/confirm");
  });

  it("MON-AC64b: template link has token_hash={{ .TokenHash }}", () => {
    const html = readFileSync(resolve("supabase/templates/confirmation.html"), "utf-8");
    expect(html).toContain("token_hash={{ .TokenHash }}");
  });

  it("MON-AC64c: template link has type=signup", () => {
    const html = readFileSync(resolve("supabase/templates/confirmation.html"), "utf-8");
    expect(html).toContain("type=signup");
  });

  it("MON-AC64d: template link has next=/monitor/dashboard", () => {
    const html = readFileSync(resolve("supabase/templates/confirmation.html"), "utf-8");
    expect(html).toContain("next=/monitor/dashboard");
  });
});

// ── Engine constants — ENG-AC7: pinned by literal ────────────────────────────

import {
  MONITOR_CHECK_SUBREQUESTS,
  MONITOR_CHECK_WALL_MS,
  MONITOR_DAILY_EMAIL_CAP,
  MONITOR_DUE_GRACE_MINUTES,
  MONITOR_EMAIL_SEND_TIMEOUT_MS,
  MONITOR_FETCH_TIMEOUT_MS,
  MONITOR_FETCH_USER_AGENT,
  MONITOR_MAX_BODY_BYTES,
  MONITOR_MAX_REDIRECTS,
  MONITOR_MIN_RUN_SUBREQUESTS,
  MONITOR_RPC_TIMEOUT_MS,
  MONITOR_RUN_WALL_LIMIT_MS,
  MONITOR_SNAPSHOT_MAX_CHARS,
  MONITOR_SUMMARY_MAX_CHARS,
  MONITOR_SUMMARY_MAX_LINE_CHARS,
  MONITOR_SUMMARY_MAX_LINES,
} from "@/config/monitor";

describe("Engine config constants — ENG-AC7: literals pinned", () => {
  it("ENG-AC7cfg1: MONITOR_FETCH_TIMEOUT_MS is 15_000", () => {
    expect(MONITOR_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("ENG-AC7cfg2: MONITOR_MAX_BODY_BYTES is 1_048_576", () => {
    expect(MONITOR_MAX_BODY_BYTES).toBe(1_048_576);
  });

  it("ENG-AC7cfg3: MONITOR_MAX_REDIRECTS is 3", () => {
    expect(MONITOR_MAX_REDIRECTS).toBe(3);
  });

  it("ENG-AC7cfg4: MONITOR_SNAPSHOT_MAX_CHARS is 50_000", () => {
    expect(MONITOR_SNAPSHOT_MAX_CHARS).toBe(50_000);
  });

  it("ENG-AC7cfg5: MONITOR_DUE_GRACE_MINUTES is 5", () => {
    expect(MONITOR_DUE_GRACE_MINUTES).toBe(5);
  });

  it("ENG-AC7cfg6: MONITOR_DAILY_EMAIL_CAP is 10", () => {
    expect(MONITOR_DAILY_EMAIL_CAP).toBe(10);
  });

  it("ENG-AC7cfg7: MONITOR_SUMMARY_MAX_LINES is 5", () => {
    expect(MONITOR_SUMMARY_MAX_LINES).toBe(5);
  });

  it("ENG-AC7cfg8: MONITOR_SUMMARY_MAX_LINE_CHARS is 160", () => {
    expect(MONITOR_SUMMARY_MAX_LINE_CHARS).toBe(160);
  });

  it("ENG-AC7cfg9: MONITOR_SUMMARY_MAX_CHARS is 1_000", () => {
    expect(MONITOR_SUMMARY_MAX_CHARS).toBe(1_000);
  });

  it("ENG-AC7cfg10: MONITOR_FETCH_USER_AGENT is 'AlnyronMonitor/1.0 (+https://alnyron.dk/monitor)'", () => {
    expect(MONITOR_FETCH_USER_AGENT).toBe("AlnyronMonitor/1.0 (+https://alnyron.dk/monitor)");
  });

  it("ENG-AC7cfg11: MONITOR_CHECK_SUBREQUESTS is 15 (4 page requests × (2 DNS + 1 fetch) + snapshot, record, email)", () => {
    expect(MONITOR_CHECK_SUBREQUESTS).toBe(15);
  });

  it("ENG-AC7cfg12: MONITOR_MIN_RUN_SUBREQUESTS is 17 (pending emails + claim + one worst-case check)", () => {
    expect(MONITOR_MIN_RUN_SUBREQUESTS).toBe(17);
  });

  it("ENG-AC7cfg13: MONITOR_RUN_WALL_LIMIT_MS is 870_000 (Cloudflare's 900 s cron limit minus a 30 s margin)", () => {
    expect(MONITOR_RUN_WALL_LIMIT_MS).toBe(870_000);
  });

  it("ENG-AC7cfg14: MONITOR_EMAIL_SEND_TIMEOUT_MS is 10_000 (one Resend send)", () => {
    expect(MONITOR_EMAIL_SEND_TIMEOUT_MS).toBe(10_000);
  });

  it("ENG-AC7cfg15: MONITOR_RPC_TIMEOUT_MS is 5_000 (one Supabase call)", () => {
    expect(MONITOR_RPC_TIMEOUT_MS).toBe(5_000);
  });

  it("ENG-AC7cfg16: MONITOR_CHECK_WALL_MS is 35_000 (fetch 15 000 + error email 10 000 + snapshot 5 000 + record 5 000)", () => {
    expect(MONITOR_CHECK_WALL_MS).toBe(35_000);
  });
});
