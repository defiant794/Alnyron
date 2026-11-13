/**
 * Unit tests: src/config/stripe-env.ts — getStripeEnv() lazy Stripe env validation,
 * in a server-only module (contract amendment B10); full secret keys in test mode only
 * (B12); STRIPE_LIVEMODE must match the key's mode (B14).
 * Journey: payments-slice1b-billing  PAY1B-AC41
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";

// The module starts with `import "server-only"`, which throws outside React's server
// environment (as here); PAY1B-AC41j removes this mock to prove it.
vi.mock("server-only", () => ({}));

import { getStripeEnv } from "@/config/stripe-env";

// getStripeEnv reads process.env at call time (lazy), so vi.stubEnv before the
// call is sufficient — no module reload needed.
afterEach(() => {
  vi.unstubAllEnvs();
});

const VALID_ENV = {
  STRIPE_CHECKOUT_KEY: "sk_test_abc123XYZ",
  STRIPE_TAX_RATE_ID: "txr_abc123",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_abc123",
  STRIPE_LIVEMODE: "false",
};

function stubValid() {
  for (const [name, value] of Object.entries(VALID_ENV)) vi.stubEnv(name, value);
}

/** The message getStripeEnv() throws, or "" when it does not throw. */
function errorMessage(): string {
  try {
    getStripeEnv();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
}

/** The error for a malformed or missing variable: it names the variable, never a value. */
const invalid = (...names: string[]) => `Invalid or missing Stripe environment variables: ${names.join(", ")}`;

/** The error for a key whose mode is not the STRIPE_LIVEMODE one. */
const MODE_MISMATCH = "Invalid Stripe environment variables: STRIPE_LIVEMODE does not match the API key's mode";

// ── PAY1B-AC41: accepts valid values ──────────────────────────────────────────

describe("PAY1B-AC41: getStripeEnv() accepts valid key shapes", () => {
  it("PAY1B-AC41a: accepts sk_test_ prefix; returns the values under neutral names (never the secret's variable name)", () => {
    stubValid();
    expect(getStripeEnv()).toEqual({
      checkoutKey: "sk_test_abc123XYZ",
      taxRateId: "txr_abc123",
      portalConfigurationId: "bpc_abc123",
      livemode: false,
    });
  });

  it("PAY1B-AC41b: accepts an rk_live_ key with STRIPE_LIVEMODE=true", () => {
    vi.stubEnv("STRIPE_CHECKOUT_KEY", "rk_live_XYZabc123");
    vi.stubEnv("STRIPE_TAX_RATE_ID", "txr_xyz456");
    vi.stubEnv("STRIPE_PORTAL_CONFIGURATION_ID", "bpc_xyz456");
    vi.stubEnv("STRIPE_LIVEMODE", "true");
    expect(getStripeEnv()).toEqual({
      checkoutKey: "rk_live_XYZabc123",
      taxRateId: "txr_xyz456",
      portalConfigurationId: "bpc_xyz456",
      livemode: true,
    });
  });

  it("PAY1B-AC41l: accepts an rk_test_ key with STRIPE_LIVEMODE=false", () => {
    stubValid();
    vi.stubEnv("STRIPE_CHECKOUT_KEY", "rk_test_XYZabc123");
    expect(getStripeEnv()).toMatchObject({ checkoutKey: "rk_test_XYZabc123", livemode: false });
  });
});

// ── PAY1B-AC41c (B12): a full live secret key is refused ─────────────────────

describe("PAY1B-AC41 (B12): a full secret key only in test mode", () => {
  it.each(["true", "false"])(
    "PAY1B-AC41c: rejects an sk_live_ key (STRIPE_LIVEMODE=%s); the error names STRIPE_CHECKOUT_KEY only",
    (livemode) => {
      stubValid();
      vi.stubEnv("STRIPE_CHECKOUT_KEY", "sk_live_XYZabc123");
      vi.stubEnv("STRIPE_LIVEMODE", livemode);
      expect(errorMessage()).toBe(invalid("STRIPE_CHECKOUT_KEY"));
    },
  );
});

// ── PAY1B-AC41: rejects missing vars ─────────────────────────────────────────

describe("PAY1B-AC41: getStripeEnv() throws when any var is absent; error names the var", () => {
  it.each([
    "STRIPE_CHECKOUT_KEY",
    "STRIPE_TAX_RATE_ID",
    "STRIPE_PORTAL_CONFIGURATION_ID",
    "STRIPE_LIVEMODE",
  ] as const)(
    "PAY1B-AC41d: throws naming %s (only) when absent",
    (varName) => {
      stubValid();
      vi.stubEnv(varName, undefined);
      expect(errorMessage()).toBe(invalid(varName));
    },
  );
});

// ── PAY1B-AC41: rejects malformed values ─────────────────────────────────────

describe("PAY1B-AC41: getStripeEnv() rejects malformed values; error names var, never value", () => {
  it("PAY1B-AC41e: rejects STRIPE_CHECKOUT_KEY without sk_/rk_ prefix", () => {
    stubValid();
    vi.stubEnv("STRIPE_CHECKOUT_KEY", "pk_test_wrongprefix");
    expect(errorMessage()).toBe(invalid("STRIPE_CHECKOUT_KEY"));
  });

  it("PAY1B-AC41f: rejects STRIPE_TAX_RATE_ID without txr_ prefix", () => {
    stubValid();
    vi.stubEnv("STRIPE_TAX_RATE_ID", "rate_bad");
    expect(errorMessage()).toBe(invalid("STRIPE_TAX_RATE_ID"));
  });

  it("PAY1B-AC41g: rejects STRIPE_PORTAL_CONFIGURATION_ID without bpc_ prefix", () => {
    stubValid();
    vi.stubEnv("STRIPE_PORTAL_CONFIGURATION_ID", "pconfig_bad");
    expect(errorMessage()).toBe(invalid("STRIPE_PORTAL_CONFIGURATION_ID"));
  });

  it("PAY1B-AC41h: error for malformed STRIPE_CHECKOUT_KEY names the var and never contains the value", () => {
    const badValue = "INVALID_VAL_7f3e9a";
    stubValid();
    vi.stubEnv("STRIPE_CHECKOUT_KEY", badValue);
    const message = errorMessage();
    expect(message).toContain("STRIPE_CHECKOUT_KEY");
    expect(message).not.toContain(badValue);
  });

  it.each(["TRUE", "True", "1", "0", "yes", "live", "", " false"])(
    "PAY1B-AC41m: rejects STRIPE_LIVEMODE=%j (only \"true\" or \"false\"), naming it only",
    (value) => {
      stubValid();
      vi.stubEnv("STRIPE_LIVEMODE", value);
      expect(errorMessage()).toBe(invalid("STRIPE_LIVEMODE"));
    },
  );
});

// ── PAY1B-AC41n (B14): the key's mode must be the STRIPE_LIVEMODE one ─────────

describe("PAY1B-AC41 (B14): STRIPE_LIVEMODE must match the key's mode", () => {
  it.each([
    ["a live key with STRIPE_LIVEMODE=false", "rk_live_XYZabc123", "false"],
    ["an sk_test_ key with STRIPE_LIVEMODE=true", "sk_test_XYZabc123", "true"],
    ["an rk_test_ key with STRIPE_LIVEMODE=true", "rk_test_XYZabc123", "true"],
  ])(
    "PAY1B-AC41n: throws on %s; the error names STRIPE_LIVEMODE and no value",
    (_label, key, livemode) => {
      stubValid();
      vi.stubEnv("STRIPE_CHECKOUT_KEY", key);
      vi.stubEnv("STRIPE_LIVEMODE", livemode);
      const message = errorMessage();
      expect(message).toBe(MODE_MISMATCH);
      expect(message).not.toContain(key);
    },
  );
});

// ── PAY1B-AC41: module-import safety ─────────────────────────────────────────

describe("PAY1B-AC41: @/config/stripe-env module import is safe with Stripe vars absent", () => {
  it("PAY1B-AC41i: dynamic re-import after resetModules with all Stripe vars absent does not throw", async () => {
    // Dynamic import required: testing that the module-level code (import-time)
    // does not call getStripeEnv() and throw when vars are absent (import safety).
    // Static import above already loaded the module; resetModules + dynamic
    // import gives a fresh load with the stubbed-absent env.
    vi.stubEnv("STRIPE_CHECKOUT_KEY", undefined);
    vi.stubEnv("STRIPE_TAX_RATE_ID", undefined);
    vi.stubEnv("STRIPE_PORTAL_CONFIGURATION_ID", undefined);
    vi.stubEnv("STRIPE_LIVEMODE", undefined);
    vi.resetModules();
    await expect(import("@/config/stripe-env")).resolves.toHaveProperty("getStripeEnv", expect.any(Function));
    vi.resetModules();
  });
});

// ── B10: Stripe config only in a server-only module ──────────────────────────

describe("PAY1B-AC41 (B10): the Stripe env lives only in the server-only src/config/stripe-env.ts", () => {
  it("PAY1B-AC41j: importing it outside React's server environment throws (import \"server-only\")", async () => {
    vi.doUnmock("server-only");
    vi.resetModules();
    try {
      await expect(import("@/config/stripe-env")).rejects.toThrow(
        "This module cannot be imported from a Client Component module.",
      );
    } finally {
      vi.doMock("server-only", () => ({}));
      vi.resetModules();
    }
  });

  it("PAY1B-AC41k: src/config/env.ts (also loaded by client components and the middleware) names no Stripe variable", () => {
    const src = readFileSync(resolve("src/config/env.ts"), "utf-8");
    expect(src).not.toContain("STRIPE_");
  });
});
