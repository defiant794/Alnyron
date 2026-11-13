/**
 * Unit tests: src/app/monitor/(panel)/billing/actions.ts — billing server actions.
 * Journey: payments-slice1b-billing
 *   PAY1B-AC07, PAY1B-AC08, PAY1B-AC09, PAY1B-AC10, PAY1B-AC11, PAY1B-AC21,
 *   PAY1B-AC22, PAY1B-AC25, PAY1B-AC26, PAY1B-AC27, PAY1B-AC28, PAY1B-AC32,
 *   PAY1B-AC50 (per-user rate limit, amendment B11)
 *
 * @/lib/payments/stripe and @/lib/payments/checkout-params are intentionally
 * NOT mocked here: the success body-fields test (PAY1B-AC10/PAY1B-AC11) needs
 * the real encodeStripeForm to run so we can assert the actual encoded
 * URLSearchParams sent to Stripe — contract §6.
 * All Stripe network calls are controlled via vi.stubGlobal("fetch", …).
 * @/lib/payments/rate-limit is not mocked either: the Cloudflare context it
 * reads the BILLING_RATE_LIMITER binding from is (getCloudflareContext).
 */
import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type * as EnvModule from "@/config/env";

// ── vi.hoisted — mock factories ───────────────────────────────────────────────

const {
  mockRequireMonitor,
  mockGetCurrentSubscription,
  mockGetMonitorPlanByInterval,
  mockGetBillingCustomerId,
  mockGetMonitorLocale,
  mockParseSiteEnv,
  mockGetStripeEnv,
  mockRedirect,
  mockGetCloudflareContext,
  mockLimit,
} = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(),
  mockGetCurrentSubscription: vi.fn(),
  mockGetMonitorPlanByInterval: vi.fn(),
  mockGetBillingCustomerId: vi.fn(),
  mockGetMonitorLocale: vi.fn(),
  mockParseSiteEnv: vi.fn(),
  mockGetStripeEnv: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  mockGetCloudflareContext: vi.fn(),
  mockLimit: vi.fn(),
}));

vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
vi.mock("@/services/payments/billing", () => ({
  getCurrentSubscription: mockGetCurrentSubscription,
  getMonitorPlanByInterval: mockGetMonitorPlanByInterval,
  getBillingCustomerId: mockGetBillingCustomerId,
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/i18n/monitor-locale", () => ({ getMonitorLocale: mockGetMonitorLocale }));
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  parseSiteEnv: mockParseSiteEnv,
}));
// The server-only Stripe env module (B10), replaced whole: its `import "server-only"` never loads.
vi.mock("@/config/stripe-env", () => ({ getStripeEnv: mockGetStripeEnv }));
// The Worker's bindings (B11): BILLING_RATE_LIMITER is the rate limiter whose `limit` is mockLimit.
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: mockGetCloudflareContext }));
// PAY1B-AC32: next/headers is mocked to return evil Host/origin headers.
// A correct implementation reads origin from parseSiteEnv(), not from these headers.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({
    host: "evil.example.com",
    origin: "https://evil.example.com",
    "x-forwarded-host": "evil.example.com",
  })),
}));

// @/lib/payments/stripe and @/lib/payments/checkout-params are NOT mocked —
// the real helpers run so the fetch body encoding can be asserted.

import { startSubscriptionCheckout, openBillingPortal } from "@/app/monitor/(panel)/billing/actions";

// ── Fixtures ──────────────────────────────────────────────────────────────────

type FetchArgs = [string | URL | Request, RequestInit?];

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const SESSION = {
  userId: "00000000-0000-0000-0000-000000000099",
  email: "sub@test.local",
  role: "monitor_user" as const,
};

const PLAN_YEAR = {
  id: "plan-yr-uuid",
  stripePriceId: "price_yr_test123",
  interval: "year" as const,
  monitorLimit: 20,
  amountOre: 9500,
  name: "Monitor Plus",
};

const PLAN_MONTH = {
  id: "plan-mo-uuid",
  stripePriceId: "price_mo_test123",
  interval: "month" as const,
  monitorLimit: 20,
  amountOre: 1000,
  name: "Monitor Plus",
};

const STRIPE_ENV = {
  checkoutKey: "sk_test_unit_key_abc",
  taxRateId: "txr_unit_test123",
  portalConfigurationId: "bpc_unit_test123",
  livemode: false,
};

