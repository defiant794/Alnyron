/**
 * Unit tests: messages/en.json — Monitor and Auth namespace parity with DA
 * Journey: monitor-i18n  AC-I18N-MON-23, 24, 25, 26
 *
 * Uses raw messages/en.json (not loadMessages, which applies a DA fallback merge
 * and would mask every missing EN key). Reads both files the same way
 * messages-parity.test.ts does (fs.readFileSync from process.cwd()).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Load raw message files ────────────────────────────────────────────────────

function loadRaw(locale: "da" | "en"): Record<string, unknown> {
  const raw = readFileSync(resolve(process.cwd(), "messages", `${locale}.json`), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

const da = loadRaw("da");
const en = loadRaw("en");

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Collect all dot-notated leaf key paths under a top-level namespace object. */
function leafPaths(ns: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(ns).flatMap(([key, val]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return leafPaths(val as Record<string, unknown>, path);
    }
    return [path];
  });
}

function nsOf(messages: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const ns = messages[name];
  if (ns !== null && typeof ns === "object" && !Array.isArray(ns)) {
    return ns as Record<string, unknown>;
  }
  return null;
}

// ── AC-I18N-MON-25/26: namespaces exist ───────────────────────────────────────

describe("AC-I18N-MON-25: en.json has a Monitor namespace", () => {
  it('top-level key "Monitor" exists in en.json', () => {
    expect(en).toHaveProperty("Monitor");
  });

  it('"Monitor" value is an object (not null, not a string)', () => {
    expect(typeof en["Monitor"]).toBe("object");
    expect(en["Monitor"]).not.toBeNull();
  });
});

describe("AC-I18N-MON-26: en.json has an Auth namespace", () => {
  it('top-level key "Auth" exists in en.json', () => {
    expect(en).toHaveProperty("Auth");
  });

  it('"Auth" value is an object (not null, not a string)', () => {
    expect(typeof en["Auth"]).toBe("object");
    expect(en["Auth"]).not.toBeNull();
  });
});

// ── AC-I18N-MON-23: Monitor keys EN ⊆ DA ─────────────────────────────────────

describe("AC-I18N-MON-23: every leaf key in da.Monitor exists in en.Monitor", () => {
  const daMonitor = nsOf(da, "Monitor");
  const enMonitor = nsOf(en, "Monitor");

  it("da.Monitor and en.Monitor are both present (prerequisite)", () => {
    expect(daMonitor).not.toBeNull();
    expect(enMonitor).not.toBeNull();
  });

  if (daMonitor && enMonitor) {
    const daLeaves = leafPaths(daMonitor);
    const enLeaves = new Set(leafPaths(enMonitor));

    it.each(daLeaves)('en.Monitor has key "%s"', (key) => {
      expect(enLeaves.has(key)).toBe(true);
    });
  }
});

// ── AC-I18N-MON-24: Auth keys EN ⊆ DA ────────────────────────────────────────

describe("AC-I18N-MON-24: every leaf key in da.Auth exists in en.Auth", () => {
  const daAuth = nsOf(da, "Auth");
  const enAuth = nsOf(en, "Auth");

  it("da.Auth and en.Auth are both present (prerequisite)", () => {
    expect(daAuth).not.toBeNull();
    expect(enAuth).not.toBeNull();
  });

  if (daAuth && enAuth) {
    const daLeaves = leafPaths(daAuth);
    const enLeaves = new Set(leafPaths(enAuth));

    it.each(daLeaves)('en.Auth has key "%s"', (key) => {
      expect(enLeaves.has(key)).toBe(true);
    });
  }
});
