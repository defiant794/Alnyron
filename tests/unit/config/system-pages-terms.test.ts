/**
 * Unit tests: src/config/system-pages.ts — 'terms' key additions for slice 1d
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J3-C01
 *
 * Coverage:
 *   - SYSTEM_PAGE_PATHNAMES.terms = "/terms"
 *   - SYSTEM_PAGE_HAS_BODY.terms = false (body is the versioned legal module, not DB markdown)
 *   - SYSTEM_PAGE_IS_AREA.terms = false (content page, not area)
 *   - Existing pages (home, contact, privacy, monitor) are unchanged
 *   - Nav.terms key in da.json = "Handelsbetingelser", en.json = "Terms and conditions"
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SYSTEM_PAGE_PATHNAMES,
  SYSTEM_PAGE_HAS_BODY,
  SYSTEM_PAGE_IS_AREA,
} from "@/config/system-pages";

// ── WD-J3-C01 (WD-T-SYS-01): SYSTEM_PAGE_PATHNAMES.terms ────────────────────

describe("WD-J3-C01 (WD-T-SYS-01): SYSTEM_PAGE_PATHNAMES.terms — locale-agnostic raw path", () => {
  it("WD-T-SYS-01a: SYSTEM_PAGE_PATHNAMES.terms is exactly '/terms'", () => {
    expect(SYSTEM_PAGE_PATHNAMES.terms).toBe("/terms");
  });

  it("WD-T-SYS-01b: existing pathnames unchanged", () => {
    expect(SYSTEM_PAGE_PATHNAMES.home).toBe("/");
    expect(SYSTEM_PAGE_PATHNAMES.contact).toBe("/contact");
    expect(SYSTEM_PAGE_PATHNAMES.privacy).toBe("/privacy");
    expect(SYSTEM_PAGE_PATHNAMES.monitor).toBe("/monitor");
  });
});

// ── WD-J3-C01 (WD-T-SYS-02): SYSTEM_PAGE_HAS_BODY.terms ─────────────────────

describe("WD-J3-C01 (WD-T-SYS-02): SYSTEM_PAGE_HAS_BODY.terms — false (versioned module, not DB markdown)", () => {
  it("WD-T-SYS-02a: SYSTEM_PAGE_HAS_BODY.terms is false", () => {
    expect(SYSTEM_PAGE_HAS_BODY.terms).toBe(false);
  });

  // Only privacy renders a DB markdown body (contract amendment A7).
  it("WD-T-SYS-02b: existing has-body values unchanged (home false, contact false, privacy true, monitor false)", () => {
    expect(SYSTEM_PAGE_HAS_BODY.home).toBe(false);
    expect(SYSTEM_PAGE_HAS_BODY.contact).toBe(false);
    expect(SYSTEM_PAGE_HAS_BODY.privacy).toBe(true);
    expect(SYSTEM_PAGE_HAS_BODY.monitor).toBe(false);
  });
});

// ── WD-J3-C01 (WD-T-SYS-03): SYSTEM_PAGE_IS_AREA.terms ──────────────────────

describe("WD-J3-C01 (WD-T-SYS-03): SYSTEM_PAGE_IS_AREA.terms — false (content page, not area)", () => {
  it("WD-T-SYS-03a: SYSTEM_PAGE_IS_AREA.terms is false", () => {
    expect(SYSTEM_PAGE_IS_AREA.terms).toBe(false);
  });

  it("WD-T-SYS-03b: monitor IS_AREA is true (area page); others false", () => {
    expect(SYSTEM_PAGE_IS_AREA.monitor).toBe(true);
    expect(SYSTEM_PAGE_IS_AREA.home).toBe(false);
    expect(SYSTEM_PAGE_IS_AREA.contact).toBe(false);
    expect(SYSTEM_PAGE_IS_AREA.privacy).toBe(false);
  });
});

// ── Nav.terms messages key ────────────────────────────────────────────────────

function loadMessages(locale: "da" | "en"): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), "messages", `${locale}.json`), "utf-8")) as Record<string, unknown>;
}

describe("WD-J3-C05: Nav.terms translation key — DA 'Handelsbetingelser', EN 'Terms and conditions'", () => {
  it("messages/da.json has Nav.terms = 'Handelsbetingelser'", () => {
    const da = loadMessages("da") as { Nav?: Record<string, string> };
    expect(da.Nav?.terms).toBe("Handelsbetingelser");
  });

  it("messages/en.json has Nav.terms = 'Terms and conditions'", () => {
    const en = loadMessages("en") as { Nav?: Record<string, string> };
    expect(en.Nav?.terms).toBe("Terms and conditions");
  });
});
