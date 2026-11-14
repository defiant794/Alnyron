// @vitest-environment jsdom
/**
 * Unit tests: src/app/monitor/(panel)/billing/withdraw/page.tsx
 * Journey: payments-slice1d-withdrawal (+ its design addendum, J9)
 * Criteria: WD-J4-C02, WD-J4-C04, WD-J5-C01, WD-J5-C02, WD-J9-C02, WD-J9-C03, WD-J9-C04
 *
 * Coverage:
 *   - window open + no prior withdrawal: form with name field, statement, estimate, button, back link
 *   - window open + no consent: statementEffectNoConsent shown; statementEffect not shown
 *   - window open + consent: statementEffect shown
 *   - withdrawal exists (completed): receipt state, refund amount, no form
 *   - withdrawal exists (received): in-progress notice, no form
 *   - no subscription / window closed: closed-window notice, no form
 *   - ?error=window_expired: expired notice shown
 *   - ?error=unavailable: unavailable notice shown; no notice once a withdrawal is recorded
 *   - name field: label "Dit navn" (DA), autocomplete="name", required
 *   - submit button: "Bekræft fortrydelse" (DA)
 *   - back link: points to /monitor/billing; at least 44×44 (min-h-11 + min-w-11)
 *   - ?error=invalid_input: name field aria-invalid, described by the hint and the alert
 *   - the estimate's timing disclaimer only with a recorded consent
 *
 * Notes:
 *   - translations are the real messages (next-intl's createTranslator over messages/*.json, with
 *     the page's namespace), so the asserted copy is the shipped copy;
 *   - the statementEffect assertion pins the legal module's wording ("fratrukket betaling for den
 *     tid, abonnementet har været aktivt");
 *   - the page names the plan of exactly the reported subscription (C-4 "contract (plan name,
 *     interval, start date)"), so the billing service mock has getSubscriptionPlan;
 *   - MonitorShell's own dependencies are mocked as in billing-page.test.tsx (sign-out action,
 *     site env, current route, next/image).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as NextNavigation from "next/navigation";
import type * as EnvModule from "@/config/env";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";

// ── vi.hoisted ────────────────────────────────────────────────────────────────

const { mockRequireMonitor, mockGetMyWithdrawalStatus, mockGetSubscriptionPlan, mockGetMonitorLocale } = vi.hoisted(
  () => ({
    mockRequireMonitor:        vi.fn(),
    mockGetMyWithdrawalStatus: vi.fn(),
    mockGetSubscriptionPlan:   vi.fn(),
    mockGetMonitorLocale:      vi.fn(),
  }),
);

// Real next-intl formatting over the real messages; a missing key throws. The factory is hoisted
// above the static imports, so it loads its modules itself.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { loadMessages } = await import("@/i18n/messages");
  return {
    getTranslations: vi.fn(
      async ({ locale, namespace }: { locale: "da" | "en"; namespace?: "Payments.withdraw" }) =>
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
  usePathname: () => "/monitor/billing/withdraw",
}));
vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
vi.mock("@/services/payments/billing", () => ({
  getMyWithdrawalStatus: mockGetMyWithdrawalStatus,
  getSubscriptionPlan: mockGetSubscriptionPlan,
}));
vi.mock("@/i18n/monitor-locale", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorLocaleModule>()),
  getMonitorLocale: mockGetMonitorLocale,
}));
vi.mock("@/app/monitor/(panel)/billing/withdraw/actions", () => ({ withdrawSubscription: vi.fn() }));
vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  parseSiteEnv: () => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }),
}));
vi.mock("@/i18n/current-route", () => ({ useCurrentPath: () => "/monitor/billing/withdraw" }));
vi.mock("@/components/site/SiteFooter", () => ({ default: () => <footer /> }));
vi.mock("@/components/monitor/MonitorMainNav", () => ({ default: () => <nav /> }));
vi.mock("@/components/site/SiteMenu", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/SubmitButton", () => ({ default: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button> }));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock("next/link", () => ({
  default: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import WithdrawPage, { generateMetadata } from "@/app/monitor/(panel)/billing/withdraw/page";
import { MONITOR_ROBOTS } from "@/config/monitor";

afterEach(cleanup);

const SESSION = { userId: "user-1", email: "user@test.local", role: "monitor_user" as const };
const WD_STATUS_OPEN = {
  subscription_id: "sub_test", status: "active", started_at: "2026-11-14T00:00:00Z",
  window_open: true, has_consent: true,
  deadline_at: "2026-11-30T23:00:00Z",
  withdrawal: null,
  invoice: { stripe_invoice_id: "in_test", amount_total_ore: 1000, period_start: "2026-11-01T00:00:00Z", period_end: "2026-12-01T00:00:00Z" },
};
const PLAN = { planName: "Monitor Plus", interval: "year" as const, amountOre: 9500 };

/** The legal module's statementEffect / statementEffectNoConsent (DA), pinned as literals. */
const EFFECT_CONSENT_DA = "fratrukket betaling for den tid, abonnementet har været aktivt";
const EFFECT_NO_CONSENT_DA = "vi tilbagebetaler hele det beløb, du har betalt";

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMonitor.mockResolvedValue(SESSION);
  mockGetMyWithdrawalStatus.mockResolvedValue(WD_STATUS_OPEN);
  mockGetSubscriptionPlan.mockResolvedValue(PLAN);
  mockGetMonitorLocale.mockResolvedValue("da");
});

