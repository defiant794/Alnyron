// @vitest-environment jsdom
/**
 * Unit tests — SiteFooter (src/components/site/SiteFooter.tsx)
 * Acceptance: AC-CVR-01 (the footer on every page shows the company's CVR
 * from site_settings.cvr), AC-HOME-09 (© year, company, email, privacy link).
 *
 * The footer is an async server component: it is awaited and its element
 * rendered. Site settings are mocked; NavLink (a client island with its own
 * tests) is a plain anchor here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import type { Locale } from "next-intl";

// vi.mock factories are hoisted above the imports, so the helper is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/services/content/settings", () => ({ getSiteSettings: vi.fn() }));
vi.mock("@/components/site/NavLink", () => ({
  default: ({ href, className, children }: { href: string; className?: string; children: ReactNode }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import SiteFooter from "@/components/site/SiteFooter";
import { getSiteSettings } from "@/services/content/settings";

function mockSettings(cvr: string | null) {
  vi.mocked(getSiteSettings).mockResolvedValue({ companyName: "Alnyron", contactEmail: "info@alnyron.dk", cvr });
}

async function renderFooter(locale: Locale) {
  render(await SiteFooter({ locale }));
  return screen.getByRole("contentinfo");
}

/**
 * The element's text with the `selector` matches left out, whitespace
 * collapsed: leave out `.sr-only` for what a sighted reader sees, or
 * `[aria-hidden="true"]` for what assistive technology reads.
 */
function textWithout(element: Element, selector: string): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll(selector).forEach((node) => node.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings("46887433");
});

afterEach(cleanup);

describe("AC-CVR-01: SiteFooter shows the CVR from site_settings", () => {
  it("AC-CVR-01a: DA copyright line reads '© {year} Alnyron · CVR 46887433'", async () => {
    await renderFooter("da");
    expect(textWithout(screen.getByText(/© \d{4} Alnyron/), ".sr-only")).toMatch(/^© \d{4} Alnyron · CVR 46887433$/);
  });

  it("AC-CVR-01b: EN keeps the Danish 'CVR' label", async () => {
    await renderFooter("en");
    expect(textWithout(screen.getByText(/© \d{4} Alnyron/), ".sr-only")).toMatch(/^© \d{4} Alnyron · CVR 46887433$/);
  });

  it("AC-CVR-01c: follows site_settings.cvr, not a fixed number", async () => {
    mockSettings("12345678");
    const footer = await renderFooter("da");
    expect(footer).toHaveTextContent("CVR 12345678");
    expect(footer).not.toHaveTextContent("46887433");
  });

  it("AC-CVR-01d: leaves the CVR and its separator out while site_settings.cvr is not set", async () => {
    mockSettings(null);
    const footer = await renderFooter("da");
    const copyright = screen.getByText(/© \d{4} Alnyron/);
    expect(copyright).toHaveTextContent(/^© \d{4} Alnyron$/);
    expect(footer).not.toHaveTextContent("CVR");
    expect(footer).not.toHaveTextContent("·");
  });

  it("AC-CVR-01e: the middot separator is hidden from assistive technology; the CVR is not", async () => {
    await renderFooter("da");
    expect(screen.getByText("·")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("CVR 46887433")).not.toHaveAttribute("aria-hidden");
  });

  it("AC-CVR-01f: the CVR stays in the muted small copyright paragraph, read as 'Alnyron, CVR 46887433'", async () => {
    await renderFooter("da");
    const paragraph = screen.getByText("CVR 46887433").closest("p");
    expect(paragraph).toHaveClass("text-small", "text-muted");
    expect(textWithout(paragraph!, '[aria-hidden="true"]')).toMatch(/^© \d{4} Alnyron, CVR 46887433$/);
  });
});

describe("AC-HOME-09: SiteFooter keeps the email and privacy links", () => {
  it("links the contact email and the privacy page", async () => {
    const footer = await renderFooter("da");
    expect(footer.querySelector('a[href="mailto:info@alnyron.dk"]')).toHaveTextContent("info@alnyron.dk");
    expect(screen.getByRole("link", { name: "Privatliv" })).toHaveAttribute("href", "/privacy");
  });

  it("uses the English privacy label and path on EN", async () => {
    await renderFooter("en");
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/en/privacy");
  });
});
// ── SHIP-AC8c: SiteFooter siteOrigin prop makes privacy link absolute ────────

describe("SHIP-AC8c: SiteFooter with siteOrigin prop — absolute privacy link", () => {
  it("SHIP-AC8c-1: siteOrigin='https://alnyron.dk' → privacy link href='https://alnyron.dk/privacy'", async () => {
    render(await SiteFooter({ locale: "da", siteOrigin: "https://alnyron.dk" }));
    const link = screen.getByRole("link", { name: /privatliv/i });
    expect(link).toHaveAttribute("href", "https://alnyron.dk/privacy");
  });

  it("SHIP-AC8c-2: siteOrigin='http://localhost:3000' → privacy link href='http://localhost:3000/privacy'", async () => {
    render(await SiteFooter({ locale: "da", siteOrigin: "http://localhost:3000" }));
    const link = screen.getByRole("link", { name: /privatliv/i });
    expect(link).toHaveAttribute("href", "http://localhost:3000/privacy");
  });

  it("SHIP-AC8c-3: without siteOrigin, privacy link stays relative '/privacy' (default behavior unchanged)", async () => {
    render(await SiteFooter({ locale: "da" }));
    const link = screen.getByRole("link", { name: /privatliv/i });
    expect(link).toHaveAttribute("href", "/privacy");
  });
});
