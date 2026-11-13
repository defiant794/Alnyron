// @vitest-environment jsdom
/**
 * Unit tests: src/app/monitor/(panel)/billing/page.tsx — billing page states.
 * Journey: payments-slice1b-billing
 *   PAY1B-AC01, PAY1B-AC02, PAY1B-AC03, PAY1B-AC04, PAY1B-AC05, PAY1B-AC06,
 *   PAY1B-AC13, PAY1B-AC14, PAY1B-AC15, PAY1B-AC16, PAY1B-AC17, PAY1B-AC18,
 *   PAY1B-AC19, PAY1B-AC20, PAY1B-AC23, PAY1B-AC24, PAY1B-AC52
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as NextNavigation from "next/navigation";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";
import type * as EnvModule from "@/config/env";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const {
  mockRequireMonitor,
  mockGetMonitorUsage,
  mockGetCurrentSubscription,
  mockListMonitorPlans,
} = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(),
  mockGetMonitorUsage: vi.fn(),
  mockGetCurrentSubscription: vi.fn(),
  mockListMonitorPlans: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Real next-intl formatting over the real messages; a missing key throws. The page reads
// `Payments.billing.*` and `Monitor.dashboard.*` with full keys (no namespace);
// generateMetadata scopes to `Payments.billing`. The factory is hoisted above the static
// imports, so it loads its modules itself.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { loadMessages } = await import("@/i18n/messages");
  return {
    getTranslations: vi.fn(
      async ({ locale, namespace }: { locale: "da" | "en"; namespace?: "Payments.billing" }) =>
        createTranslator({
          locale,
          messages: loadMessages(locale),
          namespace,
          onError: (error) => {
            throw error;
          },
        }),
    ),
  };
});

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
  usePathname: () => "/monitor/billing",
}));

vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
vi.mock("@/services/monitor/monitors", () => ({ getMonitorUsage: mockGetMonitorUsage }));
vi.mock("@/services/payments/billing", () => ({
  getCurrentSubscription: mockGetCurrentSubscription,
  listMonitorPlans: mockListMonitorPlans,
}));
vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/app/monitor/(panel)/billing/actions", () => ({
  startSubscriptionCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
}));
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  parseSiteEnv: () => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }),
}));
vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale }: { locale: string }) => (
    <footer data-testid="site-footer" data-locale={locale} />
  ),
}));
vi.mock("@/components/monitor/MonitorMainNav", () => ({
  default: () => <nav aria-label="Hovednavigation" data-testid="monitor-main-nav" />,
}));
vi.mock("@/components/site/SiteMenu", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/SubmitButton", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));
vi.mock("next/image", () => ({
  default: ({ alt, className }: { alt: string; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} className={className ?? ""} />
  ),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    "aria-current": ariaCurrent,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    "aria-current"?: React.AriaAttributes["aria-current"];
  }) => (
    <a href={href} className={className} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}));
vi.mock("@/i18n/monitor-locale", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorLocaleModule>()),
  getMonitorLocale: vi.fn(async () => "da" as const),
}));
vi.mock("@/i18n/current-route", () => ({ useCurrentPath: () => "/monitor/billing" }));

// ── Static imports (after vi.mock declarations) ────────────────────────────────

import BillingPage, { generateMetadata } from "@/app/monitor/(panel)/billing/page";
import { MONITOR_ROBOTS } from "@/config/monitor";
import { getMonitorLocale } from "@/i18n/monitor-locale";

afterEach(cleanup);

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SESSION = { userId: "user-1", email: "test@test.local", role: "monitor_user" as const };

const PLAN_YEAR = {
  id: "plan-yr", stripePriceId: "price_yr", interval: "year" as const,
  monitorLimit: 20, amountOre: 9500, name: "Monitor Plus",
};
const PLAN_MONTH = {
  id: "plan-mo", stripePriceId: "price_mo", interval: "month" as const,
  monitorLimit: 20, amountOre: 1000, name: "Monitor Plus",
};

const SUB_ACTIVE = {
  status: "active",
  interval: "year" as const,
  amountOre: 9500,
  planName: "Monitor Plus",
  currentPeriodEnd: "2027-06-01T00:00:00Z",
  cancelAtPeriodEnd: false,
};

const FINE_PRINT_DA =
  "Priser inkl. moms. Betaling via Stripe – du sendes til Stripes sikre betalingsside. " +
  "Opsig eller skift mellem månedlig og årlig betaling når som helst under “Administrér abonnement”.";

/** Renders the billing page with the given searchParams. */
async function renderBilling(params: Record<string, string> = {}) {
  return render(await BillingPage({ searchParams: Promise.resolve(params) }));
}