async function renderWithdraw(params: Record<string, string> = {}) {
  return render(await WithdrawPage({ searchParams: Promise.resolve(params) }));
}

const mainText = () => screen.getByRole("main").textContent ?? "";

// ── WD-J4-C02: form shown when window open ────────────────────────────────────

describe("WD-J4-C02 (WD-T-WP-01): withdraw page — form shown when window is open", () => {
  it("WD-T-WP-01: form has name field labeled 'Dit navn' (DA), required, autocomplete=name", async () => {
    await renderWithdraw();
    const main = within(screen.getByRole("main"));
    const nameInput = main.getByLabelText(/dit navn/i);
    expect(nameInput).toBeInTheDocument();
    expect(nameInput.getAttribute("autocomplete")).toBe("name");
    expect(nameInput).toBeRequired();
    expect(nameInput).toHaveAttribute("name", "name");
    expect(nameInput).toHaveAttribute("maxlength", "200");
  });

  it("WD-T-WP-02: 'Bekræft fortrydelse' submit button present", async () => {
    await renderWithdraw();
    expect(screen.getByRole("button", { name: /bekræft fortrydelse/i })).toBeInTheDocument();
  });

  it("WD-T-WP-03: back link to /monitor/billing", async () => {
    await renderWithdraw();
    const backLink = screen.getByRole("link", { name: /tilbage|back/i });
    expect(backLink.getAttribute("href")).toBe("/monitor/billing");
  });

  it("WD-T-WP-01b: account email shown read-only", async () => {
    await renderWithdraw();
    expect(mainText()).toContain("user@test.local");
    expect(screen.queryByDisplayValue("user@test.local")).not.toBeInTheDocument();
  });

  it("WD-T-WP-01c: statement text shown (startDate filled)", async () => {
    await renderWithdraw();
    const main = within(screen.getByRole("main"));
    expect(
      main.getByText(
        "Jeg meddeler herved, at jeg fortryder min aftale om Monitor-abonnement, indgået den 14. november 2026.",
      ),
    ).toBeInTheDocument();
  });

  it("WD-T-WP-01d: contract details: plan name, billing period and the start date, of the reported subscription", async () => {
    await renderWithdraw();
    expect(mockGetSubscriptionPlan).toHaveBeenCalledExactlyOnceWith("sub_test");
    const main = within(screen.getByRole("main"));
    expect(main.getByText("Monitor Plus")).toBeInTheDocument();
    expect(main.getByText("Årlig")).toBeInTheDocument();
    expect(main.getByText("14. november 2026")).toBeInTheDocument();
  });

  it("WD-T-WP-01e: the estimate is labelled 'Anslået' and never exceeds what was paid", async () => {
    await renderWithdraw();
    expect(mainText()).toMatch(/Anslået tilbagebetaling: [\d,.]+ kr af 10 kr/);
  });

  it("WD-T-WP-01f: step 2 of 2 and the lead", async () => {
    await renderWithdraw();
    expect(mainText()).toContain("Trin 2 af 2");
    expect(screen.getByRole("heading", { level: 1, name: "Fortryd aftale" })).toBeInTheDocument();
  });

  it("WD-T-WP-01g: EN copy and statement in the EN Monitor locale", async () => {
    mockGetMonitorLocale.mockResolvedValue("en");
    await renderWithdraw();
    expect(screen.getByLabelText(/your name/i)).toBeRequired();
    expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeInTheDocument();
    expect(mainText()).toContain(
      "I hereby give notice that I withdraw from my agreement for the Monitor subscription, entered into on 14 November 2026.",
    );
    expect(mainText()).toMatch(/Estimated refund: [\d,.]+ kr of 10 kr/);
  });

  it("generateMetadata: the localized title and the Monitor robots", async () => {
    expect(await generateMetadata()).toEqual({ title: "Fortryd aftale", robots: MONITOR_ROBOTS });
  });
});

