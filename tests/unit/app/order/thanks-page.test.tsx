// @vitest-environment jsdom
/**
 * Unit tests: src/app/order/thanks/page.tsx
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-CHK-4 (web layer - thanks page shown after Checkout)
 *
 * Test IDs: S2-T-THANKS-01..05
 *
 * Copy pinned from s2-order-pages.html mock (no em-dash):
 *   heading:    "Tak for din bestilling"
 *   body 1:     A2-1 reservation sentence (replaces the mock's "Betalingen er gennemført."):
 *               "Beløbet reserveres ved bestillingen og trækkes først, når varen sendes."
 *   body 2:     "Vi sender en ordrebekræftelse til din e-mail med ordrenummer,
 *                leveringsadresse og din fortrydelsesret."
 *   dispatch:   "Varen sendes inden for 3 hverdage."
 *   link home:  href="/"
 *   EN (lang=en): "Thank you for your order", the English reservation, confirmation and
 *                 dispatch sentences, home link href="/en"; no Danish copy
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl/server", async () =>
  // Exception: vi.mock factory is hoisted; must dynamically import the helper.
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/components/site/SiteFooter", () => ({ default: () => <footer data-testid="site-footer" /> }));
// Keep the real exports: the home link's getPathname (next-intl createNavigation) reads them at import.
vi.mock("next/navigation", async (importOriginal) => ({
  // Exception: vi.mock factory is hoisted; must dynamically import the original here.
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/order/thanks",
}));

import ThanksPage from "@/app/order/thanks/page";

afterEach(cleanup);

async function renderThanks(params: Record<string, string> = {}) {
  render(await ThanksPage({ searchParams: Promise.resolve(params) }));
}

// ── S2-T-THANKS-01: Danish heading ───────────────────────────────────────

describe("S2-T-THANKS-01: /order/thanks — heading 'Tak for din bestilling'", () => {
  it("renders the heading visible in main", async () => {
    await renderThanks();
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 }))
      .toHaveTextContent("Tak for din bestilling");
  });
});

// ── S2-T-THANKS-02: A2-1 reservation sentence (nothing is charged at Checkout) ─

describe("S2-T-THANKS-02: /order/thanks — A2-1 reservation sentence, not 'Betalingen er gennemført.'", () => {
  it("shows 'Beløbet reserveres ved bestillingen og trækkes først, når varen sendes.'", async () => {
    await renderThanks();
    const text = screen.getByRole("main").textContent ?? "";
    expect(text).toContain("Beløbet reserveres ved bestillingen og trækkes først, når varen sendes.");
    // A1: the payment is only authorized at Checkout, so the page never says it is completed.
    expect(text).not.toContain("Betalingen er gennemført");
  });
});

// ── S2-T-THANKS-03: ordrebekræftelse and dispatch notice ─────────────────

describe("S2-T-THANKS-03: /order/thanks — ordrebekræftelse notice and 3 hverdage", () => {
  it("shows 'Vi sender en ordrebekræftelse til din e-mail'", async () => {
    await renderThanks();
    expect(screen.getByRole("main").textContent).toContain(
      "Vi sender en ordrebekræftelse til din e-mail",
    );
  });

  it("shows dispatch notice '3 hverdage'", async () => {
    await renderThanks();
    expect(screen.getByRole("main").textContent).toContain("3 hverdage");
  });
});

// ── S2-T-THANKS-04: link back home ────────────────────────────────────────

describe("S2-T-THANKS-04: /order/thanks — link back to home page", () => {
  it("contains a link pointing to '/'", async () => {
    await renderThanks();
    const homeLinks = within(screen.getByRole("main"))
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/");
    expect(homeLinks.length).toBeGreaterThanOrEqual(1);
  });
});

// ── S2-T-THANKS-05: lang=en ───────────────────────────────────────────────

describe("S2-T-THANKS-05: /order/thanks?lang=en — English copy and the /en home link, Danish absent", () => {
  it("renders the English heading, the three English sentences and 'Go to the front page' → /en", async () => {
    await renderThanks({ lang: "en" });
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1 })).toHaveTextContent("Thank you for your order");
    for (const sentence of [
      "The amount is reserved when you order and charged only when the goods are sent.",
      "We will send an order confirmation to your email. It is also your invoice and shows the order number, the delivery address and your right of withdrawal.",
      "The goods are dispatched within 3 working days. You will receive an email when they have been sent.",
    ]) {
      expect(main.textContent).toContain(sentence);
    }
    expect(within(main).getByRole("link", { name: "Go to the front page" })).toHaveAttribute("href", "/en");
    expect(main.textContent).not.toContain("Tak for din bestilling");
    expect(main.textContent).not.toContain("Beløbet reserveres");
  });
});
