/**
 * Unit tests: next.config.mjs — CSP form-action: 'self' on every page, Stripe's
 * Checkout and Billing Portal added on the Monitor billing page only
 * (contract §9 as amended by B13).
 * Journey: payments-slice1b-billing  PAY1B-AC45
 *
 * Import the real next.config.mjs and run its header rules through Next's own
 * matchers: buildCustomRoute (the path regex Next writes to the routes manifest,
 * which OpenNext matches in the Worker) and matchHas (`^value$` against the
 * lowercased Host header without its port). When several matching rules set
 * the same header, the last one wins: Next (resolve-routes) and OpenNext
 * (getNextConfigHeaders) both assign the matching rules' headers in order.
 */
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, it, expect, vi } from "vitest";
import type { NextConfig } from "next";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import type { Header as HeaderRule } from "next/dist/lib/load-custom-routes";
import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";
import { MONITOR_HOME_PATH } from "@/config/monitor";
import { MONITOR_BILLING_PATH } from "@/config/payments";

vi.mock("next-intl/plugin", () => ({ default: () => (config: NextConfig) => config }));
vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }));

import nextConfig from "../../../next.config.mjs";

const SELF_FORM_ACTION = "form-action 'self'";
const BILLING_FORM_ACTION = "form-action 'self' https://checkout.stripe.com https://billing.stripe.com";
/** The Monitor host as a `has` host value (the same as the Monitor-host X-Robots-Tag rule's). */
const MONITOR_HOST_HAS = [{ type: "host", value: "monitor\\.(?:alnyron\\.dk|localhost)\\.?" }];

async function headerRules(): Promise<HeaderRule[]> {
  return (await nextConfig.headers?.()) ?? [];
}

/** The rule's Content-Security-Policy value, if it sets one. */
function cspOf(rule: HeaderRule): string | undefined {
  return rule.headers.find((header) => header.key === "Content-Security-Policy")?.value;
}

/** The rules that set a Content-Security-Policy, in config order. */
async function cspRules(): Promise<HeaderRule[]> {
  return (await headerRules()).filter((rule) => cspOf(rule) !== undefined);
}

function directives(csp: string): string[] {
  return csp.split(";").map((directive) => directive.trim());
}

function formActions(csp: string): string[] {
  return directives(csp).filter((directive) => directive.startsWith("form-action"));
}

/** The CSP a request for `path` on `host` gets: the last matching rule's value. */
async function effectiveCsp(host: string, path: string): Promise<string | undefined> {
  const request = new IncomingMessage(new Socket());
  request.headers.host = host;
  let csp: string | undefined;
  for (const rule of await headerRules()) {
    if (!new RegExp(buildCustomRoute("header", rule).regex).test(path)) continue;
    if (matchHas(request, {}, rule.has, rule.missing) === false) continue;
    csp = cspOf(rule) ?? csp;
  }
  return csp;
}

/** The global CSP and the billing page's, from the config. */
async function policies(): Promise<{ global: string; billing: string }> {
  const [global, billing] = (await cspRules()).map((rule) => cspOf(rule)!);
  return { global: global!, billing: billing! };
}

