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

// ── PAY1B-AC48: Payments namespace parity ─────────────────────────────────────

describe("PAY1B-AC48a: da.json has a Payments namespace", () => {
  it('top-level key "Payments" exists in da.json', () => {
    expect(da).toHaveProperty("Payments");
  });

  it('"Payments" value is an object (not null, not a string)', () => {
    expect(typeof da["Payments"]).toBe("object");
    expect(da["Payments"]).not.toBeNull();
  });
});

describe("PAY1B-AC48b: en.json has a Payments namespace", () => {
  it('top-level key "Payments" exists in en.json', () => {
    expect(en).toHaveProperty("Payments");
  });

  it('"Payments" value is an object (not null, not a string)', () => {
    expect(typeof en["Payments"]).toBe("object");
    expect(en["Payments"]).not.toBeNull();
  });
});

// Contract §10: the 25 Payments.billing keys the billing page uses, each required as a non-empty
// string in both files. The leaf walks below keep the two Payments trees identical beyond them,
// so a key added to one file only fails too.
const PAYMENTS_BILLING_KEYS = [
  "billing.metaTitle",
  "billing.title",
  "billing.lead",
  "billing.leadSubscribed",
  "billing.unlimited",
  "billing.planSub",
  "billing.intervalLegend",
  "billing.perYear",
  "billing.perMonth",
  "billing.price",
  "billing.saveTag",
  "billing.upgrade",
  "billing.finePrint",
  "billing.manage",
  "billing.renews",
  "billing.ends",
  "billing.pastDue",
  "billing.inactive",
  "billing.activated",
  "billing.pendingTitle",
  "billing.pendingBody",
  "billing.pendingRefresh",
  "billing.unavailable",
  "billing.errorCheckout",
  "billing.errorPortal",
] as const;

describe("PAY1B-AC48c: every required Payments.billing key (contract §10) is a non-empty string in both da and en", () => {
  const daPayments = nsOf(da, "Payments");
  const enPayments = nsOf(en, "Payments");

  it.each(PAYMENTS_BILLING_KEYS)("'%s' in da and en", (key) => {
    for (const payments of [daPayments, enPayments]) {
      const value = key
        .split(".")
        .reduce<unknown>(
          (node, part) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
          payments,
        );
      expect(typeof value).toBe("string");
      expect(value).not.toBe("");
    }
  });
});

describe("PAY1B-AC48h: da.Payments and en.Payments have the same leaf keys", () => {
  const daLeaves = leafPaths(nsOf(da, "Payments") ?? {});
  const enLeaves = leafPaths(nsOf(en, "Payments") ?? {});

  it("both namespaces hold at least the required keys (the walks below are not vacuous)", () => {
    expect(daLeaves.length).toBeGreaterThanOrEqual(PAYMENTS_BILLING_KEYS.length);
    expect(enLeaves.length).toBeGreaterThanOrEqual(PAYMENTS_BILLING_KEYS.length);
  });

  it.each(daLeaves)('en.Payments has key "%s"', (key) => {
    expect(enLeaves).toContain(key);
  });

  it.each(enLeaves)('da.Payments has key "%s"', (key) => {
    expect(daLeaves).toContain(key);
  });
});

// ── PAY1B-AC48: new Monitor keys (shell.billing, dashboard.upgradeLink, dashboard.manageLink) ──

describe("PAY1B-AC48d: da.Monitor.shell.billing key exists", () => {
  it('da.Monitor.shell has key "billing"', () => {
    const daMonitor = nsOf(da, "Monitor");
    const daShell = daMonitor ? nsOf(daMonitor, "shell") : null;
    expect(daShell).not.toBeNull();
    expect(daShell).toHaveProperty("billing");
  });
});

describe("PAY1B-AC48e: en.Monitor.shell.billing key exists", () => {
  it('en.Monitor.shell has key "billing"', () => {
    const enMonitor = nsOf(en, "Monitor");
    const enShell = enMonitor ? nsOf(enMonitor, "shell") : null;
    expect(enShell).not.toBeNull();
    expect(enShell).toHaveProperty("billing");
  });
});

describe("PAY1B-AC48f: Monitor.dashboard.upgradeLink key exists in both locales", () => {
  it("da.Monitor.dashboard has upgradeLink", () => {
    const daMonitor = nsOf(da, "Monitor");
    const daDash = daMonitor ? nsOf(daMonitor, "dashboard") : null;
    expect(daDash).toHaveProperty("upgradeLink");
  });

  it("en.Monitor.dashboard has upgradeLink", () => {
    const enMonitor = nsOf(en, "Monitor");
    const enDash = enMonitor ? nsOf(enMonitor, "dashboard") : null;
    expect(enDash).toHaveProperty("upgradeLink");
  });
});

describe("PAY1B-AC48g: Monitor.dashboard.manageLink key exists in both locales", () => {
  it("da.Monitor.dashboard has manageLink", () => {
    const daMonitor = nsOf(da, "Monitor");
    const daDash = daMonitor ? nsOf(daMonitor, "dashboard") : null;
    expect(daDash).toHaveProperty("manageLink");
  });

  it("en.Monitor.dashboard has manageLink", () => {
    const enMonitor = nsOf(en, "Monitor");
    const enDash = enMonitor ? nsOf(enMonitor, "dashboard") : null;
    expect(enDash).toHaveProperty("manageLink");
  });
});

// ── PAY1B-AC46: upgradeNote absent ───────────────────────────────────────────

describe("PAY1B-AC46c: Monitor.dashboard.upgradeNote is ABSENT from both locale files (key removed)", () => {
  it("upgradeNote absent from da.Monitor.dashboard", () => {
    const daMonitor = nsOf(da, "Monitor");
    const daDash = daMonitor ? nsOf(daMonitor, "dashboard") : null;
    expect(daDash).not.toHaveProperty("upgradeNote");
  });

  it("upgradeNote absent from en.Monitor.dashboard", () => {
    const enMonitor = nsOf(en, "Monitor");
    const enDash = enMonitor ? nsOf(enMonitor, "dashboard") : null;
    expect(enDash).not.toHaveProperty("upgradeNote");
  });
});
