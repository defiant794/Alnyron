/**
 * Unit tests: S2 config pins
 * Journey: payments-s2-3d-purchase
 * Criteria: contract §0, §3, §4.4
 *
 * Test IDs: S2-T-CFG-01..07
 *
 * Contract §0 / §4.4:
 *   - ADMIN_ORDERS_PATH = '/admin/orders' in src/config/admin.ts
 *   - RESERVED_ROUTE_SLUGS includes 'order' in src/config/catalog.ts
 *   - root wrangler.jsonc has ORDERS service binding to alnyron-payments/OrderService
 *   - src/global.d.ts ORDERS type (CloudflareEnv.ORDERS)
 *   - workers/payments/wrangler.jsonc vars: ORDER_NOTIFY_TO, STRIPE_TAX_RATE_ID
 *   - ORDER_LINK_SECRET has no committed value in tracked files (never on alnyron-web)
 *   - payments wrangler.jsonc JSONC parses without errors
 *
 * Follows tests/unit/config/wrangler-withdrawal.test.ts pattern exactly:
 * readJsonc with jsonc-parser; ORDERS binding added next to the PAYMENTS case.
 */
import { describe, it, expect, expectTypeOf, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonc(rel: string): { config: Record<string, unknown>; errors: ParseError[] } {
  const text = readFileSync(resolve(process.cwd(), rel), "utf-8");
  const errors: ParseError[] = [];
  const config = parse(text, errors) as Record<string, unknown>;
  return { config, errors };
}

// ── S2-T-CFG-01: ADMIN_ORDERS_PATH = '/admin/orders' ─────────────────────

describe("S2-T-CFG-01: ADMIN_ORDERS_PATH is '/admin/orders'", () => {
  it("S2-T-CFG-01: ADMIN_ORDERS_PATH equals '/admin/orders'", async () => {
    const { ADMIN_ORDERS_PATH } = await import("@/config/admin");
    expect(ADMIN_ORDERS_PATH).toBe("/admin/orders");
  });
});

// ── S2-T-CFG-02: RESERVED_ROUTE_SLUGS includes 'order' ───────────────────

describe("S2-T-CFG-02: RESERVED_ROUTE_SLUGS includes 'order'", () => {
  it("S2-T-CFG-02: 'order' is in the RESERVED_ROUTE_SLUGS array", async () => {
    const { RESERVED_ROUTE_SLUGS } = await import("@/config/catalog");
    expect(RESERVED_ROUTE_SLUGS).toContain("order");
  });
});

// ── S2-T-CFG-03: root wrangler.jsonc ORDERS service binding ──────────────

describe("S2-T-CFG-03: root wrangler.jsonc — ORDERS binding to alnyron-payments/OrderService", () => {
  let config: Record<string, unknown>;
  let errors: ParseError[];

  beforeAll(() => {
    ({ config, errors } = readJsonc("wrangler.jsonc"));
  });

  it("S2-T-CFG-03a: root wrangler.jsonc parses without errors", () => {
    expect(errors).toHaveLength(0);
  });

  it("S2-T-CFG-03b: services contains ORDERS binding to alnyron-payments with entrypoint OrderService", () => {
    const services = config["services"] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(services)).toBe(true);
    const ordersBinding = services?.find((s) => s["binding"] === "ORDERS");
    expect(ordersBinding, "ORDERS service binding must exist").toBeDefined();
    expect(ordersBinding?.["service"]).toBe("alnyron-payments");
    expect(ordersBinding?.["entrypoint"]).toBe("OrderService");
  });
});

// ── S2-T-CFG-04: global.d.ts ORDERS type ─────────────────────────────────

describe("S2-T-CFG-04: src/global.d.ts — CloudflareEnv.ORDERS type", () => {
  it("S2-T-CFG-04: CloudflareEnv.ORDERS is optional with startCheckout and withdraw", () => {
    // Type-level check: enforced by `npm run typecheck`.
    type OrdersType = CloudflareEnv["ORDERS"];
    // The binding must be optional (absent when wrangler config lacks it)
    type IsOptional = undefined extends OrdersType ? true : false;
    const check: IsOptional = true;
    expect(check).toBe(true);
    // The methods must exist on the non-undefined type
    type Methods = NonNullable<OrdersType>;
    expectTypeOf<Methods["startCheckout"]>().toBeFunction();
    expectTypeOf<Methods["withdraw"]>().toBeFunction();
  });
});

