// @vitest-environment jsdom
/**
 * Unit tests: the skip link is the first Tab stop of every MyLife page.
 * Journey: mylife-login  ML-AC1 (login), ML-AC2 (landing after sign-in),
 * ML-AC6 (no-access); design review 2026-11-01 round 2 (WCAG 2.4.1 / 2.4.3).
 *
 * Each page is rendered inside the real MyLife layout, as the server sends
 * it. From a blurred start (`<body>`), Tab moves through the tabbable
 * elements in document order (no positive tabindex reorders them), so the
 * first one must be "Spring til indhold" pointing at `<main id="main">`.
 * After a client-side navigation the browser would otherwise resume Tab
 * where the old page's focused control was, so the layout also mounts
 * `NavigationFocusReset` (its behaviour: NavigationFocusReset.test.tsx).
 */
import { describe, it, expect, vi } from "vitest";
import type * as NextIntl from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { mockRequireMyLife, mockGetMyLifeAccess, mockFocusReset } = vi.hoisted(() => ({
  mockRequireMyLife: vi.fn(),
  mockGetMyLifeAccess: vi.fn(),
  mockFocusReset: vi.fn(() => null),
}));

// next/font/google only exists under Next's compiler (see layout.test.tsx).
vi.mock("next/font/google", () => ({
  Inter: vi.fn(() => ({ variable: "--font-inter", className: "font-inter" })),
}));
vi.mock("next-intl/server", async () => {
  // vi.mock factories are hoisted above static imports; dynamic import is required.
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
// The client provider is a passthrough (no request config here).
vi.mock("next-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof NextIntl>()),
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("@/services/auth/require-role", () => ({
  requireMyLife: mockRequireMyLife,
  getMyLifeAccess: mockGetMyLifeAccess,
}));
vi.mock("@/app/mylife/(auth)/actions", () => ({ signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/components/ui/NavigationFocusReset", () => ({ default: mockFocusReset }));

import MyLifeRootLayout from "@/app/mylife/layout";
import LoginPage from "@/app/mylife/(auth)/login/page";
import MyLifeHomePage from "@/app/mylife/(panel)/page";
import NoAccessPage from "@/app/mylife/(panel)/no-access/page";
import { loadMessages } from "@/i18n/messages";

const { Auth, SkipLink } = loadMessages("da");

/** What sequential (Tab) navigation can stop on; `tabindex="-1"` targets are only focusable by script. */
const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([type="hidden"]):not([disabled])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** The page inside the MyLife layout, as a parsed document. */
async function renderInLayout(page: ReactNode) {
  const markup = renderToStaticMarkup(await MyLifeRootLayout({ children: page }));
  return new DOMParser().parseFromString(markup, "text/html");
}

/** Asserts the skip link is the first Tab stop and leads to `<main id="main">`. */
function expectSkipLinkFirst(doc: Document) {
  const positive = [...doc.querySelectorAll("[tabindex]")].filter((el) => Number(el.getAttribute("tabindex")) > 0);
  expect(positive, "no positive tabindex reorders the Tab sequence").toEqual([]);

  const first = doc.querySelector(TABBABLE);
  expect(first?.tagName).toBe("A");
  expect(first?.textContent).toBe(SkipLink.label);
  expect(first?.getAttribute("href")).toBe("#main");
  expect(doc.getElementById("main")?.tagName).toBe("MAIN");
}

describe("WCAG 2.4.1/2.4.3: the skip link is the first Tab stop on every MyLife page (design review 2026-11-01)", () => {
  it("ML-AC1ac: on the login page, before the email field", async () => {
    const doc = await renderInLayout(await LoginPage({ searchParams: Promise.resolve({}) }));

    expectSkipLinkFirst(doc);
    expect(doc.querySelectorAll(TABBABLE)[1]?.getAttribute("type")).toBe("email");
  });

  it("ML-AC2h: on the landing, before 'Log ud'", async () => {
    mockRequireMyLife.mockResolvedValue({ userId: "u1", email: "ml@alnyron.dk", role: "mylife_user" });
    const doc = await renderInLayout(await MyLifeHomePage());

    expectSkipLinkFirst(doc);
    expect(doc.querySelectorAll(TABBABLE)[1]?.textContent).toBe(Auth.signOut);
  });

  it("ML-AC6e: on no-access, before 'Log ud' and the switch-account link", async () => {
    mockGetMyLifeAccess.mockResolvedValue({ status: "forbidden", email: "wrong-role@example.com" });
    const doc = await renderInLayout(await NoAccessPage());

    expectSkipLinkFirst(doc);
    expect([...doc.querySelectorAll(TABBABLE)].slice(1).map((el) => el.textContent)).toEqual([
      Auth.signOut,
      Auth.noAccess.switchAccount,
    ]);
  });

  it("ML-AC2i: the layout mounts the focus reset that keeps it first after client-side navigations", async () => {
    await renderInLayout(<p>content</p>);
    expect(mockFocusReset).toHaveBeenCalled();
  });
});
