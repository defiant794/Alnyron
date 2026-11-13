/**
 * Unit tests: src/config/payments.ts — payment constants.
 * Journey: payments-slice1b-billing  PAY1B-AC40, PAY1B-AC50 (rate limit, amendment B11)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { describe, it, expect } from "vitest";
import {
  MONITOR_BILLING_PATH,
  BILLING_CHECKOUT_DONE,
  BILLING_DEFAULT_INTERVAL,
  BILLING_ERROR_CHECKOUT,
  BILLING_ERROR_PORTAL,
  BILLING_INTERVALS,
  BILLING_RATE_LIMIT,
  BILLING_RATE_PERIOD_SECONDS,
  SUBSCRIPTION_ENDED_STATUSES,
  SUBSCRIPTION_ENTITLING_STATUSES,
  CHECKOUT_SESSION_TTL_SECONDS,
  STRIPE_REQUEST_TIMEOUT_MS,
} from "@/config/payments";

// ── PAY1B-AC40: pin every constant literal ────────────────────────────────────

describe("PAY1B-AC40: payments config constants are pinned to spec §1 values", () => {
  it("PAY1B-AC40a: MONITOR_BILLING_PATH = '/monitor/billing'", () => {
    expect(MONITOR_BILLING_PATH).toBe("/monitor/billing");
  });

  it("PAY1B-AC40b: BILLING_CHECKOUT_DONE = 'done'", () => {
    expect(BILLING_CHECKOUT_DONE).toBe("done");
  });

  it("PAY1B-AC40c: BILLING_ERROR_CHECKOUT = 'checkout'", () => {
    expect(BILLING_ERROR_CHECKOUT).toBe("checkout");
  });

  it("PAY1B-AC40d: BILLING_ERROR_PORTAL = 'portal'", () => {
    expect(BILLING_ERROR_PORTAL).toBe("portal");
  });

  it("PAY1B-AC40e: BILLING_INTERVALS = ['month', 'year'] (readonly tuple)", () => {
    expect(BILLING_INTERVALS).toEqual(["month", "year"]);
  });

  it("PAY1B-AC40f: default interval BILLING_DEFAULT_INTERVAL = 'year'", () => {
    expect(BILLING_DEFAULT_INTERVAL).toBe("year");
  });

  it("PAY1B-AC40g: SUBSCRIPTION_ENDED_STATUSES = ['canceled', 'incomplete_expired']", () => {
    expect(SUBSCRIPTION_ENDED_STATUSES).toEqual(["canceled", "incomplete_expired"]);
  });

  it("PAY1B-AC40h: SUBSCRIPTION_ENTITLING_STATUSES = ['trialing', 'active', 'past_due']", () => {
    expect(SUBSCRIPTION_ENTITLING_STATUSES).toEqual(["trialing", "active", "past_due"]);
  });

  it("PAY1B-AC40i: CHECKOUT_SESSION_TTL_SECONDS = 1860 (31 * 60)", () => {
    expect(CHECKOUT_SESSION_TTL_SECONDS).toBe(1860);
    // Verify 31 * 60 — Stripe requires ≥ 30 min + 1 min margin
    expect(CHECKOUT_SESSION_TTL_SECONDS).toBe(31 * 60);
  });

  it("PAY1B-AC40j: STRIPE_REQUEST_TIMEOUT_MS = 10_000", () => {
    expect(STRIPE_REQUEST_TIMEOUT_MS).toBe(10_000);
  });
});

// ── PAY1B-AC50: the billing rate limit (B11) ──────────────────────────────────

type RateLimitBinding = { name: string; namespace_id: string; simple: { limit: number; period: number } };

describe("PAY1B-AC50: the billing rate limit is 10 per 60 s, in the config and in wrangler.jsonc", () => {
  it("PAY1B-AC40k/PAY1B-AC50d: BILLING_RATE_LIMIT = 10, BILLING_RATE_PERIOD_SECONDS = 60", () => {
    expect(BILLING_RATE_LIMIT).toBe(10);
    expect(BILLING_RATE_PERIOD_SECONDS).toBe(60);
  });

  it(
    "PAY1B-AC50e: wrangler.jsonc has exactly one ratelimits binding, BILLING_RATE_LIMITER, whose " +
      "simple limit and period are those two constants (period 10 or 60, namespace_id an integer string)",
    () => {
      const errors: ParseError[] = [];
      const config = parse(readFileSync(resolve("wrangler.jsonc"), "utf-8"), errors, {
        allowTrailingComma: true,
      }) as { ratelimits?: RateLimitBinding[] };
      expect(errors).toEqual([]);
      expect(config.ratelimits).toEqual([
        {
          name: "BILLING_RATE_LIMITER",
          namespace_id: expect.stringMatching(/^[1-9]\d*$/),
          simple: { limit: BILLING_RATE_LIMIT, period: BILLING_RATE_PERIOD_SECONDS },
        },
      ]);
      expect([10, 60]).toContain(BILLING_RATE_PERIOD_SECONDS);
    },
  );
});
