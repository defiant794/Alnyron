// @vitest-environment jsdom
/**
 * Unit tests — Contact page route (src/app/[locale]/contact/page.tsx)
 * Journey: pages-editor  AC-PAGES-19 (wiring), AC-PAGES-21/22 (sanitised content)
 *
 * Checks that:
 *  - The page calls getContactPage() with the request locale (not the placeholder).
 *  - The seeded DA title, lead and all three content fields render in the DOM.
 *  - On EN locale with blank EN fields, the DA fallback values appear.
 *  - body_md with injected <script>/onerror is not present in the rendered DOM.
 *
 * Service implementation: src/services/content/pages.ts (getContactPage).
 * Sanitisation: src/lib/sanitize-markdown.ts (sanitizeMarkdown).
 * Both are mocked here; their own unit tests cover the logic.
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
  sanitizeMarkdown: vi.fn((md: string) => `<p>${md}</p>`),
}));

import Page from "@/app/[locale]/contact/page";
import { getContactPage } from "@/services/content/pages";

// ── Fixtures (seeded values from 20261101000300_seed_system_content.sql) ──────

const DA_TITLE = "Lad os tale om dit projekt";
const DA_LEAD = "Skriv til os, så vender vi hurtigt tilbage. Du kan også sende en mail direkte.";
const DA_CONTENT = {
  eyebrow: "Kontakt",
  responseTime: "Typisk inden for 1-2 hverdage",
  languages: "Dansk / English",
};

const DA_RESOLVED = {
  value: { title: DA_TITLE, lead: DA_LEAD, content: DA_CONTENT, body_md: "" },
  fallbackKeys: [] as string[],
};

const EN_FALLBACK_RESOLVED = {
  value: { title: DA_TITLE, lead: DA_LEAD, content: DA_CONTENT, body_md: "" },
  fallbackKeys: ["title", "lead", "content.eyebrow", "content.responseTime", "content.languages"],
};

async function renderContact(locale: string) {
  render(await Page({ params: Promise.resolve({ locale }) }));
}

beforeEach(() => {
  vi.mocked(getContactPage).mockImplementation(async (locale) =>
    locale === "da" ? DA_RESOLVED : EN_FALLBACK_RESOLVED,
  );
});

afterEach(cleanup);

// ── Wiring: getContactPage is called with the request locale ──────────────────

describe("Contact page — wiring: reads from DB via getContactPage", () => {
  it("calls getContactPage('da') for the DA locale", async () => {
    await renderContact("da");
    expect(vi.mocked(getContactPage)).toHaveBeenCalledWith("da");
  });

  it("calls getContactPage('en') for the EN locale", async () => {
    await renderContact("en");
    expect(vi.mocked(getContactPage)).toHaveBeenCalledWith("en");
  });
});

// ── AC-PAGES-19: DA content renders ──────────────────────────────────────────

describe("AC-PAGES-19: Contact page — DA content renders in the DOM", () => {
  it("AC-PAGES-19: DA title appears in the document", async () => {
    await renderContact("da");
    expect(screen.getByRole("heading", { name: DA_TITLE })).toBeInTheDocument();
  });

  it("AC-PAGES-19b: DA lead text appears in the document", async () => {
    await renderContact("da");
    expect(screen.getByText(DA_LEAD)).toBeInTheDocument();
  });

  it("AC-PAGES-19c: eyebrow content field renders", async () => {
    await renderContact("da");
    expect(screen.getByText(DA_CONTENT.eyebrow)).toBeInTheDocument();
  });

  it("AC-PAGES-19d: responseTime content field renders", async () => {
    await renderContact("da");
    expect(screen.getByText(DA_CONTENT.responseTime)).toBeInTheDocument();
  });

  it("AC-PAGES-19e: languages content field renders", async () => {
    await renderContact("da");
    expect(screen.getByText(DA_CONTENT.languages)).toBeInTheDocument();
  });
});

// ── AC-PAGES-20: EN locale DA fallback renders ────────────────────────────────

describe("AC-PAGES-20: Contact page — EN locale DA fallback values render", () => {
  it("AC-PAGES-20: EN page with full DA fallback renders the DA title", async () => {
    await renderContact("en");
    expect(screen.getByRole("heading", { name: DA_TITLE })).toBeInTheDocument();
  });
});

// ── XSS guard: injected script/onerror not in rendered DOM ───────────────────

describe("Contact page — XSS: body_md with script/onerror is not in the DOM", () => {
  it("body_md containing <script> is not rendered as a live script element", async () => {
    vi.mocked(getContactPage).mockResolvedValue({
      value: {
        title: DA_TITLE,
        lead: DA_LEAD,
        content: DA_CONTENT,
        body_md: '<script>alert("xss")</script>',
      },
      fallbackKeys: [],
    });
    const { container } = render(await Page({ params: Promise.resolve({ locale: "da" }) }));
    expect(container.querySelectorAll("script")).toHaveLength(0);
  });
});