describe("WD-J4-C02: withdraw page — statementEffect vs statementEffectNoConsent", () => {
  it("has_consent=true: statementEffect shown; statementEffectNoConsent absent", async () => {
    await renderWithdraw();
    expect(mainText()).toContain(EFFECT_CONSENT_DA);
    expect(mainText()).not.toContain(EFFECT_NO_CONSENT_DA);
  });

  it("has_consent=false: statementEffectNoConsent shown (full refund wording)", async () => {
    mockGetMyWithdrawalStatus.mockResolvedValue({ ...WD_STATUS_OPEN, has_consent: false });
    await renderWithdraw();
    expect(mainText()).toMatch(/hele det beløb|full amount/i);
    expect(mainText()).not.toContain(EFFECT_CONSENT_DA);
    // Without a consent nothing is retained: the estimate is the full amount.
    expect(mainText()).toContain("Anslået tilbagebetaling: 10 kr af 10 kr");
  });
});

describe("WD-J4-C02: withdraw page — no usable invoice: no estimate, the form stays usable", () => {
  it.each([
    ["no invoice recorded yet", null],
    ["an invoice without a period", { ...WD_STATUS_OPEN.invoice, period_start: null, period_end: null }],
    ["an empty period (computeWithdrawalRefund throws)", { ...WD_STATUS_OPEN.invoice, period_end: WD_STATUS_OPEN.invoice.period_start }],
  ])("%s → no 'Anslået' line; name field and 'Bekræft fortrydelse' still shown", async (_case, invoice) => {
    mockGetMyWithdrawalStatus.mockResolvedValue({ ...WD_STATUS_OPEN, invoice });
    await renderWithdraw();
    expect(mainText()).not.toContain("Anslået");
    expect(screen.getByLabelText(/dit navn/i)).toBeRequired();
    expect(screen.getByRole("button", { name: /bekræft fortrydelse/i })).toBeInTheDocument();
  });
});

// ── WD-J4-C04: receipt state when withdrawal exists ───────────────────────────

describe("WD-J4-C04 (WD-T-WP-04): withdraw page — receipt state when withdrawal completed", () => {
  it("WD-T-WP-04: completed withdrawal: receipt state shown, no form", async () => {
    mockGetMyWithdrawalStatus.mockResolvedValue({
      ...WD_STATUS_OPEN, window_open: false,
      withdrawal: {
        id: "00000000-0000-0000-0d1d-000000000001", status: "completed",
        requested_at: "2026-11-14T10:00:00Z",
        paid_ore: 1000, retained_ore: 33, refund_ore: 967, refunded_at: "2026-11-14T11:00:00Z",
      },
    });
    await renderWithdraw();
    expect(screen.queryByLabelText(/dit navn/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bekræft fortrydelse/i })).not.toBeInTheDocument();
    const main = within(screen.getByRole("main"));
    expect(main.getByText("Gennemført")).toBeInTheDocument();
    expect(main.getByText("10 kr")).toBeInTheDocument();
    expect(main.getByText("0,33 kr")).toBeInTheDocument();
    expect(main.getByText("9,67 kr")).toBeInTheDocument();
    expect(main.getByText("14. november 2026 kl. 11.00")).toBeInTheDocument();
  });
});

