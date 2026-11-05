// Tests for AC-I18N-07, AC-I18N-08, AC-I18N-09
// Reads messages/da.json and messages/en.json from the repo root.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// EM-DASH character (U+2014) — the character the writing-style guide prohibits in DA copy.
const EM_DASH = "\u2014";

// ── Load message files ────────────────────────────────────────────────────────
// Resolved relative to the repo root (process.cwd() under Vitest = project root).
function loadMessages(locale: "da" | "en"): Record<string, unknown> {
  const filePath = resolve(process.cwd(), "messages", `${locale}.json`);
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all dot-notated key paths for leaf string values. */
function collectLeafPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      paths.push(path);
    } else if (value !== null && typeof value === "object") {
      paths.push(...collectLeafPaths(value as Record<string, unknown>, path));
    }
  }
  return paths;
}

/** Recursively collect all dot-notated key paths for all nodes (leaves + branches). */
function collectAllPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);
    if (value !== null && typeof value === "object") {
      paths.push(...collectAllPaths(value as Record<string, unknown>, path));
    }
  }
  return paths;
}

/** Get a nested value by dot-notated path. */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AC-I18N-07: EN keys are a subset of DA keys", () => {
  it("every key in en.json exists in da.json (EN ⊆ DA)", () => {
    const da = loadMessages("da");
    const en = loadMessages("en");
    const enPaths = collectAllPaths(en);
    const daPaths = new Set(collectAllPaths(da));

    const missing = enPaths.filter((p) => !daPaths.has(p));
    expect(missing).toEqual([]);
  });
});

describe("AC-I18N-08: da.json has no blank leaf values", () => {
  it("every string leaf in da.json is non-empty", () => {
    const da = loadMessages("da");
    const leafPaths = collectLeafPaths(da);

    const blank = leafPaths.filter((p) => {
      const val = getByPath(da, p);
      return typeof val === "string" && val.trim() === "";
    });

    expect(blank).toEqual([]);
  });
});

describe("AC-I18N-09: da.json contains no em-dash character (U+2014)", () => {
  it("no string leaf in da.json contains '—' (U+2014)", () => {
    const da = loadMessages("da");
    const leafPaths = collectLeafPaths(da);

    const withEmDash = leafPaths.filter((p) => {
      const val = getByPath(da, p);
      return typeof val === "string" && val.includes(EM_DASH);
    });

    expect(withEmDash).toEqual([]);
  });

  it("serialized da.json text contains no '—' (U+2014) at file level", () => {
    const filePath = resolve(process.cwd(), "messages", "da.json");
    const raw = readFileSync(filePath, "utf-8");
    expect(raw).not.toContain(EM_DASH);
  });
});
