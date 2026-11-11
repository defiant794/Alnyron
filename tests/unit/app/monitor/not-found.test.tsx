// @vitest-environment jsdom
/**
 * Unit tests: src/app/monitor/not-found.tsx — Monitor 404 boundary metadata
 * and its frame's lockup in the visitor's Monitor language.
 * Journey: a11y-polish  A11Y-05; monitor-i18n (Monitor UI in the chosen language)
 *
 * generateMetadata() must be exported by the not-found boundary and return
 *   { title: "Siden findes ikke", robots: "noindex, nofollow" }
 * so WCAG 2.4.2 (Page Titled, Level A) is satisfied on the Monitor 404 page.
 * With monitor-locale=en the 404 renders in English and its ALNYRON lockup
 * links the English frontpage (`/en`), as every other Monitor card does.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Metadata } from "next";
import type * as NextNavigation from "next/navigation";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";

vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);

// MonitorAuthFrame renders next/link and links the frontpage through next-intl's
// navigation, which needs the real module: a partial mock.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  redirect: vi.fn(),
  notFound: vi.fn(),
  usePathname: () => "/monitor",
  useRouter: () => ({ push: vi.fn() }),
}));

// The boundary reads the visitor's Monitor language from a cookie; there is no
// request here: Danish, unless a case picks English.
vi.mock("@/i18n/monitor-locale", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorLocaleModule>()),
  getMonitorLocale: vi.fn(async () => "da" as const),
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

// Namespace import: generateMetadata is read as an optional export.
import * as NotFoundModule from "@/app/monitor/not-found";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { loadMessages } from "@/i18n/messages";

const { generateMetadata } = NotFoundModule as { generateMetadata?: () => Promise<Metadata> };
const MonitorNotFound = NotFoundModule.default;

afterEach(cleanup);

describe("A11Y-05: MonitorNotFound — generateMetadata export", () => {
  it("A11Y-05a: generateMetadata is a function (export exists)", () => {
    expect(typeof generateMetadata).toBe("function");
  });

  it("A11Y-05b: generateMetadata() resolves title 'Siden findes ikke'", async () => {
    const metadata = await generateMetadata!();
    expect(metadata.title).toBe("Siden findes ikke");
  });

  it("A11Y-05c: generateMetadata() resolves robots 'noindex, nofollow'", async () => {
    const metadata = await generateMetadata!();
    expect(metadata.robots).toBe("noindex, nofollow");
  });

  it("A11Y-05d: generateMetadata() title is a non-empty string", async () => {
    const metadata = await generateMetadata!();
    expect(typeof metadata.title).toBe("string");
    expect((metadata.title as string).length).toBeGreaterThan(0);
  });
});

describe("MonitorNotFound in the visitor's Monitor language", () => {
  it("in English (monitor-locale=en) it renders the English 404 and the ALNYRON lockup links the English frontpage (/en)", async () => {
    vi.mocked(getMonitorLocale).mockResolvedValueOnce("en");
    render(await MonitorNotFound());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(loadMessages("en").Monitor.notFound.title);
    expect(screen.getByRole("link", { name: "Alnyron" })).toHaveAttribute("href", "http://localhost:3000/en");
  });
});