// parseSiteEnv returns http://localhost:3000; monitorSiteOrigin maps this to
// http://monitor.localhost:3000 (the Monitor subdomain origin).
const MONITOR_ORIGIN = "http://monitor.localhost:3000";

function checkoutResponse(id = "cs_test_unit_x", url = `https://checkout.stripe.com/c/pay/${id}`) {
  return new Response(JSON.stringify({ id, url }), { status: 200 });
}

function portalResponse(url = "https://billing.stripe.com/p/session/test_unitportal") {
  return new Response(JSON.stringify({ url }), { status: 200 });
}

function stripeErrorResponse(code: string, status = 402) {
  return new Response(
    JSON.stringify({ error: { code, type: "card_error", message: "Test error" } }),
    { status },
  );
}

/** Create a typed fetch mock and stub it globally. Returns the mock for assertion. */
function stubFetch(impl: (...args: FetchArgs) => Promise<Response>): MockInstance {
  const mockFetch = vi.fn(impl);
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMonitor.mockResolvedValue(SESSION);
  mockGetCurrentSubscription.mockResolvedValue(null);
  mockGetMonitorPlanByInterval.mockResolvedValue(PLAN_YEAR);
  mockGetBillingCustomerId.mockResolvedValue(null);
  mockGetMonitorLocale.mockResolvedValue("da");
  mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
  mockGetStripeEnv.mockReturnValue(STRIPE_ENV);
  mockLimit.mockResolvedValue({ success: true });
  mockGetCloudflareContext.mockReturnValue({ env: { BILLING_RATE_LIMITER: { limit: mockLimit } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── PAY1B-AC08: requireMonitor called first ───────────────────────────────────

describe("PAY1B-AC08: requireMonitor is called first; its redirect stops everything", () => {
  it("PAY1B-AC08a: startSubscriptionCheckout calls requireMonitor", async () => {
    stubFetch(async () => checkoutResponse());
    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow("NEXT_REDIRECT:");
    expect(mockRequireMonitor).toHaveBeenCalledTimes(1);
  });

  it("PAY1B-AC08b: requireMonitor redirect propagates — no service calls run", async () => {
    mockRequireMonitor.mockRejectedValue(new Error("NEXT_REDIRECT:/monitor/no-access"));
    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/no-access",
    );
    expect(mockGetCurrentSubscription).not.toHaveBeenCalled();
    expect(mockGetMonitorPlanByInterval).not.toHaveBeenCalled();
    expect(mockGetStripeEnv).not.toHaveBeenCalled();
  });

  it("PAY1B-AC08c: openBillingPortal calls requireMonitor first; its redirect stops everything", async () => {
    mockRequireMonitor.mockRejectedValue(new Error("NEXT_REDIRECT:/monitor/no-access"));
    const mockFetch = stubFetch(async () => portalResponse());
    await expect(openBillingPortal()).rejects.toThrow("NEXT_REDIRECT:/monitor/no-access");
    expect(mockGetBillingCustomerId).not.toHaveBeenCalled();
    expect(mockGetMonitorLocale).not.toHaveBeenCalled();
    expect(mockGetStripeEnv).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── PAY1B-AC50: per-user rate limit (amendment B11) ───────────────────────────

/** Both exported actions, with the `?error=` value each returns to. The form carries a user_id field the key must ignore. */
const BILLING_ACTIONS = [
  {
    name: "startSubscriptionCheckout",
    error: "checkout",
    run: () => startSubscriptionCheckout(form({ interval: "year", user_id: "evil-user-id" })),
  },
  { name: "openBillingPortal", error: "portal", run: () => openBillingPortal() },
] as const;

/** Ways the rate limit check can fail; each must stop the action (fail closed). */
const LIMITER_FAILURES: [label: string, arrange: () => void][] = [
  ["the user is over the limit", () => mockLimit.mockResolvedValue({ success: false })],
  ["the limiter rejects", () => mockLimit.mockRejectedValue(new Error("rate limiter unavailable"))],
  [
    "the limiter throws",
    () =>
      mockLimit.mockImplementation(() => {
        throw new Error("rate limiter unavailable");
      }),
  ],
  ["the limiter answers without success: true", () => mockLimit.mockResolvedValue({})],
  ["the Worker has no BILLING_RATE_LIMITER binding", () => mockGetCloudflareContext.mockReturnValue({ env: {} })],
  [
    "there is no Cloudflare context",
    () =>
      mockGetCloudflareContext.mockImplementation(() => {
        throw new Error("getCloudflareContext has been called without having called initOpenNextCloudflareForDev");
      }),
  ],
];

describe.each(BILLING_ACTIONS)("PAY1B-AC50: $name is rate-limited per user right after requireMonitor (B11)", ({ error, run }) => {
  it.each(LIMITER_FAILURES)(
    `PAY1B-AC50a: when %s → exactly /monitor/billing?error=${error}; no database, Stripe env or Stripe call`,
    async (_label, arrange) => {
      arrange();
      mockGetBillingCustomerId.mockResolvedValue("cus_limited");
      const mockFetch = stubFetch(async () => checkoutResponse());

      await expect(run()).rejects.toThrow(`NEXT_REDIRECT:/monitor/billing?error=${error}`);

      expect(mockRedirect).toHaveBeenCalledExactlyOnceWith(`/monitor/billing?error=${error}`);
      expect(mockGetCurrentSubscription).not.toHaveBeenCalled();
      expect(mockGetMonitorPlanByInterval).not.toHaveBeenCalled();
      expect(mockGetBillingCustomerId).not.toHaveBeenCalled();
      expect(mockGetMonitorLocale).not.toHaveBeenCalled();
      expect(mockGetStripeEnv).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("PAY1B-AC50b: under the limit, one count keyed on the session's user id (never a form field), after requireMonitor and before any service call", async () => {
    mockGetBillingCustomerId.mockResolvedValue("cus_under_limit");
    stubFetch(async (url) => (String(url).endsWith("/checkout/sessions") ? checkoutResponse() : portalResponse()));

    await expect(run()).rejects.toThrow("NEXT_REDIRECT:https://");

    expect(mockGetCloudflareContext).toHaveBeenCalledOnce();
    expect(mockLimit).toHaveBeenCalledExactlyOnceWith({ key: SESSION.userId });
    const [limitedAt] = mockLimit.mock.invocationCallOrder;
    expect(mockRequireMonitor.mock.invocationCallOrder[0]).toBeLessThan(limitedAt!);
    expect(mockGetBillingCustomerId.mock.invocationCallOrder[0]).toBeGreaterThan(limitedAt!);
  });

  it("PAY1B-AC50c: requireMonitor's redirect comes first: the limit is never read or counted", async () => {
    mockRequireMonitor.mockRejectedValue(new Error("NEXT_REDIRECT:/monitor/no-access"));
    await expect(run()).rejects.toThrow("NEXT_REDIRECT:/monitor/no-access");
    expect(mockGetCloudflareContext).not.toHaveBeenCalled();
    expect(mockLimit).not.toHaveBeenCalled();
  });
});

// ── PAY1B-AC09: invalid interval → error=checkout ────────────────────────────

describe("PAY1B-AC09: invalid or missing interval → redirect to ?error=checkout", () => {
  it("PAY1B-AC09a: missing interval field → error=checkout; fetch never called", async () => {
    const mockFetch = stubFetch(async () => checkoutResponse());
    await expect(startSubscriptionCheckout(form({}))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=checkout",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("PAY1B-AC09b: invalid interval value 'weekly' → error=checkout; fetch never called", async () => {
    const mockFetch = stubFetch(async () => checkoutResponse());
    await expect(startSubscriptionCheckout(form({ interval: "weekly" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=checkout",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("PAY1B-AC09c: empty string interval → error=checkout; fetch never called", async () => {
    const mockFetch = stubFetch(async () => checkoutResponse());
    await expect(startSubscriptionCheckout(form({ interval: "" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=checkout",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("PAY1B-AC09d: 'month' is a valid interval (redirects to checkout, not error)", async () => {
    mockGetMonitorPlanByInterval.mockResolvedValue(PLAN_MONTH);
    stubFetch(async () => checkoutResponse("cs_test_m", "https://checkout.stripe.com/c/pay/cs_test_m"));
    await expect(startSubscriptionCheckout(form({ interval: "month" }))).rejects.toThrow(
      "NEXT_REDIRECT:https://checkout.stripe.com/c/pay/cs_test_m",
    );
  });
});

// ── PAY1B-AC10 + PAY1B-AC07/AC11: extra fields ignored; success body asserted ─

describe("PAY1B-AC10/PAY1B-AC07/PAY1B-AC11: extra form fields ignored; correct Stripe body; checkout URL", () => {
  it(
    "PAY1B-AC10/PAY1B-AC11: extra fields (price, amount, user_id, customer, success_url) absent in body; " +
    "server-built fields (line_items[0][price], subscription_data, client_reference_id, " +
    "ui_mode=hosted_page, mode=subscription) present",
    async () => {
      const mockFetch = stubFetch(async () => checkoutResponse());

      const fd = form({
        interval: "year",
        // Evil extra fields — must be ignored
        price: "9999",
        amount: "99999",
        user_id: "evil-user-id",
        customer: "cus_evil",
        success_url: "https://evil.com/steal",
      });

      await expect(startSubscriptionCheckout(fd)).rejects.toThrow(
        "NEXT_REDIRECT:https://checkout.stripe.com/c/pay/cs_test_unit_x",
      );

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0] as FetchArgs;
      expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
      // The key reaches Stripe as the bearer token (getStripeEnv().checkoutKey).
      expect(new Headers(opts!.headers).get("Authorization")).toBe(`Bearer ${STRIPE_ENV.checkoutKey}`);

      const body = new URLSearchParams(opts!.body as string);

      // Server-built fields must be present and correct
      expect(body.get("line_items[0][price]")).toBe(PLAN_YEAR.stripePriceId);
      expect(body.get("line_items[0][quantity]")).toBe("1");
      expect(body.get("subscription_data[default_tax_rates][0]")).toBe(STRIPE_ENV.taxRateId);
      expect(body.get("subscription_data[metadata][user_id]")).toBe(SESSION.userId);
      expect(body.get("client_reference_id")).toBe(SESSION.userId);
      expect(body.get("ui_mode")).toBe("hosted_page");
      expect(body.get("mode")).toBe("subscription");

      // Evil extra fields must NOT be in the body
      expect(body.has("price")).toBe(false);
      expect(body.has("amount")).toBe(false);
      expect(body.has("user_id")).toBe(false);  // top-level key, not nested
      expect(body.has("customer")).toBe(false);  // no customer when no Stripe customer
      // success_url is a required server-built field (contract §4): the form's evil value is ignored
      expect(body.getAll("success_url")).toEqual([`${MONITOR_ORIGIN}/monitor/billing?checkout=done`]);
      // customer_email set from server session (not form)
      expect(body.get("customer_email")).toBe(SESSION.email);
    },
  );

  // Stripe does not document the hosted Checkout path; both shapes have been observed (B17).
  it.each(["c", "g"])(
    "PAY1B-AC07/PAY1B-AC11: success → redirects to the Checkout URL Stripe returned (path /%s/pay/cs_test_…)",
    async (segment) => {
      const url = `https://checkout.stripe.com/${segment}/pay/cs_test_redir`;
      stubFetch(async () => checkoutResponse("cs_test_redir", url));
      await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
        `NEXT_REDIRECT:${url}`,
      );
    },
  );

  it(
    "PAY1B-AC11a: a returning customer (a Stripe customer, no subscription) is sent as customer, " +
    "with no customer_email; expires_at is the clock in seconds + 1860",
    async () => {
      mockGetBillingCustomerId.mockResolvedValue("cus_returning_1");
      const mockFetch = stubFetch(async () => checkoutResponse());
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
      try {
        await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
          "NEXT_REDIRECT:https://checkout.stripe.com/c/pay/cs_test_unit_x",
        );
      } finally {
        vi.useRealTimers();
      }

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, opts] = mockFetch.mock.calls[0] as FetchArgs;
      const body = new URLSearchParams(opts!.body as string);
      expect(body.get("customer")).toBe("cus_returning_1");
      expect(body.has("customer_email")).toBe(false);
      // 2027-01-01T00:00:00Z is 1798761600 s: Stripe's expires_at is in seconds, never milliseconds.
      expect(body.get("expires_at")).toBe(String(1798761600 + 1860));
    },
  );
});

// ── PAY1B-AC32: origin from NEXT_PUBLIC_SITE_URL, never from evil Host ────────

describe("PAY1B-AC32: origin from NEXT_PUBLIC_SITE_URL even when request Host is evil", () => {
  it(
    "PAY1B-AC32a: success_url and cancel_url use monitorSiteOrigin(NEXT_PUBLIC_SITE_URL); " +
    "evil Host/origin/x-forwarded-host headers are ignored",
    async () => {
      // next/headers mock returns evil Host; parseSiteEnv is stubbed to localhost:3000.
      // monitorSiteOrigin("http://localhost:3000") = "http://monitor.localhost:3000"
      mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
      const mockFetch = stubFetch(async () => checkoutResponse());

      await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow("NEXT_REDIRECT:");

      const [, opts] = mockFetch.mock.calls[0] as FetchArgs;
      const body = new URLSearchParams(opts!.body as string);
      expect(body.get("success_url")).toBe(`${MONITOR_ORIGIN}/monitor/billing?checkout=done`);
      expect(body.get("cancel_url")).toBe(`${MONITOR_ORIGIN}/monitor/billing`);
      // Evil Host must NOT appear
      expect(body.get("success_url")).not.toContain("evil.example.com");
      expect(body.get("cancel_url")).not.toContain("evil.example.com");
    },
  );

  it(
    "PAY1B-AC32b: with NEXT_PUBLIC_SITE_URL=https://alnyron.dk, origin becomes https://monitor.alnyron.dk",
    async () => {
      mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk" });
      const mockFetch = stubFetch(async () => checkoutResponse());

      await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow("NEXT_REDIRECT:");

      const [, opts] = mockFetch.mock.calls[0] as FetchArgs;
      const body = new URLSearchParams(opts!.body as string);
      expect(body.get("success_url")).toBe("https://monitor.alnyron.dk/monitor/billing?checkout=done");
      expect(body.get("cancel_url")).toBe("https://monitor.alnyron.dk/monitor/billing");
    },
  );
});

// ── PAY1B-AC27: no plan found → error=checkout ───────────────────────────────

describe("PAY1B-AC27: no plan for interval → error=checkout; fetch never called", () => {
  it("PAY1B-AC27a: getMonitorPlanByInterval returns null → error=checkout", async () => {
    mockGetMonitorPlanByInterval.mockResolvedValue(null);
    const mockFetch = stubFetch(async () => checkoutResponse());
    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=checkout",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── PAY1B-AC25: getStripeEnv throws → error=checkout (Checkout) / error=portal (Portal) ─

describe("PAY1B-AC25: getStripeEnv throws → back to the billing page with the action's error; fetch never called", () => {
  it("PAY1B-AC25a: missing STRIPE_CHECKOUT_KEY → error=checkout", async () => {
    mockGetStripeEnv.mockImplementation(() => {
      throw new Error("Invalid or missing environment variables: STRIPE_CHECKOUT_KEY");
    });
    const mockFetch = stubFetch(async () => checkoutResponse());
    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=checkout",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("PAY1B-AC25b: openBillingPortal with a billing customer but no Stripe env → error=portal", async () => {
    mockGetBillingCustomerId.mockResolvedValue("cus_portal_test");
    mockGetStripeEnv.mockImplementation(() => {
      throw new Error("Invalid or missing Stripe environment variables: STRIPE_CHECKOUT_KEY");
    });
    const mockFetch = stubFetch(async () => portalResponse());
    await expect(openBillingPortal()).rejects.toThrow("NEXT_REDIRECT:/monitor/billing?error=portal");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── PAY1B-AC26: Stripe failures → error=checkout ─────────────────────────────

describe("PAY1B-AC26: Stripe response failures → redirect to ?error=checkout", () => {
  it("PAY1B-AC26a: Stripe HTTP error (402 card_declined) → error=checkout", async () => {
    stubFetch(async () => stripeErrorResponse("card_declined", 402));
    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=checkout",
    );
  });

  it("PAY1B-AC26b: Stripe network error → error=checkout", async () => {
    stubFetch(async () => { throw new TypeError("ECONNREFUSED"); });
    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=checkout",
    );
  });

  it("PAY1B-AC26c: Stripe invalid_response (wrong URL) → error=checkout", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ id: "pi_bad", url: "https://evil.com/bad" }), { status: 200 }),
    );
    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=checkout",
    );
  });

  it("PAY1B-AC26d: Stripe 5xx non-JSON → error=checkout", async () => {
    stubFetch(async () => new Response("Server Error", { status: 503 }));
    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=checkout",
    );
  });
});

// ── PAY1B-AC28: existing subscription → portal redirect ──────────────────────

describe("PAY1B-AC28: existing subscription → the Billing Portal, never a second Checkout", () => {
  const SUBSCRIPTION = {
    status: "active", interval: "year", amountOre: 9500,
    planName: "Monitor Plus", currentPeriodEnd: "2027-01-01T00:00:00Z", cancelAtPeriodEnd: false,
  };

  it("PAY1B-AC28a: getCurrentSubscription non-null → redirect to the portal session URL; one portal request, no checkout request", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUBSCRIPTION);
    mockGetBillingCustomerId.mockResolvedValue("cus_existing_123");
    const mockFetch = stubFetch(async () => portalResponse());

    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:https://billing.stripe.com/p/session/test_unitportal",
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as FetchArgs;
    expect(url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(Object.fromEntries(new URLSearchParams(opts!.body as string))).toEqual({
      customer: "cus_existing_123",
      configuration: STRIPE_ENV.portalConfigurationId,
      locale: "da",
      return_url: `${MONITOR_ORIGIN}/monitor/billing`,
    });
  });

  it("PAY1B-AC28b: a subscription without a billing customer → error=portal; Stripe never called", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUBSCRIPTION);
    mockGetBillingCustomerId.mockResolvedValue(null);
    const mockFetch = stubFetch(async () => portalResponse());

    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=portal",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("PAY1B-AC28c: a subscription and a billing customer but no Stripe env → error=portal; Stripe never called", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUBSCRIPTION);
    mockGetBillingCustomerId.mockResolvedValue("cus_existing_123");
    mockGetStripeEnv.mockImplementation(() => {
      throw new Error("Invalid or missing Stripe environment variables: STRIPE_CHECKOUT_KEY");
    });
    const mockFetch = stubFetch(async () => portalResponse());

    await expect(startSubscriptionCheckout(form({ interval: "year" }))).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=portal",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── PAY1B-AC21: openBillingPortal — no customer → error=portal ───────────────

describe("PAY1B-AC21: openBillingPortal — no billing customer → error=portal", () => {
  it("PAY1B-AC21a: getBillingCustomerId returns null → error=portal; Stripe never called", async () => {
    mockGetBillingCustomerId.mockResolvedValue(null);
    const mockFetch = stubFetch(async () => portalResponse());
    await expect(openBillingPortal()).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=portal",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── PAY1B-AC22: openBillingPortal success ────────────────────────────────────

describe("PAY1B-AC22: openBillingPortal — Stripe success → redirect to portal URL", () => {
  it("PAY1B-AC22a: Stripe portal success → redirect to billing.stripe.com URL", async () => {
    mockGetBillingCustomerId.mockResolvedValue("cus_portal_test");
    stubFetch(async () => portalResponse("https://billing.stripe.com/p/session/test_portal_x"));
    await expect(openBillingPortal()).rejects.toThrow(
      "NEXT_REDIRECT:https://billing.stripe.com/p/session/test_portal_x",
    );
  });

  it("PAY1B-AC22b: portal request body has customer, configuration, return_url", async () => {
    mockGetBillingCustomerId.mockResolvedValue("cus_portal_body_test");
    const mockFetch = stubFetch(async () =>
      portalResponse("https://billing.stripe.com/p/session/test_body"),
    );
    await expect(openBillingPortal()).rejects.toThrow("NEXT_REDIRECT:");

    const [, opts] = mockFetch.mock.calls[0] as FetchArgs;
    const body = new URLSearchParams(opts!.body as string);
    expect(body.get("customer")).toBe("cus_portal_body_test");
    expect(body.get("configuration")).toBe(STRIPE_ENV.portalConfigurationId);
    expect(body.get("return_url")).toBe(`${MONITOR_ORIGIN}/monitor/billing`);
  });

  it("PAY1B-AC22c: Stripe portal failure → error=portal", async () => {
    mockGetBillingCustomerId.mockResolvedValue("cus_portal_test");
    stubFetch(async () => stripeErrorResponse("resource_missing", 404));
    await expect(openBillingPortal()).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=portal",
    );
  });

  it("PAY1B-AC22d: Stripe invalid_response for portal (wrong URL) → error=portal", async () => {
    mockGetBillingCustomerId.mockResolvedValue("cus_portal_test");
    stubFetch(async () =>
      new Response(JSON.stringify({ url: "https://evil.com/bad" }), { status: 200 }),
    );
    await expect(openBillingPortal()).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/billing?error=portal",
    );
  });
});
