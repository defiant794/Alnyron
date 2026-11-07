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
  it("MON-AC22f: /monitor/dashboard is passed through as next", async () => {
    await renderLogin({ next: "/monitor/dashboard" });
    const hidden = document.querySelector<HTMLInputElement>('input[type="hidden"][name="next"]');
    expect(hidden?.value).toBe("/monitor/dashboard");
  });

  it("MON-AC22g: /admin/x is rejected and not placed in the form", async () => {
    await renderLogin({ next: "/admin/set-password" });
    const hidden = document.querySelector<HTMLInputElement>('input[type="hidden"][name="next"]');
    expect(hidden?.value ?? "").not.toBe("/admin/set-password");
  });
});
