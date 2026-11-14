// @vitest-environment jsdom
/**
 * Unit tests: src/app/monitor/(panel)/billing/page.tsx — slice 1d additions
 * Journey: payments-slice1d-withdrawal (+ its design addendum, J9)
 * Criteria: WD-J1-C04, WD-J1-C05, WD-J4-C01, WD-J9-C05
 *
 * Coverage:
 *   - billingFinePrint shown below upgrade card (DA + EN)
 *   - billingFinePrint link to /terms on main site
 *   - window_open=true: "Fortryd aftale" button + deadline date shown
 *   - window_open=false: no "Fortryd aftale" button
 *   - withdrawal exists (received): notice shown with in-progress wording
 *   - withdrawal exists (completed): notice with refund amount
 *   - upgrade state: VAT and cancellation stated once, in the legal fine print below the card;
 *     the card's own fine print is the Stripe payment sentence only
 *
 * Notes:
 *   - translations are the real messages (next-intl's createTranslator over messages/*.json),
 *     so the asserted copy is the shipped copy;
 *   - fixtures use the services' real shapes: usage `{ count, limit }`, plans and the
 *     subscription with `interval`, as getMonitorUsage, listMonitorPlans and
 *     getCurrentSubscription return them;
 *   - the fine print is the legal module's billingFinePrint, pinned as literals here; the link
 *     is the main site's absolute /terms URL (DA unprefixed, EN /en/terms);
 *   - the notices assert the shipped wording, not a substring the fine print also contains.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as NextNavigation from "next/navigation";
import type * as EnvModule from "@/config/env";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";

// ── vi.hoisted ────────────────────────────────────────────────────────────────

const {
  mockRequireMonitor,
  mockGetMonitorUsage,
  mockGetCurrentSubscription,
  mockListMonitorPlans,
  mockMyWithdrawalStatus,
  mockGetMonitorLocale,
} = vi.hoisted(() => ({
  mockRequireMonitor:       vi.fn(),
  mockGetMonitorUsage:      vi.fn(),
  mockGetCurrentSubscription: vi.fn(),
  mockListMonitorPlans:     vi.fn(),
  mockMyWithdrawalStatus:   vi.fn(),
  mockGetMonitorLocale:     vi.fn(),
}));

// Real next-intl formatting over the real messages; a missing key throws. The factory is hoisted
// above the static imports, so it loads its modules itself.
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
  redirect: vi.fn((url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${url}` }); }),
  usePathname: () => "/monitor/billing",
}));
vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
vi.mock("@/services/monitor/monitors", () => ({ getMonitorUsage: mockGetMonitorUsage }));
vi.mock("@/services/payments/billing", () => ({
  getCurrentSubscription: mockGetCurrentSubscription,
  listMonitorPlans: mockListMonitorPlans,
  getMyWithdrawalStatus: mockMyWithdrawalStatus,
}));
vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/app/monitor/(panel)/billing/actions", () => ({ startSubscriptionCheckout: vi.fn(), openBillingPortal: vi.fn() }));
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  parseSiteEnv: () => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }),
}));
vi.mock("@/components/site/SiteFooter", () => ({ default: () => <footer data-testid="site-footer" /> }));
vi.mock("@/components/monitor/MonitorMainNav", () => ({ default: () => <nav aria-label="Hovednavigation" /> }));
vi.mock("@/components/site/SiteMenu", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/SubmitButton", () => ({ default: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button> }));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; "aria-describedby"?: string }) => (
    <a href={href} aria-describedby={rest["aria-describedby"]}>{children}</a>
  ),
}));
vi.mock("@/i18n/monitor-locale", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorLocaleModule>()),
  getMonitorLocale: mockGetMonitorLocale,
}));
vi.mock("@/i18n/current-route", () => ({ useCurrentPath: () => "/monitor/billing" }));

import BillingPage from "@/app/monitor/(panel)/billing/page";

afterEach(cleanup);

const SESSION = { userId: "user-1", email: "test@test.local", role: "monitor_user" as const };
const PLAN_YEAR  = { id: "plan-1", stripePriceId: "price_yr", interval: "year"  as const, amountOre: 9500, monitorLimit: 20, name: "Monitor Plus" };
const PLAN_MONTH = { id: "plan-2", stripePriceId: "price_mo", interval: "month" as const, amountOre: 1000, monitorLimit: 20, name: "Monitor Plus" };

const SUB_ACTIVE = {
  status: "active", interval: "year" as const, amountOre: 9500, planName: "Monitor Plus",
  currentPeriodEnd: "2030-06-01T10:00:00Z", cancelAtPeriodEnd: false,
};

const WD_STATUS_OPEN = {
  subscription_id: "sub_test", status: "active", started_at: "2026-11-14T00:00:00Z",
  window_open: true, has_consent: true,
  deadline_at: "2026-11-30T23:00:00Z",
  withdrawal: null,
  invoice: null,
};

/** The legal module's billingFinePrint (DA and EN), pinned as literals. */
const FINE_PRINT_DA =
  "Priserne er inkl. 25 % moms. Abonnementet fornyes automatisk og kan opsiges når som helst til udløbet af den " +
  "betalte periode. Du har 14 dages fortrydelsesret: fortryder du, betaler du kun for den tid, abonnementet har " +
  "været aktivt.";
