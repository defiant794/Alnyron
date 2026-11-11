// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorLocaleSwitcher.tsx
 * Journey: monitor-i18n  AC-I18N-MON-11, 12, 13, 14, 15, 16, 17
 *
 * The switcher is a synchronous server component (no "use client") that
 * reads the message catalogues itself, so it renders like any element.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

// setMonitorLocale is the form's action (a server action); the tests only read the form.
vi.mock("@/app/monitor/actions", () => ({
  setMonitorLocale: vi.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import MonitorLocaleSwitcher from "@/components/monitor/MonitorLocaleSwitcher";
import { MONITOR_DASHBOARD_PATH, MONITOR_LOGIN_PATH } from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";

// ── Helpers ────────────────────────────────────────────────────────────────────

afterEach(cleanup);

type Props = { locale: "da" | "en"; currentPath: string };

function renderSwitcher({ locale, currentPath }: Props) {
  render(<MonitorLocaleSwitcher locale={locale} currentPath={currentPath} />);
  return screen.getByRole("navigation");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AC-I18N-MON-11: locale="da" → nav landmark aria-label="Sprog"', () => {
  it('has aria-label "Sprog" (from LanguageSwitcher.label DA) when locale is "da"', () => {
    const nav = renderSwitcher({ locale: "da", currentPath: MONITOR_DASHBOARD_PATH });
    // Messages is typed as typeof da — no cast needed.
    expect(nav).toHaveAttribute("aria-label", loadMessages("da").LanguageSwitcher.label);
  });
});

describe('AC-I18N-MON-12: locale="en" → nav landmark aria-label="Language"', () => {
  it('has aria-label "Language" (from LanguageSwitcher.label EN) when locale is "en"', () => {
    const nav = renderSwitcher({ locale: "en", currentPath: MONITOR_DASHBOARD_PATH });
    expect(nav).toHaveAttribute("aria-label", loadMessages("en").LanguageSwitcher.label);
  });
});

describe('AC-I18N-MON-13: locale="da" → DA marked aria-current, EN not', () => {
  it("DA option carries aria-current, EN option does not", () => {
    const nav = renderSwitcher({ locale: "da", currentPath: MONITOR_DASHBOARD_PATH });
    const current = within(nav).getByText(/^DA$/i, { selector: "[aria-current]" });
    expect(current).toBeInTheDocument();
    // EN option must NOT have aria-current
    const enEl = within(nav).getByText(/^EN$/i);
    expect(enEl).not.toHaveAttribute("aria-current");
    expect(enEl.closest("[aria-current]")).toBeNull();
  });
});

describe('AC-I18N-MON-14: locale="en" → EN marked aria-current, DA not', () => {
  it("EN option carries aria-current, DA option does not", () => {
    const nav = renderSwitcher({ locale: "en", currentPath: MONITOR_DASHBOARD_PATH });
    const current = within(nav).getByText(/^EN$/i, { selector: "[aria-current]" });
    expect(current).toBeInTheDocument();
    const daEl = within(nav).getByText(/^DA$/i);
    expect(daEl).not.toHaveAttribute("aria-current");
    expect(daEl.closest("[aria-current]")).toBeNull();
  });
});

describe("AC-I18N-MON-15: locale=da — EN form posts locale=en + currentPath", () => {
  it("exactly one form in the nav (only the non-current locale submits)", () => {
    const nav = renderSwitcher({ locale: "da", currentPath: MONITOR_DASHBOARD_PATH });
    const forms = nav.querySelectorAll("form");
    expect(forms).toHaveLength(1);
  });

  it("the single form has hidden locale=en and hidden next=the dashboard path", () => {
    const nav = renderSwitcher({ locale: "da", currentPath: MONITOR_DASHBOARD_PATH });
    const forms = nav.querySelectorAll("form");
    const f = forms[0];
    expect(f).not.toBeNull();
    const localeInput = f!.querySelector<HTMLInputElement>('input[name="locale"]');
    const nextInput = f!.querySelector<HTMLInputElement>('input[name="next"]');
    expect(localeInput?.value).toBe("en");
    expect(nextInput?.value).toBe(MONITOR_DASHBOARD_PATH);
  });
});

describe("AC-I18N-MON-16: locale=en — DA form posts locale=da + currentPath", () => {
  it("exactly one form in the nav (only the non-current locale submits)", () => {
    const nav = renderSwitcher({ locale: "en", currentPath: MONITOR_LOGIN_PATH });
    const forms = nav.querySelectorAll("form");
    expect(forms).toHaveLength(1);
  });

  it("the single form has hidden locale=da and hidden next=the login path", () => {
    const nav = renderSwitcher({ locale: "en", currentPath: MONITOR_LOGIN_PATH });
    const forms = nav.querySelectorAll("form");
    const f = forms[0];
    expect(f).not.toBeNull();
    const localeInput = f!.querySelector<HTMLInputElement>('input[name="locale"]');
    const nextInput = f!.querySelector<HTMLInputElement>('input[name="next"]');
    expect(localeInput?.value).toBe("da");
    expect(nextInput?.value).toBe(MONITOR_LOGIN_PATH);
  });
});

describe("AC-I18N-MON-17: 44 × 44 px touch targets (min-h-11 min-w-11)", () => {
  it("every locale submit/indicator carries min-h-11 and min-w-11 Tailwind classes", () => {
    const nav = renderSwitcher({ locale: "da", currentPath: MONITOR_DASHBOARD_PATH });
    // Target elements: submit buttons and the aria-current indicator
    const targets = nav.querySelectorAll<HTMLElement>("button[type=submit], [aria-current]");
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const el of Array.from(targets)) {
      expect(el.className).toMatch(/\bmin-h-11\b/);
      expect(el.className).toMatch(/\bmin-w-11\b/);
    }
  });
});
