/**
 * Unit tests: src/config/monitor.ts — path constants, public paths, free limit,
 * interval config, confirmation template, config.toml.
 * Journey: monitor-web-area  MON-AC2, MON-AC58–MON-AC68
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

  it("MON-AC67: MONITOR_FREE_LIMIT is 5", () => {
    expect(MONITOR_FREE_LIMIT).toBe(5);
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