const FINE_PRINT_EN =
  "Prices include 25% VAT. The subscription renews automatically and can be cancelled at any time to the end of " +
  "the paid period. You have a 14-day right of withdrawal: if you withdraw, you only pay for the time the " +
  "subscription was active.";
const TERMS_LINK_DA = "Læs handelsbetingelserne og fortrydelsesretten";
const TERMS_LINK_EN = "Read the terms and the right of withdrawal";

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMonitor.mockResolvedValue(SESSION);
  mockGetMonitorUsage.mockResolvedValue({ count: 5, limit: 20 });
  mockGetCurrentSubscription.mockResolvedValue(null);
  mockListMonitorPlans.mockResolvedValue([PLAN_YEAR, PLAN_MONTH]);
  mockMyWithdrawalStatus.mockResolvedValue(null);
  mockGetMonitorLocale.mockResolvedValue("da");
});

async function renderBilling(params: Record<string, string> = {}) {
  return render(await BillingPage({ searchParams: Promise.resolve(params) }));
}

/** The fine print paragraph: the one element whose text starts with `text`. */
function finePrint(text: string): HTMLElement {
  return within(screen.getByRole("main")).getByText((_content, element) =>
    element?.tagName === "P" && (element.textContent ?? "").startsWith(text),
  );
}

// ── WD-J1-C04: billingFinePrint shown below upgrade card ─────────────────────

