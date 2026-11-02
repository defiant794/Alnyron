// @vitest-environment jsdom
/**
 * Unit tests — Privacy page route (src/app/[locale]/privacy/page.tsx)
 * Journey: pages-editor  AC-PAGES-21, 22, 23 (privacy route wiring)
 *
 * Checks that:
 *  - The route calls getPrivacyPage() and passes body_md through sanitizeMarkdown().
 *  - The seeded DA title ("Privatlivspolitik") renders.
 *  - Sanitized body_md HTML is rendered in the DOM.
 *  - body_md containing <script>/onerror passes through sanitizeMarkdown before
 *    reaching the DOM — the rendered output contains no live script or handler.
 *
 * NOTE: src/app/[locale]/privacy/page.tsx does not exist yet (404 route).
 *       This test fails at import level until the route is created (correct RED).
 *
 * Service: src/services/content/pages.ts (getPrivacyPage).
 * Sanitiser: src/lib/sanitize-markdown.ts (sanitizeMarkdown).
 * Both are mocked; their own unit tests cover the logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Dynamic import required: vi.mock factories are hoisted by Vite above all static
// imports, so a static import of the helper would not yet exist at factory time.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/services/content/pages", () => ({
  getHomePage: vi.fn(),
  getContactPage: vi.fn(),
  getPrivacyPage: vi.fn(),
}));
vi.mock("@/lib/sanitize-markdown", () => ({
  sanitizeMarkdown: vi.fn((md: string) => `<p data-testid="sanitized">${md}</p>`),
}));

import Page from "@/app/[locale]/privacy/page";
import { getPrivacyPage } from "@/services/content/pages";
import { sanitizeMarkdown } from "@/lib/sanitize-markdown";

// ── Fixtures (seeded values from 20261101000300_seed_system_content.sql) ──────

const DA_TITLE = "Privatlivspolitik";
const DA_BODY_MD =
  "## Hvilke oplysninger vi behandler\n\n- Kontakthenvendelser: navn og e-mail.";

const DA_RESOLVED = {
  value: {
    title: DA_TITLE,
    lead: "",
    content: { eyebrow: "Privatliv" },
    body_md: DA_BODY_MD,
  },
  fallbackKeys: [] as string[],
};

const EN_FALLBACK_RESOLVED = {
  value: { title: DA_TITLE, lead: "", content: { eyebrow: "Privatliv" }, body_md: DA_BODY_MD },
  fallbackKeys: ["title", "body_md"],
};

async function renderPrivacy(locale: string) {
  render(await Page({ params: Promise.resolve({ locale }) }));
}

beforeEach(() => {
  vi.mocked(getPrivacyPage).mockImplementation(async (locale) =>
    locale === "da" ? DA_RESOLVED : EN_FALLBACK_RESOLVED,
  );
  vi.mocked(sanitizeMarkdown).mockImplementation((md) => `<p data-testid="sanitized">${md}</p>`);
});

afterEach(cleanup);

// ── Wiring ────────────────────────────────────────────────────────────────────

describe("Privacy page — wiring: getPrivacyPage and sanitizeMarkdown called", () => {
  it("calls getPrivacyPage('da') for the DA locale", async () => {
    await renderPrivacy("da");
    expect(vi.mocked(getPrivacyPage)).toHaveBeenCalledWith("da");
  });

  it("passes body_md through sanitizeMarkdown before rendering", async () => {
    await renderPrivacy("da");
    expect(vi.mocked(sanitizeMarkdown)).toHaveBeenCalledWith(DA_BODY_MD);
  });

  it("renders the sanitized HTML output (not the raw body_md)", async () => {
    await renderPrivacy("da");
    // The mock returns <p data-testid="sanitized">…</p>; the route must render it.
    expect(screen.getByTestId("sanitized")).toBeInTheDocument();
  });
});

// ── Title renders ─────────────────────────────────────────────────────────────

describe("Privacy page — DA title renders in the DOM", () => {
  it("DA title 'Privatlivspolitik' appears as a heading", async () => {
    await renderPrivacy("da");
    expect(screen.getByRole("heading", { name: DA_TITLE })).toBeInTheDocument();
  });

  it("EN locale with DA fallback renders the DA title", async () => {
    await renderPrivacy("en");
    expect(screen.getByRole("heading", { name: DA_TITLE })).toBeInTheDocument();
  });
});

// ── XSS guard: route passes body_md through sanitizeMarkdown ──────────────────

describe("Privacy page — XSS: body_md goes through sanitizeMarkdown, not dangerouslySetInnerHTML raw", () => {
  it("body_md with <script> is passed to sanitizeMarkdown (not bypassed)", async () => {
    const maliciousBody = '<script>alert("xss")</script>';
    vi.mocked(getPrivacyPage).mockResolvedValue({
      value: { title: DA_TITLE, lead: "", content: { eyebrow: "Privatliv" }, body_md: maliciousBody },
      fallbackKeys: [],
    });
    // The mock sanitizeMarkdown returns a safe <p> wrapper; the live <script>
    // must not appear in the rendered DOM regardless.
    vi.mocked(sanitizeMarkdown).mockReturnValue("<p>sanitized</p>");

    const { container } = render(await Page({ params: Promise.resolve({ locale: "da" }) }));

    // sanitizeMarkdown must have been called with the malicious body_md
    expect(vi.mocked(sanitizeMarkdown)).toHaveBeenCalledWith(maliciousBody);
    // No live script element in the DOM
    expect(container.querySelectorAll("script")).toHaveLength(0);
  });
});
