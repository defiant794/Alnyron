/**
 * Unit tests: wrangler config pins for slice 1d
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J7-C01
 *
 * Coverage:
 *   - workers/payments/wrangler.jsonc: triggers.crons includes "0 * * * *"
 *   - root wrangler.jsonc: services array contains PAYMENTS binding to alnyron-payments
 *       with entrypoint "WithdrawalService"
 *   - src/global.d.ts: PAYMENTS binding declared (optional, correct type; a type-level check
 *       that `npm run typecheck` enforces)
 */
import { describe, it, expect, expectTypeOf, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type { WithdrawInput } from "@/lib/payments/withdrawal-contract";

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonc(rel: string): { config: Record<string, unknown>; errors: ParseError[] } {
  const text = readFileSync(resolve(process.cwd(), rel), "utf-8");
  const errors: ParseError[] = [];
  const config = parse(text, errors) as Record<string, unknown>;
  return { config, errors };
}

// ── WD-J7-C01 (WD-T-CFG-01): payments worker cron trigger ────────────────────

describe("WD-J7-C01 (WD-T-CFG-01): workers/payments/wrangler.jsonc — triggers.crons includes '0 * * * *'", () => {
  let config: Record<string, unknown>;
  let errors: ParseError[];

  beforeAll(() => {
    ({ config, errors } = readJsonc("workers/payments/wrangler.jsonc"));
  });

  it("WD-T-CFG-01a: jsonc parses without errors", () => {
    expect(errors).toHaveLength(0);
  });

  it("WD-T-CFG-01b: triggers.crons contains exactly '0 * * * *' (run hourly at minute 0)", () => {
    const triggers = config["triggers"] as Record<string, unknown> | undefined;
    const crons = triggers?.["crons"];
    expect(Array.isArray(crons)).toBe(true);
    expect(crons).toContain("0 * * * *");
  });
});

// ── PAYMENTS service binding in root wrangler.jsonc ──────────────────────────

describe("WD-J4-C03: root wrangler.jsonc — services contains PAYMENTS binding to WithdrawalService", () => {
  let config: Record<string, unknown>;
  let errors: ParseError[];

  beforeAll(() => {
    ({ config, errors } = readJsonc("wrangler.jsonc"));
  });

  it("WD-T-CFG-02a: root wrangler.jsonc parses without errors", () => {
    expect(errors).toHaveLength(0);
  });

  it("WD-T-CFG-02b: services array contains PAYMENTS binding to alnyron-payments with entrypoint WithdrawalService", () => {
    const services = config["services"] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(services)).toBe(true);
    const paymentsBinding = services?.find((s) => s["binding"] === "PAYMENTS");
    expect(paymentsBinding).toBeDefined();
    expect(paymentsBinding?.["service"]).toBe("alnyron-payments");
    expect(paymentsBinding?.["entrypoint"]).toBe("WithdrawalService");
  });
});

// ── src/global.d.ts PAYMENTS type ────────────────────────────────────────────

describe("WD-J4-C03: src/global.d.ts — PAYMENTS binding declared as optional CloudflareEnv property", () => {
  it("WD-T-CFG-03: CloudflareEnv.PAYMENTS is optional; withdraw takes a WithdrawInput and answers unknown", () => {
    expectTypeOf<CloudflareEnv["PAYMENTS"]>().toEqualTypeOf<
      { withdraw(input: WithdrawInput): Promise<unknown> } | undefined
    >();
  });
});