describe("WD-J1-C04 (WD-T-BP-01): billing page — billingFinePrint shown below upgrade card (DA)", () => {
  it("WD-T-BP-01: fine print text contains '14 dages fortrydelsesret'", async () => {
    await renderBilling();
    const paragraph = finePrint(FINE_PRINT_DA);
    expect(paragraph.textContent).toContain("14 dages fortrydelsesret");
    // Below the upgrade card, not inside it.
    const card = screen.getByRole("region", { name: "Monitor Plus" });
    expect(card.contains(paragraph)).toBe(false);
    expect(card.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("WD-T-BP-01b: EN fine print in the EN Monitor locale", async () => {
    mockGetMonitorLocale.mockResolvedValue("en");
    await renderBilling();
    expect(finePrint(FINE_PRINT_EN)).toBeInTheDocument();
  });
});

describe("WD-J1-C04 (WD-T-BP-02): billing page — billingFinePrint shown below subscription card", () => {
  it("WD-T-BP-02: fine print shown when user has active subscription", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    mockMyWithdrawalStatus.mockResolvedValue({ ...WD_STATUS_OPEN, window_open: false });
    await renderBilling();
    const paragraph = finePrint(FINE_PRINT_DA);
    const card = screen.getByRole("region", { name: "Monitor Plus" });
    expect(card.contains(paragraph)).toBe(false);
    expect(card.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ── WD-J1-C05: billingFinePrint link to /terms ───────────────────────────────

describe("WD-J1-C05 (WD-T-BP-03): billing page — fine print has link to /terms", () => {
  it("WD-T-BP-03: a link to /terms or handelsbetingelser exists in fine print area", async () => {
    await renderBilling();
    const link = within(finePrint(FINE_PRINT_DA)).getByRole("link", { name: TERMS_LINK_DA });
    // The main site's terms page (absolute: the billing page is served on the Monitor host).
    expect(link).toHaveAttribute("href", "http://localhost:3000/terms");
  });

  it("WD-T-BP-03b: EN links the English terms page", async () => {
    mockGetMonitorLocale.mockResolvedValue("en");
    await renderBilling();
    const link = within(finePrint(FINE_PRINT_EN)).getByRole("link", { name: TERMS_LINK_EN });
    expect(link).toHaveAttribute("href", "http://localhost:3000/en/terms");
  });
});

// ── WD-J4-C01: window_open=true → "Fortryd aftale" button + deadline ─────────

describe("WD-J4-C01 (WD-T-BP-04): billing page — window_open shows 'Fortryd aftale' button", () => {
  it("WD-T-BP-04: 'Fortryd aftale' link-button visible and links to /monitor/billing/withdraw", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    mockMyWithdrawalStatus.mockResolvedValue(WD_STATUS_OPEN);
    await renderBilling();
    const link = screen.getByRole("link", { name: /fortryd aftale/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/monitor/billing/withdraw");
  });

  it("WD-T-BP-05: deadline date shown next to button", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    mockMyWithdrawalStatus.mockResolvedValue(WD_STATUS_OPEN);
    await renderBilling();
    // Deadline 2026-11-30T23:00:00Z is the start of 1 Dec in Copenhagen: the last day is 30 November.
    const deadline = within(screen.getByRole("main")).getByText("Fortrydelsesfrist: 30. november 2026");
    expect(screen.getByRole("link", { name: "Fortryd aftale" })).toHaveAttribute("aria-describedby", deadline.id);
  });

  it("WD-T-BP-05b: EN label and deadline", async () => {
    mockGetMonitorLocale.mockResolvedValue("en");
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    mockMyWithdrawalStatus.mockResolvedValue(WD_STATUS_OPEN);
    await renderBilling();
    expect(screen.getByRole("link", { name: "Withdraw from agreement" })).toBeInTheDocument();
    expect(screen.getByText("Withdrawal deadline: 30 November 2026")).toBeInTheDocument();
  });
});

describe("WD-J4-C01: billing page — window_open=false → no 'Fortryd aftale' button", () => {
  it("window closed: no 'Fortryd aftale' button", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    mockMyWithdrawalStatus.mockResolvedValue({ ...WD_STATUS_OPEN, window_open: false });
    await renderBilling();
    const links = screen.queryAllByRole("link", { name: /fortryd aftale/i });
    expect(links).toHaveLength(0);
    expect(screen.queryByText(/Fortrydelsesfrist/)).not.toBeInTheDocument();
  });
});

// ── Withdrawal exists notices ─────────────────────────────────────────────────

describe("WD-J4-C01: billing page — withdrawal received/completed shows notice", () => {
  it("received: in-progress notice shown", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    mockMyWithdrawalStatus.mockResolvedValue({
      ...WD_STATUS_OPEN, window_open: false,
      withdrawal: { id: "00000000-0000-0000-0d1d-000000000001", status: "received", requested_at: "2026-11-14T10:00:00Z", paid_ore: null, retained_ore: null, refund_ore: null, refunded_at: null },
    });
    await renderBilling();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Vi har modtaget din fortrydelse (14. november 2026) og behandler den. Du får en kvittering på e-mail.",
    );
    expect(within(status).getByRole("link", { name: "Se din fortrydelse" })).toHaveAttribute(
      "href",
      "/monitor/billing/withdraw",
    );
  });

  it("completed: notice with the refund amount; the subscription has ended, so the upgrade card shows", async () => {
    mockMyWithdrawalStatus.mockResolvedValue({
      ...WD_STATUS_OPEN, status: "canceled", window_open: false,
      withdrawal: {
        id: "00000000-0000-0000-0d1d-000000000001", status: "completed", requested_at: "2026-11-14T10:00:00Z",
        paid_ore: 1000, retained_ore: 33, refund_ore: 967, refunded_at: "2026-11-14T11:00:00Z",
      },
    });
    await renderBilling();
    expect(screen.getByRole("status")).toHaveTextContent("Din fortrydelse er gennemført. Vi har tilbagebetalt 9,67 kr.");
  });

  it("completed with nothing refunded: the nothing-to-refund wording", async () => {
    mockMyWithdrawalStatus.mockResolvedValue({
      ...WD_STATUS_OPEN, status: "canceled", window_open: false,
      withdrawal: {
        id: "00000000-0000-0000-0d1d-000000000001", status: "completed", requested_at: "2026-11-14T10:00:00Z",
        paid_ore: 0, retained_ore: 0, refund_ore: 0, refunded_at: null,
      },
    });
    await renderBilling();
    expect(screen.getByRole("status")).toHaveTextContent("Din fortrydelse er gennemført. Der var intet at tilbagebetale.");
  });

  it("no withdrawal: no withdrawal notice", async () => {
    mockGetCurrentSubscription.mockResolvedValue(SUB_ACTIVE);
    mockMyWithdrawalStatus.mockResolvedValue(WD_STATUS_OPEN);
    await renderBilling();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

// ── WD-J9-C05 (design review D6): VAT and cancellation stated once ───────────
// The two fine prints of the upgrade state: the card's own (slice 1b) and the legal one below the
// card (slice 1d). The card header's tagline "Opsig når som helst." (planSub, approved 1b mock) is
// not fine print and stays.

/** The upgrade card's own fine print (messages `Payments.billing.finePrint`): the Stripe sentence only. */
const CARD_FINE_PRINT = {
  da: "Betaling via Stripe – du sendes til Stripes sikre betalingsside.",
  en: "Payment via Stripe – you are sent to Stripe's secure payment page.",
} as const;

describe("WD-J9-C05 (D6): billing page upgrade state — VAT and cancellation stated once, in the legal fine print", () => {
  it.each([
    ["da", FINE_PRINT_DA, /moms/gi, /opsig/gi],
    ["en", FINE_PRINT_EN, /VAT/g, /cancel/gi],
  ] as const)("%s: the card's fine print is the Stripe sentence only; VAT and cancellation in the legal fine print below", async (locale, legal, vat, cancellation) => {
    mockGetMonitorLocale.mockResolvedValue(locale);
    await renderBilling();
    const card = screen.getByRole("region", { name: "Monitor Plus" });
    const cardFinePrint = within(card).getByText(CARD_FINE_PRINT[locale], { exact: true });
    expect(cardFinePrint.tagName).toBe("P");
    const legalFinePrint = finePrint(legal);
    expect(card.contains(legalFinePrint)).toBe(false);
    for (const topic of [vat, cancellation]) {
      expect(`${cardFinePrint.textContent} ${legalFinePrint.textContent}`.match(topic)).toHaveLength(1);
      expect((legalFinePrint.textContent ?? "").match(topic)).toHaveLength(1);
    }
    // VAT nowhere else on the page.
    expect((screen.getByRole("main").textContent ?? "").match(vat)).toHaveLength(1);
  });
});
