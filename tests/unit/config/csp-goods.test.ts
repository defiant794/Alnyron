/**
 * Unit tests: next.config.mjs — CSP form-action on public item pages
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-CSP-1..5
 *
 * Test IDs: S2-T-CSP-01..05
 *
 * Contract §3:
 *   - Public item paths /:section/:item and /en/:section/:item on the main host
 *     (section NOT in admin|auth|api|monitor|mylife|order|en|da) get:
 *       form-action 'self' https://checkout.stripe.com
 *   - Admin/auth/api/order and all other paths keep form-action 'self'
 *   - Monitor and MyLife hosts: the goods-checkout rule does NOT apply (missing host conditions)
 *   - Billing page (Monitor host and /monitor/billing): the billing Stripe CSP rule unchanged
 *
 * Uses effectiveCsp(host, path) — not positional array index — so the
 * billing rule and the goods rule can be inserted in any order.
 */
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, it, expect, vi } from "vitest";
import type { NextConfig } from "next";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import type { Header as HeaderRule } from "next/dist/lib/load-custom-routes";
import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";

vi.mock("next-intl/plugin", () => ({ default: () => (config: NextConfig) => config }));
vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }));

import nextConfig from "../../../next.config.mjs";

const SITE_HOST = "alnyron.dk";
const MONITOR_HOST = "monitor.alnyron.dk";
const MYLIFE_HOST = "mylife.alnyron.dk";

/** The exact goods form-action directive the item page rule must produce. */
const GOODS_FORM_ACTION = "form-action 'self' https://checkout.stripe.com";

/** Every other page's form-action (the global rule). */
const SELF_FORM_ACTION = "form-action 'self'";

/** The existing billing form-action (unchanged by S2). */
const BILLING_FORM_ACTION =
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com";

function formActionOf(csp: string): string | undefined {
  return csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("form-action"));
}

async function headerRules(): Promise<HeaderRule[]> {
  return (await nextConfig.headers?.()) ?? [];
}

/** The effective CSP for a request on host:path (last matching rule wins). */
async function effectiveCsp(host: string, path: string): Promise<string | undefined> {
  const request = new IncomingMessage(new Socket());
  request.headers.host = host;
  let csp: string | undefined;
  for (const rule of await headerRules()) {
    if (!new RegExp(buildCustomRoute("header", rule).regex).test(path)) continue;
    if (matchHas(request, {}, rule.has, rule.missing) === false) continue;
    const ruleCsp = rule.headers.find((h) => h.key === "Content-Security-Policy")?.value;
    if (ruleCsp !== undefined) csp = ruleCsp;
  }
  return csp;
}

// ── S2-T-CSP-01: public item path DA → goods form-action ─────────────────

describe("S2-T-CSP-01: /:section/:item on main host → form-action 'self' https://checkout.stripe.com", () => {
  it.each([
    "/figurer/drage-12-cm",
    "/modeller/ugle-8-cm",
    "/apps/my-app",
    "/websites/my-site",
  ])("main host %s gets exactly the goods form-action", async (path) => {
    const csp = await effectiveCsp(SITE_HOST, path);
    expect(csp, `CSP must be set for ${path}`).toBeDefined();
    expect(formActionOf(csp!)).toBe(GOODS_FORM_ACTION);
  });
});

// ── S2-T-CSP-02: public item path EN → goods form-action ─────────────────

describe("S2-T-CSP-02: /en/:section/:item on main host → goods form-action", () => {
  it.each([
    "/en/figures/dragon-12-cm",
    "/en/models/owl-8-cm",
  ])("main host %s gets exactly the goods form-action", async (path) => {
    const csp = await effectiveCsp(SITE_HOST, path);
    expect(csp, `CSP must be set for ${path}`).toBeDefined();
    expect(formActionOf(csp!)).toBe(GOODS_FORM_ACTION);
  });
});

// ── S2-T-CSP-03: admin/auth/api/order paths → self only ──────────────────

describe("S2-T-CSP-03: reserved paths keep form-action 'self' (no checkout.stripe.com)", () => {
  it.each([
    [SITE_HOST, "/admin/orders"],
    [SITE_HOST, "/admin/catalog"],
    [SITE_HOST, "/auth/login"],
    [SITE_HOST, "/api/checkout/item"],
    [SITE_HOST, "/order/error"],
    [SITE_HOST, "/order/withdraw"],
    [SITE_HOST, "/order/thanks"],
    [SITE_HOST, "/en/admin"],
    // Single-segment paths (pages, not items)
    [SITE_HOST, "/figurer"],
    [SITE_HOST, "/kontakt"],
  ])("%s %s → exactly form-action 'self'", async (host, path) => {
    expect(formActionOf((await effectiveCsp(host, path)) ?? "")).toBe(SELF_FORM_ACTION);
  });
});

// ── S2-T-CSP-04: Monitor and MyLife hosts — goods rule does NOT apply ────

describe("S2-T-CSP-04: Monitor and MyLife hosts — goods-checkout rule does not apply (missing host condition)", () => {
  it.each([MONITOR_HOST, MYLIFE_HOST])("%s /:section/:item keeps exactly form-action 'self'", async (host) => {
    expect(formActionOf((await effectiveCsp(host, "/figurer/drage-12-cm")) ?? "")).toBe(SELF_FORM_ACTION);
  });
});

// ── S2-T-CSP-05: billing page unchanged ──────────────────────────────────

describe("S2-T-CSP-05: Monitor billing page — existing Stripe billing CSP rule unchanged", () => {
  it.each([
    [MONITOR_HOST, "/billing"],
    [SITE_HOST, "/monitor/billing"],
  ])("%s %s keeps exactly the billing form-action", async (host, path) => {
    expect(formActionOf((await effectiveCsp(host, path)) ?? "")).toBe(BILLING_FORM_ACTION);
  });
});