describe("WD-J4-C04: withdraw page — in-progress (received) notice", () => {
  it("received: in-progress notice shown, no form", async () => {
    mockGetMyWithdrawalStatus.mockResolvedValue({
      ...WD_STATUS_OPEN, window_open: false,
      withdrawal: { id: "00000000-0000-0000-0d1d-000000000001", status: "received", requested_at: "2026-11-14T10:00:00Z", paid_ore: null, retained_ore: null, refund_ore: null, refunded_at: null },
    });
    await renderWithdraw();
    expect(screen.queryByLabelText(/dit navn/i)).not.toBeInTheDocument();
    expect(screen.getByText("Modtaget, behandles")).toBeInTheDocument();
    expect(mainText()).not.toContain("Tilbagebetalt");
  });
});

// ── WD-J5-C01: window closed → closed notice, no form ────────────────────────

describe("WD-J5-C01 (WD-T-WP-closed): withdraw page — window closed, no prior withdrawal", () => {
  it("window closed: notice shown, no form, no button", async () => {
    mockGetMyWithdrawalStatus.mockResolvedValue({ ...WD_STATUS_OPEN, window_open: false });
    await renderWithdraw();
    expect(screen.queryByLabelText(/dit navn/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bekræft fortrydelse/i })).not.toBeInTheDocument();
    expect(screen.getByText("Fortrydelsesfristen for dit abonnement er udløbet.")).toBeInTheDocument();
    expect(mockGetSubscriptionPlan).not.toHaveBeenCalled();
  });

  it("no subscription: notice shown, no form", async () => {
    mockGetMyWithdrawalStatus.mockResolvedValue(null);
    await renderWithdraw();
    expect(screen.queryByLabelText(/dit navn/i)).not.toBeInTheDocument();
    expect(screen.getByText("Du har ikke et abonnement, der kan fortrydes.")).toBeInTheDocument();
  });
});

// ── ?error= notices ───────────────────────────────────────────────────────────

describe("WD-J5-C01: withdraw page — ?error=window_expired shows expired notice", () => {
  it("?error=window_expired: expired notice in page", async () => {
    await renderWithdraw({ error: "window_expired" });
    expect(screen.getByRole("alert")).toHaveTextContent("Fortrydelsesfristen er udløbet.");
  });
});

