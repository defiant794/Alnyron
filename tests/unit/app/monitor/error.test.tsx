// @vitest-environment jsdom
/**
 * Unit tests: src/app/monitor/error.tsx — the Monitor error boundary's frame
 * in the visitor's Monitor language.
 * Journey: monitor-i18n (Monitor UI in the chosen language)
 *
 * The boundary is a client component: its language is `useLocale()`, the
 * Monitor root layout's NextIntlClientProvider, which each case sets. In
 * English the ALNYRON lockup links the English frontpage (`/en`); in Danish
 * (the default) the bare main-site origin.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NextIntlClientProvider, type Locale } from "next-intl";
import type * as NextNavigation from "next/navigation";

// The retry needs the app router; the frontpage link goes through next-intl's
// navigation, which needs the real module: a partial mock.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/config/env", () => ({
  parseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
}));

vi.mock("next/image", () => ({
  default: ({ alt, className }: { alt: string; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} className={className ?? ""} />
  ),
}));

import MonitorError from "@/app/monitor/error";
import { loadMessages } from "@/i18n/messages";

afterEach(cleanup);

/** The boundary under the Monitor root layout's provider in `locale`. */
function renderError(locale: Locale) {
  render(
    <NextIntlClientProvider locale={locale} messages={loadMessages(locale)}>
      <MonitorError error={new Error("boom")} reset={vi.fn()} />
    </NextIntlClientProvider>,
  );
}

describe("MonitorError in the visitor's Monitor language", () => {
  it("in English it renders the English error and the ALNYRON lockup links the English frontpage (/en)", () => {
    renderError("en");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(loadMessages("en").Auth.error.title);
    expect(screen.getByRole("link", { name: "Alnyron" })).toHaveAttribute("href", "http://localhost:3000/en");
  });

  it("in Danish (the default) it renders the Danish error and the lockup links the bare main-site origin", () => {
    renderError("da");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(loadMessages("da").Auth.error.title);
    expect(screen.getByRole("link", { name: "Alnyron" })).toHaveAttribute("href", "http://localhost:3000");
  });
});