// ── S2-T-CFG-05: workers/payments/wrangler.jsonc — ORDER_NOTIFY_TO + STRIPE_TAX_RATE_ID

describe("S2-T-CFG-05: workers/payments/wrangler.jsonc — ORDER_NOTIFY_TO and STRIPE_TAX_RATE_ID vars", () => {
  let config: Record<string, unknown>;
  let errors: ParseError[];

  beforeAll(() => {
    ({ config, errors } = readJsonc("workers/payments/wrangler.jsonc"));
  });

  it("S2-T-CFG-05a: workers/payments/wrangler.jsonc parses without errors", () => {
    expect(errors).toHaveLength(0);
  });

  it("S2-T-CFG-05b: vars contains ORDER_NOTIFY_TO", () => {
    const vars = config["vars"] as Record<string, unknown> | undefined;
    expect(vars).toBeDefined();
    expect(vars).toHaveProperty("ORDER_NOTIFY_TO");
    // Value is a non-empty string (default: info@alnyron.dk)
    expect(typeof vars?.["ORDER_NOTIFY_TO"]).toBe("string");
    expect((vars?.["ORDER_NOTIFY_TO"] as string).length).toBeGreaterThan(0);
  });

  it("S2-T-CFG-05c: vars contains STRIPE_TAX_RATE_ID", () => {
    const vars = config["vars"] as Record<string, unknown> | undefined;
    expect(vars).toHaveProperty("STRIPE_TAX_RATE_ID");
    expect(typeof vars?.["STRIPE_TAX_RATE_ID"]).toBe("string");
    expect((vars?.["STRIPE_TAX_RATE_ID"] as string)).toMatch(/^txr_/);
  });
});

// ── S2-T-CFG-06: ORDER_LINK_SECRET has no committed value in tracked files ─

/**
 * An assigned ORDER_LINK_SECRET value on the key's own line: a quoted literal of 8 or more
 * characters, or an unquoted one (an env file, YAML) that runs to the end of the line. A schema
 * or variable beside the key (`ORDER_LINK_SECRET: z.string()…,`, `ORDER_LINK_SECRET: LINK_FX,`)
 * and an empty `ORDER_LINK_SECRET=` are no value; nothing on the next line counts.
 */
