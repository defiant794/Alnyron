// @vitest-environment jsdom
/**
 * Unit tests: /monitor/(auth)/login/page.tsx
 * Journey: monitor-web-area  MON-AC15, MON-AC22
 *
 * Verifies: labeled fields, "Log ind" button, forgot-password link,
 * noindex meta, error=link_invalid shows role=alert.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";

vi.mock("next-intl/server", async () => {
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: () => "/monitor/login",
}));
vi.mock("@/app/monitor/(auth)/actions", () => ({ signIn: vi.fn() }));
// The page reads the visitor's Monitor language from a cookie; there is no request here: Danish.
vi.mock("@/i18n/monitor-locale", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorLocaleModule>()),
  getMonitorLocale: vi.fn(async () => "da" as const),
}));
// The card frame (brand, layout) has its own tests; here it renders the switcher it is given, then
// the page's content, in the frame's own order.
vi.mock("@/components/monitor/MonitorAuthFrame", () => ({
  default: ({ localeSwitcher, children }: { localeSwitcher?: React.ReactNode; children: React.ReactNode }) => (
    <>
      {localeSwitcher}
      {children}
    </>
  ),
}));

import MonitorLoginPage, { generateMetadata } from "@/app/monitor/(auth)/login/page";
import { loadMessages } from "@/i18n/messages";
import { MONITOR_FORGOT_PASSWORD_PATH } from "@/config/monitor";

const { Auth, Monitor } = loadMessages("da");

type SearchParams = { next?: string | string[]; error?: string | string[] };

async function renderLogin(searchParams: SearchParams = {}) {
  render(await MonitorLoginPage({ searchParams: Promise.resolve(searchParams) }));
}

afterEach(cleanup);

describe("MON-AC15: /monitor/login renders per design", () => {
  it("MON-AC15a: has a labeled email field", async () => {
    await renderLogin();
    expect(screen.getByLabelText(/e-mail/i)).toBeInTheDocument();
  });

  it("MON-AC15b: email field is type=email", async () => {
    await renderLogin();
    expect(screen.getByLabelText(/e-mail/i)).toHaveAttribute("type", "email");
  });

  it("MON-AC15c: has a labeled password field", async () => {
    await renderLogin();
    expect(screen.getByLabelText(/adgangskode/i)).toHaveAttribute("type", "password");
  });

  it("MON-AC15d: has 'Log ind' submit button", async () => {
    await renderLogin();
    expect(screen.getByRole("button", { name: Auth.login.submit })).toBeInTheDocument();
  });

  it("MON-AC15e: has a forgot-password link to /monitor/forgot-password (combined accessible name)", async () => {
    await renderLogin();
    // The link uses aria-labelledby combining the prompt span and link text,
    // producing an accessible name like "Glemt adgangskode? Nulstil".
    const link = screen.getByRole("link", { name: new RegExp(Auth.login.forgotPassword.replace("?", "\\?"), "i") });
    expect(link).toHaveAttribute("href", MONITOR_FORGOT_PASSWORD_PATH);
  });


  it("MON-AC3b: metadata has noindex robots directive", async () => {
    const meta = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(JSON.stringify(meta.robots ?? "")).toMatch(/noindex/);
  });
});

describe("MON-AC15/MON-AC44: error=link_invalid shows role=alert", () => {
  it("MON-AC15f: error=link_invalid shows an alert with DA copy", async () => {
    await renderLogin({ error: "link_invalid" });
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
  });

  it("MON-AC15g: error=link_invalid sets page title to include error prefix", async () => {
    const meta = await generateMetadata({ searchParams: Promise.resolve({ error: "link_invalid" }) });
    expect(String(meta.title ?? "")).toMatch(/fejl/i);
  });
});

describe("MON-AC22: login page passes only an accepted monitor next param", () => {
  /** The sign-in form's own hidden `next` (the language switcher posts one too). */
  function signInNext() {
    const form = screen.getByRole("button", { name: Auth.login.submit }).closest("form");
    return form?.querySelector<HTMLInputElement>('input[type="hidden"][name="next"]') ?? null;
  }

  it("MON-AC22f: /monitor/dashboard is passed through as next", async () => {
    await renderLogin({ next: "/monitor/dashboard" });
    expect(signInNext()?.value).toBe("/monitor/dashboard");
  });

  it("MON-AC22g: /admin/x is rejected and not placed in the form", async () => {
    await renderLogin({ next: "/admin/set-password" });
    expect(signInNext()?.value ?? "").not.toBe("/admin/set-password");
  });
});

describe("AC-I18N-MON-15 (login page): the DA | EN switcher returns to this login page", () => {
  function switcherNext() {
    const nav = screen.getByRole("navigation", { name: "Sprog" });
    return nav.querySelector<HTMLInputElement>('input[name="next"]')?.value;
  }

  it("AC-I18N-MON-15-login-a: without a query, it returns to /monitor/login", async () => {
    await renderLogin();
    expect(switcherNext()).toBe("/monitor/login");
  });

  it("AC-I18N-MON-15-login-b: the accepted next and the link-invalid notice survive the switch", async () => {
    await renderLogin({ next: "/monitor/dashboard", error: "link_invalid" });
    expect(switcherNext()).toBe("/monitor/login?next=%2Fmonitor%2Fdashboard&error=link_invalid");
  });

  it("AC-I18N-MON-15-login-c: a rejected next is not carried into the switch", async () => {
    await renderLogin({ next: "/admin/set-password" });
    expect(switcherNext()).toBe("/monitor/login");
  });
});