describe("PAY1B-AC45: CSP form-action is 'self' everywhere; Stripe is added on the Monitor billing page only (B13)", () => {
  it(
    "PAY1B-AC45a: three rules set the CSP, in this order: the catch-all (every path, every host), " +
      "/monitor/billing (every host), /billing on the Monitor host",
    async () => {
      const rules = await headerRules();
      const positions = rules.flatMap((rule, index) => (cspOf(rule) === undefined ? [] : [index]));
      // The catch-all comes first, so the billing rules win on the shared header key.
      expect(positions.map((index) => ({ source: rules[index]!.source, has: rules[index]!.has }))).toEqual([
        { source: "/:path*", has: undefined },
        { source: "/monitor/billing", has: undefined },
        { source: "/billing", has: MONITOR_HOST_HAS },
      ]);
      expect(positions[0]).toBe(0);
    },
  );

  it("PAY1B-AC45b: the catch-all CSP's only form-action is exactly form-action 'self'", async () => {
    const { global } = await policies();
    expect(formActions(global)).toEqual([SELF_FORM_ACTION]);
  });

  it(
    "PAY1B-AC45c: both billing rules send the same CSP, whose only form-action is exactly " +
      "'self' https://checkout.stripe.com https://billing.stripe.com, and set no other header",
    async () => {
      const [, ...billingRules] = await cspRules();
      expect(billingRules).toHaveLength(2);
      for (const rule of billingRules) {
        expect(rule.headers.map(({ key }) => key)).toEqual(["Content-Security-Policy"]);
        expect(formActions(cspOf(rule)!)).toEqual([BILLING_FORM_ACTION]);
      }
      expect(cspOf(billingRules[0]!)).toBe(cspOf(billingRules[1]!));
    },
  );

  it("PAY1B-AC45d: every other directive is identical between the two policies, in the same order", async () => {
    const { global, billing } = await policies();
    expect(directives(billing).map((directive) => (directive === BILLING_FORM_ACTION ? SELF_FORM_ACTION : directive)))
      .toEqual(directives(global));
    expect(directives(billing)).toHaveLength(directives(global).length);
  });

  it.each([
    ["monitor.localhost:3000", "/monitor/billing"],
    ["monitor.alnyron.dk", "/monitor/billing"],
    ["monitor.localhost:3000", "/billing"],
    ["monitor.alnyron.dk", "/billing"],
    ["MONITOR.ALNYRON.DK", "/billing"],
    ["monitor.alnyron.dk.", "/billing"],
    ["monitor.alnyron.dk:443", "/billing"],
    // The main host only redirects /monitor/* to the Monitor host; the rule has no host condition.
    ["alnyron.dk", "/monitor/billing"],
  ])("PAY1B-AC45e: a request on %s for %s gets the billing page's CSP", async (host, path) => {
    const { billing } = await policies();
    await expect(effectiveCsp(host, path)).resolves.toBe(billing);
  });

  it.each([
    ["monitor.alnyron.dk", "/"],
    ["monitor.alnyron.dk", "/dashboard"],
    ["monitor.localhost:3000", "/monitor/dashboard"],
    ["monitor.localhost:3000", "/monitor/settings"],
    ["monitor.alnyron.dk", "/monitor/billing/extra"],
    ["monitor.alnyron.dk", "/billing/extra"],
    ["monitor.alnyron.dk", "/monitor/billingx"],
    ["alnyron.dk", "/billing"],
    ["localhost:3000", "/billing"],
    ["evil-monitor.alnyron.dk", "/billing"],
    ["monitor.alnyron.dk.evil.com", "/billing"],
    ["alnyron.dk", "/"],
    ["alnyron.dk", "/admin/pages"],
  ])("PAY1B-AC45f: a request on %s for %s gets the catch-all CSP (form-action 'self')", async (host, path) => {
    const { global } = await policies();
    await expect(effectiveCsp(host, path)).resolves.toBe(global);
  });

  it(
    "PAY1B-AC45g: the billing rules name the billing page's own paths and the Monitor host " +
      "exactly as the Monitor-host X-Robots-Tag rule does",
    async () => {
      const [, pathRule, hostRule] = await cspRules();
      expect(pathRule!.source).toBe(MONITOR_BILLING_PATH);
      expect(hostRule!.source).toBe(MONITOR_BILLING_PATH.slice(MONITOR_HOME_PATH.length));
      const robotsOnMonitorHost = (await headerRules()).find(
        (rule) =>
          rule.source === "/:path*" &&
          rule.headers.some(({ key }) => key === "X-Robots-Tag") &&
          rule.has?.some((condition) => condition.type === "host" && condition.value?.startsWith("monitor")),
      );
      expect(robotsOnMonitorHost?.has).toEqual(hostRule!.has);
    },
  );
});