const ASSIGNED_SECRET_PATTERN =
  /ORDER_LINK_SECRET["'`]?[ \t]*[=:][ \t]*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|`[^`\r\n]{8,}`|[^\s"'`(){}[\],;]{8,}[ \t]*\r?$)/m;

describe("S2-T-CFG-06: ORDER_LINK_SECRET — no committed value in tracked files (contract §0)", () => {
  it("S2-T-CFG-06a: ORDER_LINK_SECRET has no assigned value in root wrangler.jsonc vars", () => {
    const { config } = readJsonc("wrangler.jsonc");
    const vars = config["vars"] as Record<string, unknown> | undefined;
    // ORDER_LINK_SECRET must NOT be in the web app's wrangler.jsonc (never on alnyron-web)
    expect(vars).not.toHaveProperty("ORDER_LINK_SECRET");
  });

  it("S2-T-CFG-06b: ORDER_LINK_SECRET has no assigned value in workers/payments/wrangler.jsonc vars", () => {
    const { config } = readJsonc("workers/payments/wrangler.jsonc");
    const vars = config["vars"] as Record<string, unknown> | undefined;
    // Secret values live in `wrangler secret put`, never in vars
    expect(vars).not.toHaveProperty("ORDER_LINK_SECRET");
  });

  it("S2-T-CFG-06c: no git-tracked file contains an assigned ORDER_LINK_SECRET value (≥8 chars)", () => {
    // Use git ls-files to scope to tracked files only (avoids .dev.vars, .next/, etc.)
    const trackedFiles = execSync("git ls-files", { cwd: process.cwd() })
      .toString()
      .trim()
      .split("\n")
      .filter((f) => !f.includes(".dev.vars")); // e2e generator fills this locally

    const matches: string[] = [];
    for (const file of trackedFiles) {
      let text: string;
      try {
        text = readFileSync(resolve(process.cwd(), file), "utf-8");
      } catch {
        continue;
      }
      if (ASSIGNED_SECRET_PATTERN.test(text)) {
        matches.push(file);
      }
    }
    expect(
      matches,
      `Found ORDER_LINK_SECRET value committed in: ${matches.join(", ")}`,
    ).toHaveLength(0);
  });

  // The key comes from a constant, so this file's own source holds no assigned value (S2-T-CFG-06c).
  const KEY = "ORDER_LINK_SECRET";

  it.each([
    ["an env-file line", `${KEY}=abcdefgh12345678\nORDER_NOTIFY_TO=a@b.dk\n`],
    ["an env-file line with CRLF", `${KEY}=abcdefgh12345678\r\nORDER_NOTIFY_TO=a@b.dk\r\n`],
    ["a YAML value", `  ${KEY}: abcdefgh12345678\n`],
    ["a JSON string", `{"${KEY}": "abcdefgh12345678"}`],
    ["a quoted JS value", `const env = { ${KEY}: 'abcdefgh12345678', X: 1 };`],
  ])("S2-T-CFG-06d: %s is an assigned value", (_, text) => {
    expect(ASSIGNED_SECRET_PATTERN.test(text)).toBe(true);
  });

  it.each([
    ["a schema beside the key", "  ORDER_LINK_SECRET: z.string().check(z.regex(/^\\S{32,256}$/)),\n"],
    ["a variable beside the key", "const ENV = { ORDER_LINK_SECRET: LINK_FX, ORDER_NOTIFY_TO: \"x@y.dk\" };"],
    ["an undefined override", "await runSweep(CONFIG, { ...ENV, ORDER_LINK_SECRET: undefined });"],
    ["an empty env line before the next key", "ORDER_LINK_SECRET=\nORDER_NOTIFY_TO=delivered+orders@resend.dev\n"],
    ["a README table row", "| `ORDER_LINK_SECRET` | secret: `npx wrangler secret put ORDER_LINK_SECRET --config x` |"],
  ])("S2-T-CFG-06d: %s is no value", (_, text) => {
    expect(ASSIGNED_SECRET_PATTERN.test(text)).toBe(false);
  });
});

// ── S2-T-CFG-07: GOODS_TEXT_VERSION + GOODS_ORDER_KIND + PAYMENTS_SWEEP_ORDER_SUBREQUESTS

describe("S2-T-CFG-07: payments config constants", () => {
  it("GOODS_ORDER_KIND = 'goods_order'", async () => {
    const { GOODS_ORDER_KIND } = await import("@/config/payments");
    expect(GOODS_ORDER_KIND).toBe("goods_order");
  });

  it("PAYMENTS_SWEEP_ORDER_SUBREQUESTS = 12", async () => {
    const { PAYMENTS_SWEEP_ORDER_SUBREQUESTS } = await import("@/config/payments");
    expect(PAYMENTS_SWEEP_ORDER_SUBREQUESTS).toBe(12);
  });

  it("GOODS_TEXT_VERSION = 'goods-2026-11-14.1'", async () => {
    const { GOODS_TEXT_VERSION } = await import("@/config/legal/goods-texts");
    expect(GOODS_TEXT_VERSION).toBe("goods-2026-11-14.1");
  });

  it("OFFER_PRICE_MIN_ORE = 250", async () => {
    const { OFFER_PRICE_MIN_ORE } = await import("@/config/payments");
    expect(OFFER_PRICE_MIN_ORE).toBe(250);
  });

  it("OFFER_PRICE_MAX_ORE = 5000000", async () => {
    const { OFFER_PRICE_MAX_ORE } = await import("@/config/payments");
    expect(OFFER_PRICE_MAX_ORE).toBe(5_000_000);
  });
});
