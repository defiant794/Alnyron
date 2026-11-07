/**
 * Unit tests — src/config/system-pages.ts additions for monitor-nav (Slice B)
 * Journey: monitor-nav  AC-MONNAV-6, AC-MONNAV-2, AC-MONNAV-4
 *
 * Tests that:
 *  - SYSTEM_PAGE_PATHNAMES.monitor is the raw locale-agnostic path "/monitor"
 *  - SYSTEM_PAGE_HAS_BODY.monitor is false (Monitor has no editable copy)
 *  - SYSTEM_PAGE_IS_AREA.monitor is true (drives editor block + area rendering)
 *  - Other system pages are NOT area pages (SYSTEM_PAGE_IS_AREA is false for them)
 *  - Nav.monitor key exists in both messages/da.json and messages/en.json with value "Monitor"
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SYSTEM_PAGE_PATHNAMES,
  SYSTEM_PAGE_HAS_BODY,
  SYSTEM_PAGE_IS_AREA,
} from "@/config/system-pages";

// ── SYSTEM_PAGE_PATHNAMES.monitor ─────────────────────────────────────────────

describe("AC-MONNAV-6a: SYSTEM_PAGE_PATHNAMES.monitor — locale-agnostic raw path", () => {
  it("AC-MONNAV-6a: SYSTEM_PAGE_PATHNAMES.monitor is exactly '/monitor'", () => {
    expect(SYSTEM_PAGE_PATHNAMES.monitor).toBe("/monitor");
  });

  it("AC-MONNAV-6a-existing: home/contact/privacy pathnames are unchanged", () => {
    expect(SYSTEM_PAGE_PATHNAMES.home).toBe("/");
    expect(SYSTEM_PAGE_PATHNAMES.contact).toBe("/contact");
    expect(SYSTEM_PAGE_PATHNAMES.privacy).toBe("/privacy");
  });
});

// ── SYSTEM_PAGE_HAS_BODY.monitor ──────────────────────────────────────────────

describe("AC-MONNAV-config-body: SYSTEM_PAGE_HAS_BODY.monitor — no body editor", () => {
  it("AC-MONNAV-config-body-a: SYSTEM_PAGE_HAS_BODY.monitor is false", () => {
    // Monitor has no editable copy — the body editor must not be shown.
    expect(SYSTEM_PAGE_HAS_BODY.monitor).toBe(false);
  });
});

// ── SYSTEM_PAGE_IS_AREA ───────────────────────────────────────────────────────

describe("AC-MONNAV-4config: SYSTEM_PAGE_IS_AREA — area pages have no content editor", () => {
  it("AC-MONNAV-4config-a: SYSTEM_PAGE_IS_AREA.monitor is true (area page, no editor)", () => {
    // getSystemPageForEdit uses SYSTEM_PAGE_IS_AREA to return null for area pages.
    expect(SYSTEM_PAGE_IS_AREA.monitor).toBe(true);
  });

  it("AC-MONNAV-4config-b: SYSTEM_PAGE_IS_AREA.home is false (content page, has editor)", () => {
    expect(SYSTEM_PAGE_IS_AREA.home).toBe(false);
  });

  it("AC-MONNAV-4config-c: SYSTEM_PAGE_IS_AREA.contact is false (content page, has editor)", () => {
    expect(SYSTEM_PAGE_IS_AREA.contact).toBe(false);
  });

  it("AC-MONNAV-4config-d: SYSTEM_PAGE_IS_AREA.privacy is false (content page, has editor)", () => {
    expect(SYSTEM_PAGE_IS_AREA.privacy).toBe(false);
  });
});

// ── Messages: Nav.monitor key ─────────────────────────────────────────────────

function loadMessages(locale: "da" | "en"): Record<string, unknown> {
  const filePath = resolve(process.cwd(), "messages", `${locale}.json`);
  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

describe("AC-MONNAV-i18n: Nav.monitor translation key exists in both message files", () => {
  it("AC-MONNAV-i18n-da: messages/da.json has Nav.monitor = 'Monitor'", () => {
    const da = loadMessages("da") as { Nav?: Record<string, string> };
    expect(da.Nav?.monitor).toBe("Monitor");
  });

  it("AC-MONNAV-i18n-en: messages/en.json has Nav.monitor = 'Monitor'", () => {
    const en = loadMessages("en") as { Nav?: Record<string, string> };
    expect(en.Nav?.monitor).toBe("Monitor");
  });
});