describe("WD-J5-C04: withdraw page — ?error=unavailable shows unavailable notice", () => {
  it("?error=unavailable: unavailable/try-again notice shown", async () => {
    await renderWithdraw({ error: "unavailable" });
    expect(screen.getByRole("alert")).toHaveTextContent(/prøv igen/i);
  });

  it.each(["unauthenticated", "invalid_input", "not_withdrawable"])("?error=%s: one alert", async (code) => {
    await renderWithdraw({ error: code });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("an unknown ?error value shows no alert", async () => {
    await renderWithdraw({ error: "<script>" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("WD-J5-C06 (WD-T-WP-err-recorded): withdraw page — a failed submit's notice is not shown once the withdrawal is recorded", () => {
  it.each(["unavailable", "invalid_input", "unauthenticated", "not_withdrawable", "window_expired"])(
    "?error=%s with a recorded withdrawal: the receipt alone, no alert",
    async (code) => {
      mockGetMyWithdrawalStatus.mockResolvedValue({
        ...WD_STATUS_OPEN, window_open: false,
        withdrawal: { id: "00000000-0000-0000-0d1d-000000000001", status: "received", requested_at: "2026-11-14T10:00:00Z", paid_ore: null, retained_ore: null, refund_ore: null, refunded_at: null },
      });
      await renderWithdraw({ error: code });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText("Modtaget, behandles")).toBeInTheDocument();
    },
  );
});

// ── WD-J9 (design review D2-D4) ───────────────────────────────────────────────

const LOCALE_COPY = {
  da: {
    back: "Tilbage",
    nameLabel: "Dit navn",
    hint: "Dit fulde navn, højst 200 tegn.",
    invalidInput: "Skriv dit navn (højst 200 tegn), og prøv igen.",
    estimate: "Anslået tilbagebetaling: 10 kr af 10 kr",
    disclaimer: "Det endelige beløb beregnes ud fra tidspunktet, hvor vi modtager din fortrydelse.",
  },
  en: {
    back: "Back",
    nameLabel: "Your name",
    hint: "Your full name, at most 200 characters.",
    invalidInput: "Enter your name (at most 200 characters) and try again.",
    estimate: "Estimated refund: 10 kr of 10 kr",
    disclaimer: "The final amount is calculated from the time we receive your withdrawal.",
  },
} as const;

const LOCALES = ["da", "en"] as const;

// jsdom has no layout: the measured box (EN at 1280px) is E2E WD-J9-C02
// (tests/e2e/monitor-withdrawal-design.spec.ts). Here: the classes that size it.
describe("WD-J9-C02 (D2): withdraw page — the back link is at least 44×44px", () => {
  it.each(LOCALES)("%s: the back link is an inline-flex box with min-h-11 and min-w-11 (44px each)", async (locale) => {
    mockGetMonitorLocale.mockResolvedValue(locale);
    await renderWithdraw();
    const back = within(screen.getByRole("main")).getByRole("link", { name: LOCALE_COPY[locale].back });
    expect(back).toHaveAttribute("href", "/monitor/billing");
    expect(back).toHaveClass("inline-flex", "min-h-11", "min-w-11");
  });

  it("the receipt state keeps the same back link", async () => {
    mockGetMyWithdrawalStatus.mockResolvedValue({
      ...WD_STATUS_OPEN, window_open: false,
      withdrawal: { id: "00000000-0000-0000-0d1d-000000000001", status: "received", requested_at: "2026-11-14T10:00:00Z", paid_ore: null, retained_ore: null, refund_ore: null, refunded_at: null },
    });
    await renderWithdraw();
    expect(screen.getByRole("link", { name: "Tilbage" })).toHaveClass("inline-flex", "min-h-11", "min-w-11");
  });
});

describe("WD-J9-C03 (D3): withdraw page — ?error=invalid_input marks the name field invalid, described by the alert", () => {
  it.each(LOCALES)("%s: aria-invalid=true; aria-describedby = the hint, then the alert (which has an id)", async (locale) => {
    mockGetMonitorLocale.mockResolvedValue(locale);
    await renderWithdraw({ error: "invalid_input" });
    const copy = LOCALE_COPY[locale];
    const input = screen.getByLabelText(copy.nameLabel);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(copy.invalidInput);
    expect(alert.id).not.toBe("");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)).toHaveTextContent(copy.hint);
    expect(ids[1]).toBe(alert.id);
    expect(input).toHaveAccessibleDescription(`${copy.hint} ${copy.invalidInput}`);
  });

  it("no ?error: no aria-invalid; described by the hint only", async () => {
    await renderWithdraw();
    const input = screen.getByLabelText("Dit navn");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input.getAttribute("aria-describedby")).not.toContain(" ");
    expect(input).toHaveAccessibleDescription(LOCALE_COPY.da.hint);
  });

  it.each(["unauthenticated", "not_withdrawable", "window_expired", "unavailable"])(
    "?error=%s (not about the name): the alert shows, the name field is not marked invalid",
    async (code) => {
      await renderWithdraw({ error: code });
      expect(screen.getByRole("alert")).toBeInTheDocument();
      const input = screen.getByLabelText("Dit navn");
      expect(input).not.toHaveAttribute("aria-invalid");
      expect(input).toHaveAccessibleDescription(LOCALE_COPY.da.hint);
    },
  );
});

describe("WD-J9-C04 (D4): withdraw page — the timing disclaimer only with a recorded consent", () => {
  it.each(LOCALES)("%s, no consent record: the full-amount estimate shows, the disclaimer does not", async (locale) => {
    mockGetMonitorLocale.mockResolvedValue(locale);
    mockGetMyWithdrawalStatus.mockResolvedValue({ ...WD_STATUS_OPEN, has_consent: false });
    await renderWithdraw();
    const copy = LOCALE_COPY[locale];
    expect(mainText()).toContain(copy.estimate);
    expect(mainText()).not.toContain(copy.disclaimer);
  });

  it.each(LOCALES)("%s, consent record: the estimate and the disclaimer show", async (locale) => {
    mockGetMonitorLocale.mockResolvedValue(locale);
    await renderWithdraw();
    expect(mainText()).toMatch(locale === "da" ? /Anslået tilbagebetaling: [\d,.]+ kr af 10 kr/ : /Estimated refund: [\d,.]+ kr of 10 kr/);
    expect(screen.getByText(LOCALE_COPY[locale].disclaimer, { exact: true })).toBeInTheDocument();
  });
});