const main = () => within(screen.getByRole("main"));

/** The option row (label) of the radio whose value is `interval`. */
function optionRow(interval: "year" | "month"): HTMLElement {
  const radio = main().getAllByRole("radio").find((r) => (r as HTMLInputElement).value === interval);
  const row = radio?.closest("label");
  if (!row) throw new Error(`no ${interval} option`);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMonitor.mockResolvedValue(SESSION);
  mockGetMonitorUsage.mockResolvedValue({ count: 5, limit: 20 });
  mockGetCurrentSubscription.mockResolvedValue(null);
  mockListMonitorPlans.mockResolvedValue([PLAN_YEAR, PLAN_MONTH]);
  vi.mocked(getMonitorLocale).mockResolvedValue("da");
});

// ── PAY1B-AC01: requireMonitor gate, heading, metadata ────────────────────────

describe("PAY1B-AC01: billing page is gated by requireMonitor", () => {
  it("PAY1B-AC01a: requireMonitor redirect propagates (page never renders)", async () => {
    mockRequireMonitor.mockRejectedValue(new Error("NEXT_REDIRECT:/monitor/no-access"));
    await expect(BillingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/no-access",
    );
  });

  it("PAY1B-AC01b: renders the h1 'Abonnement' and the lead with the user's current cap", async () => {
    await renderBilling();
    expect(main().getByRole("heading", { level: 1 })).toHaveTextContent(/^Abonnement$/);
    expect(main().getByText("Kør mere end 20 overvågninger med Monitor Plus.", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC01c: metadata: title 'Abonnement' ('Subscription' in EN) and the Monitor robots rule", async () => {
    expect(await generateMetadata()).toEqual({ title: "Abonnement", robots: MONITOR_ROBOTS });
    vi.mocked(getMonitorLocale).mockResolvedValue("en");
    expect(await generateMetadata()).toEqual({ title: "Subscription", robots: MONITOR_ROBOTS });
  });
});

// ── PAY1B-AC02: usage pill ────────────────────────────────────────────────────

describe("PAY1B-AC02: usage pill shows count / limit for finite limits, in every state", () => {
  it("PAY1B-AC02a: shows '5 / 20 overvågninger brugt' in upgrade state", async () => {
    await renderBilling();
    expect(main().getByText("5 / 20 overvågninger brugt", { exact: true })).toBeInTheDocument();
  });

  it.each<[
    state: string,
    subscription: typeof SUB_ACTIVE | null,
    plans: (typeof PLAN_YEAR | typeof PLAN_MONTH)[],
    params: Record<string, string>,
    stateText: string,
  ]>([
    ["subscribed", SUB_ACTIVE, [PLAN_YEAR, PLAN_MONTH], {}, "Dit abonnement og din betaling."],
    ["pending", null, [PLAN_YEAR, PLAN_MONTH], { checkout: "done" }, "Vi aktiverer dit abonnement …"],
    ["no-plans", null, [], {}, "Monitor Plus er ikke tilgængeligt endnu."],
  ])("PAY1B-AC02b: shows '5 / 20 overvågninger brugt' in the %s state", async (_state, subscription, plans, params, stateText) => {
    mockGetCurrentSubscription.mockResolvedValue(subscription);
    mockListMonitorPlans.mockResolvedValue(plans);
    await renderBilling(params);
    expect(main().getByText(stateText, { exact: true })).toBeInTheDocument();
    expect(main().getByText("5 / 20 overvågninger brugt", { exact: true })).toBeInTheDocument();
  });
});

// ── PAY1B-AC24: unlimited state ───────────────────────────────────────────────

describe("PAY1B-AC24: unlimited state (null limit) — unlimited message, no card", () => {
  beforeEach(() => {
    mockGetMonitorUsage.mockResolvedValue({ count: 3, limit: null });
  });

  it("PAY1B-AC24a: shows the unlimited text as the lead and the count-only pill", async () => {
    await renderBilling();
    expect(main().getByText("Din konto har ingen grænse for overvågninger.", { exact: true })).toBeInTheDocument();
    expect(main().getByText("3 overvågninger", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC24b: no card, no form", async () => {
    await renderBilling();
    expect(main().queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
    expect(main().queryByRole("button")).not.toBeInTheDocument();
    expect(main().queryByRole("radio")).not.toBeInTheDocument();
  });

  it("PAY1B-AC24c: no usage count/limit fraction in unlimited state", async () => {
    await renderBilling();
    expect(document.body.textContent).not.toMatch(/3\s*\/\s*\d/);
  });
});

// ── PAY1B-AC23: no plans state ────────────────────────────────────────────────

describe("PAY1B-AC23: no active plans — unavailable message, no form", () => {
  beforeEach(() => {
    mockListMonitorPlans.mockResolvedValue([]);
  });

  it("PAY1B-AC23a: shows 'Monitor Plus er ikke tilgængeligt endnu.' under the upgrade lead", async () => {
    await renderBilling();
    expect(main().getByText("Monitor Plus er ikke tilgængeligt endnu.", { exact: true })).toBeInTheDocument();
    expect(main().getByText("Kør mere end 20 overvågninger med Monitor Plus.", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC23b: no upgrade form shown in no-plans state", async () => {
    await renderBilling();
    expect(main().queryByRole("button")).not.toBeInTheDocument();
    expect(main().queryByRole("radio")).not.toBeInTheDocument();
  });
});

// ── PAY1B-AC03/05/06: upgrade state (default) ────────────────────────────────

describe("PAY1B-AC03: upgrade card — DA copy, plan name, fieldset legend", () => {
  it("PAY1B-AC03a: the card's h2 is the plan name 'Monitor Plus', with the plan's cap below", async () => {
    await renderBilling();
    expect(main().getByRole("heading", { level: 2 })).toHaveTextContent(/^Monitor Plus$/);
    expect(main().getByText("Op til 20 overvågninger. Opsig når som helst.", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC03b: the submit button is named 'Opgradér'", async () => {
    await renderBilling();
    expect(main().getByRole("button")).toHaveAccessibleName("Opgradér");
  });

  it("PAY1B-AC03c: the options are a group named by the legend 'Vælg betalingsperiode'", async () => {
    await renderBilling();
    const group = main().getByRole("group", { name: "Vælg betalingsperiode" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
  });

  it("PAY1B-AC03d: the legend is visually hidden (sr-only) and reads exactly 'Vælg betalingsperiode'", async () => {
    await renderBilling();
    const legend = screen.getByRole("main").querySelector("fieldset > legend");
    expect(legend).toHaveTextContent(/^Vælg betalingsperiode$/);
    expect(legend).toHaveClass("sr-only");
  });

  it("PAY1B-AC03e: radios named 'interval' with values exactly year, month; year checked, month not", async () => {
    await renderBilling();
    const radios = main().getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.name)).toEqual(["interval", "interval"]);
    expect(radios.map((r) => r.value)).toEqual(["year", "month"]);
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
  });

  it("PAY1B-AC03f: Opgradér button's form contains the interval radios", async () => {
    await renderBilling();
    const formEl = main().getByRole("button", { name: "Opgradér" }).closest("form");
    expect(formEl).not.toBeNull();
    expect(within(formEl!).getAllByRole("radio")).toHaveLength(2);
  });

  it("PAY1B-AC03g: the fine print, exact", async () => {
    await renderBilling();
    expect(main().getByText(FINE_PRINT_DA, { exact: true })).toBeInTheDocument();
  });
});

describe("PAY1B-AC05: upgrade card — interval radio buttons and labels", () => {
  it("PAY1B-AC05a: the radios are named by their price: year (with its tag) first, month second", async () => {
    await renderBilling();
    const radios = main().getAllByRole("radio");
    expect(radios[0]).toHaveAccessibleName(/^95 kr \/ år\s*Spar ~21%$/);
    expect(radios[1]).toHaveAccessibleName("10 kr / måned");
  });

  it("PAY1B-AC05b: year option reads '95 kr / år' (exact)", async () => {
    await renderBilling();
    expect(within(optionRow("year")).getByText("95 kr / år", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC05c: month option reads '10 kr / måned' (exact)", async () => {
    await renderBilling();
    expect(within(optionRow("month")).getByText("10 kr / måned", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC05d: one option per billing period: of two active yearly plans only the first is offered", async () => {
    mockListMonitorPlans.mockResolvedValue([
      PLAN_YEAR,
      PLAN_MONTH,
      { ...PLAN_YEAR, id: "plan-yr-new", stripePriceId: "price_yr_new", amountOre: 10000 },
    ]);
    await renderBilling();
    const radios = main().getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["year", "month"]);
    expect(within(optionRow("year")).getByText("95 kr / år", { exact: true })).toBeInTheDocument();
    expect(main().queryByText("100 kr / år")).not.toBeInTheDocument();
  });
});

describe("PAY1B-AC06: savings tag is computed from plan prices", () => {
  it("PAY1B-AC06a: the year option carries 'Spar ~21%' (9500 vs 12 × 1000); the month option no tag", async () => {
    await renderBilling();
    expect(within(optionRow("year")).getByText("Spar ~21%", { exact: true })).toBeInTheDocument();
    expect(within(optionRow("month")).queryByText(/^Spar/)).not.toBeInTheDocument();
  });

  it("PAY1B-AC06b: no savings tag when only one plan", async () => {
    mockListMonitorPlans.mockResolvedValue([PLAN_YEAR]);
    await renderBilling();
    expect(main().queryByText(/^Spar/)).not.toBeInTheDocument();
  });

  it("PAY1B-AC06c: computed from the prices: 10000 vs 12 × 1000 → 'Spar ~17%'", async () => {
    mockListMonitorPlans.mockResolvedValue([{ ...PLAN_YEAR, amountOre: 10000 }, PLAN_MONTH]);
    await renderBilling();
    expect(within(optionRow("year")).getByText("Spar ~17%", { exact: true })).toBeInTheDocument();
  });

  it.each([12000, 13000])("PAY1B-AC06d: no tag when the yearly price saves nothing (%i øre vs 12 × 1000)", async (yearOre) => {
    mockListMonitorPlans.mockResolvedValue([{ ...PLAN_YEAR, amountOre: yearOre }, PLAN_MONTH]);
    await renderBilling();
    expect(main().queryByText(/^Spar/)).not.toBeInTheDocument();
  });
});

// ── PAY1B-AC52: no overflow with 2× text at 320px (D-5) ──────────────────────
// Design review D-5. jsdom has no layout, so these tests only pin the classes the
// layout relies on, a proxy; E2E-PAY1B-15 (tests/e2e/monitor-billing.spec.ts)
// measures the real layout in Chromium at 320×568 with every font size doubled.

describe("PAY1B-AC52: with 2× text at 320px the billing page has no horizontal overflow (design review D-5)", () => {
  it.each([
    ["upgrade", {}, null],
    ["pending", { checkout: "done" }, null],
    ["upgrade + checkout error", { error: "checkout" }, null],
    ["hidden plan + portal error", { error: "portal" }, { ...SUB_ACTIVE, interval: null, amountOre: null, planName: null }],
  ])(
    "PAY1B-AC52a: %s — pins wrap-break-word on the page content root that holds every heading and notice (a class proxy for 'long words wrap'; E2E-PAY1B-15 checks the real layout)",
    async (_state, params: Record<string, string>, subscription) => {
      mockGetCurrentSubscription.mockResolvedValue(subscription);
      await renderBilling(params);
      const root = screen.getByRole("main").firstElementChild;
      // overflow-wrap is inherited, so the class on the page's root covers every heading and notice.
      expect(root).toHaveClass("wrap-break-word");
      const headings = main().getAllByRole("heading");
      expect(headings.map((heading) => heading.tagName)).toEqual(["H1", "H2"]);
      for (const element of [...headings, ...main().queryAllByRole("alert")]) expect(root).toContainElement(element);
    },
  );

  it.each(["year", "month"] as const)(
    "PAY1B-AC52b: %s option row — pins the wrapping, shrinkable price + tag group, the radio at the row's end and the tag's wrapping words (a class proxy for 'the row stays inside its card'; E2E-PAY1B-15 checks the real layout)",
    async (interval) => {
      await renderBilling();
      const row = optionRow(interval);
      const group = row.firstElementChild;
      // The tag drops under the price (8px apart on one line, as in the mock); min-w-0 lets the group shrink.
      expect(group).toHaveClass("flex", "min-w-0", "flex-wrap", "items-center", "gap-x-2", "gap-y-1");
      expect(row.lastElementChild).toBe(within(row).getByRole("radio"));
      const tag = within(row).queryByText(/^Spar ~\d+%$/);
      if (interval === "month") {
        expect(tag).toBeNull();
        return;
      }
      // The Badge never wraps, so the tag text wraps inside it; the Badge is a flex item of the group.
      expect(tag).toHaveClass("whitespace-normal");
      expect(tag?.parentElement?.parentElement).toBe(group);
    },
  );
});

// ── PAY1B-AC04: EN locale ─────────────────────────────────────────────────────

describe("PAY1B-AC04: EN locale — English copy when getMonitorLocale returns 'en'", () => {
  it("PAY1B-AC04a: heading, lead, plan copy, prices, tag and button in English", async () => {
    vi.mocked(getMonitorLocale).mockResolvedValue("en");
    await renderBilling();
    expect(main().getByRole("heading", { level: 1 })).toHaveTextContent(/^Subscription$/);
    expect(main().getByText("Run more than 20 monitors with Monitor Plus.", { exact: true })).toBeInTheDocument();
    expect(main().getByText("Up to 20 monitors. Cancel anytime.", { exact: true })).toBeInTheDocument();
    expect(within(optionRow("year")).getByText("95 kr / year", { exact: true })).toBeInTheDocument();
    expect(within(optionRow("month")).getByText("10 kr / month", { exact: true })).toBeInTheDocument();
    expect(within(optionRow("year")).getByText("Save ~21%", { exact: true })).toBeInTheDocument();
    expect(main().getByRole("button")).toHaveAccessibleName("Upgrade");
  });
});

// ── PAY1B-AC13: pending state (?checkout=done, no subscription) ───────────────

describe("PAY1B-AC13: pending state — ?checkout=done with no subscription row yet", () => {
  it("PAY1B-AC13a: a status region with the h2 'Vi aktiverer dit abonnement …' and its body", async () => {
    await renderBilling({ checkout: "done" });
    const status = main().getByRole("status");
    expect(within(status).getByRole("heading", { level: 2 })).toHaveTextContent(/^Vi aktiverer dit abonnement …$/);
    expect(
      within(status).getByText("Det tager normalt kun et øjeblik. Opdatér siden om lidt.", { exact: true }),
    ).toBeInTheDocument();
  });

  it("PAY1B-AC13b: no upgrade form shown in pending state", async () => {
    await renderBilling({ checkout: "done" });
    expect(main().queryByRole("button")).not.toBeInTheDocument();
    expect(main().queryByRole("radio")).not.toBeInTheDocument();
  });

  it("PAY1B-AC13c: 'Opdatér' links to exactly /monitor/billing?checkout=done", async () => {
    await renderBilling({ checkout: "done" });
    expect(main().getByRole("link", { name: "Opdatér" })).toHaveAttribute("href", "/monitor/billing?checkout=done");
  });

  it("PAY1B-AC13d: 'Opdatér' is a standalone link with the 44px tap target (DESIGN.md Link; design review D-1)", async () => {
    await renderBilling({ checkout: "done" });
    expect(main().getByRole("link", { name: "Opdatér" })).toHaveClass("inline-flex", "min-h-11", "items-center");
  });
});

// ── PAY1B-AC14: activated notice (?checkout=done + entitling subscription) ────

describe("PAY1B-AC14: activated notice — ?checkout=done with entitling subscription", () => {
  it.each(["trialing", "active", "past_due"] as const)(
    "PAY1B-AC14a: success notice (role=status) with the user's cap for entitling status '%s'",
    async (status) => {
      // The user's current cap (my_monitor_limit), not a figure in the copy.
      mockGetMonitorUsage.mockResolvedValue({ count: 3, limit: 25 });
      mockGetCurrentSubscription.mockResolvedValue({ ...SUB_ACTIVE, status });
      await renderBilling({ checkout: "done" });
      expect(main().getByRole("status")).toHaveTextContent(
        /^Monitor Plus er aktivt\. Du kan nu køre op til 25 overvågninger\.$/,
      );
    },
  );

  it.each(["incomplete", "unpaid", "paused"])(
    "PAY1B-AC14b: no success notice for a non-entitling '%s' subscription, even with ?checkout=done",
    async (status) => {
      mockGetCurrentSubscription.mockResolvedValue({ ...SUB_ACTIVE, status });
      await renderBilling({ checkout: "done" });
      expect(main().queryByRole("status")).not.toBeInTheDocument();
      expect(main().queryByText(/Monitor Plus er aktivt/)).not.toBeInTheDocument();
    },
  );

  it("PAY1B-AC14c: no success notice for an entitling subscription without ?checkout=done", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    await renderBilling();
    expect(main().queryByRole("status")).not.toBeInTheDocument();
  });
});

// ── PAY1B-AC17–20: subscribed states ─────────────────────────────────────────

describe("PAY1B-AC17: subscribed state — plan info, price, Administrér button", () => {
  it("PAY1B-AC17a: the card's h2 is the plan name; the lead is 'Dit abonnement og din betaling.'", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    await renderBilling();
    expect(main().getByRole("heading", { level: 2 })).toHaveTextContent(/^Monitor Plus$/);
    expect(main().getByText("Dit abonnement og din betaling.", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC17b: the price line reads '95 kr / år' (exact)", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    await renderBilling();
    expect(main().getByText("95 kr / år", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC17c: the only button is 'Administrér abonnement'; no upgrade options", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    await renderBilling();
    expect(main().getByRole("button")).toHaveAccessibleName("Administrér abonnement");
    expect(main().queryByRole("radio")).not.toBeInTheDocument();
  });

  it("PAY1B-AC17d: 'Fornyes 1. juni 2027' when active and not cancelling", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    await renderBilling();
    expect(main().getByText("Fornyes 1. juni 2027", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC17e: EN: 'Renews 1 June 2027'", async () => {
    vi.mocked(getMonitorLocale).mockResolvedValue("en");
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    await renderBilling();
    expect(main().getByText("Renews 1 June 2027", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC17f: the date is in Copenhagen time (22:30 UTC on 31 May is 1 June there)", async () => {
    mockGetCurrentSubscription.mockResolvedValue({ ...SUB_ACTIVE, currentPeriodEnd: "2027-05-31T22:30:00Z" });
    await renderBilling();
    expect(main().getByText("Fornyes 1. juni 2027", { exact: true })).toBeInTheDocument();
  });

  it("PAY1B-AC17g: a plan hidden from the user (no longer active): title as heading, no price line", async () => {
    mockGetCurrentSubscription.mockResolvedValue({ ...SUB_ACTIVE, interval: null, amountOre: null, planName: null });
    await renderBilling();
    expect(main().getByRole("heading", { level: 2 })).toHaveTextContent(/^Abonnement$/);
    expect(main().queryByText(/ kr \//)).not.toBeInTheDocument();
    expect(main().getByText("Fornyes 1. juni 2027", { exact: true })).toBeInTheDocument();
  });
});

describe("PAY1B-AC18: subscribed state — cancelAtPeriodEnd=true shows 'Ophører'", () => {
  it("PAY1B-AC18a: 'Ophører 1. juni 2027' when cancelling at the period end; no 'Fornyes'", async () => {
    mockGetCurrentSubscription.mockResolvedValue({ ...SUB_ACTIVE, cancelAtPeriodEnd: true });
    await renderBilling();
    expect(main().getByText("Ophører 1. juni 2027", { exact: true })).toBeInTheDocument();
    expect(main().queryByText(/^Fornyes/)).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "PAY1B-AC18b: no renewal or end line when currentPeriodEnd is null (cancelAtPeriodEnd=%s)",
    async (cancelAtPeriodEnd) => {
      mockGetCurrentSubscription.mockResolvedValue({ ...SUB_ACTIVE, currentPeriodEnd: null, cancelAtPeriodEnd });
      await renderBilling();
      expect(main().queryByText(/^(Fornyes|Ophører)/)).not.toBeInTheDocument();
      expect(main().getByText("95 kr / år", { exact: true })).toBeInTheDocument();
    },
  );
});

describe("PAY1B-AC19: past_due — payment failure warning", () => {
  it("PAY1B-AC19a: shows the exact payment failure warning for past_due", async () => {
    mockGetCurrentSubscription.mockResolvedValue({ ...SUB_ACTIVE, status: "past_due" });
    await renderBilling();
    expect(
      main().getByText(
        "Den seneste betaling mislykkedes. Opdatér betalingsmetoden under Administrér abonnement.",
        { exact: true },
      ),
    ).toBeInTheDocument();
    expect(main().queryByText(/ikke aktivt/)).not.toBeInTheDocument();
  });
});

describe("PAY1B-AC20: non-entitling, non-ended status shows inactive message", () => {
  it.each(["incomplete", "unpaid", "paused"])(
    "PAY1B-AC20a: the exact inactive message, and no renewal line, for status '%s'",
    async (status) => {
      mockGetCurrentSubscription.mockResolvedValue({ ...SUB_ACTIVE, status });
      await renderBilling();
      expect(
        main().getByText(
          "Abonnementet er ikke aktivt. Gør betalingen færdig under Administrér abonnement.",
          { exact: true },
        ),
      ).toBeInTheDocument();
      expect(main().queryByText(/^(Fornyes|Ophører)/)).not.toBeInTheDocument();
    },
  );
});

// ── PAY1B-AC15/16: error notices ──────────────────────────────────────────────

describe("PAY1B-AC15: ?error=checkout shows checkout error alert", () => {
  it("PAY1B-AC15a: role=alert with the exact checkout error text, above the card", async () => {
    await renderBilling({ error: "checkout" });
    const alert = main().getByRole("alert");
    expect(alert).toHaveTextContent(/^Vi kunne ikke åbne betalingssiden\. Prøv igen om lidt\.$/);
    const card = main().getByRole("heading", { level: 2 }).closest("section");
    expect(alert.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("PAY1B-AC16: ?error=portal shows portal error alert", () => {
  it("PAY1B-AC16a: role=alert with the exact portal error text", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    await renderBilling({ error: "portal" });
    expect(main().getByRole("alert")).toHaveTextContent(
      /^Vi kunne ikke åbne abonnementsstyringen\. Prøv igen om lidt\.$/,
    );
  });
});
