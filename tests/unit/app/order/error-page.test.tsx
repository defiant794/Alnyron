// @vitest-environment jsdom
/**
 * Unit tests: src/app/order/error/page.tsx
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-CHK-11 (web layer - error page shown after failed checkout)
 *
 * Test IDs: S2-T-ERROR-01..08
 *
 * Copy pinned from s2-order-pages.html mock (no em-dash):
 *   DA heading:         "Betalingen kunne ikke startes"
 *   DA generic body:    "Der skete en fejl, og du er ikke blevet opkrævet."
 *   DA busy:            "Der er for mange forsøg lige nu. Vent et øjeblik, og prøv igen."
 *   DA not_purchasable: "Varen kan ikke købes lige nu."
 *   DA unavailable:     generic body (same as unknown — reason key whitelisted but no special copy)
 *   EN heading:         "Payment could not be started"
 *   EN generic body:    "An error occurred, and you have not been charged."
 *   EN home link:       href="/en"
 *   DA home link:       href="/"
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
  usePathname: () => "/order/error",
}));

import ErrorPage from "@/app/order/error/page";

afterEach(cleanup);

async function renderError(params: Record<string, string> = {}) {
  render(await ErrorPage({ searchParams: Promise.resolve(params) }));
}

// ── S2-T-ERROR-01: main heading (DA) ──────────────────────────────────────

describe("S2-T-ERROR-01: /order/error — DA heading 'Betalingen kunne ikke startes'", () => {
  it("renders the DA error heading in main", async () => {
    await renderError();
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 }))
      .toHaveTextContent("Betalingen kunne ikke startes");
  });
});

// ── S2-T-ERROR-02: generic body (DA, no reason) ───────────────────────────

describe("S2-T-ERROR-02: /order/error (no reason) — generic body shown", () => {
  it("shows 'Der skete en fejl, og du er ikke blevet opkrævet.'", async () => {
    await renderError();
    expect(screen.getByRole("main").textContent).toContain(
      "Der skete en fejl, og du er ikke blevet opkrævet.",
    );
  });
});

// ── S2-T-ERROR-03: reason=busy ────────────────────────────────────────────

// Copy from contract §3 (contract wins over mock per §0):
//   busy: "for mange forsøg, prøv igen om lidt"
//   Full sentence may be e.g. "Der er for mange forsøg, prøv igen om lidt."
describe("S2-T-ERROR-03: /order/error?reason=busy — busy copy shown, others absent", () => {
  it("contains contract §3 fragment 'for mange forsøg, prøv igen om lidt'", async () => {
    await renderError({ reason: "busy" });
    expect(screen.getByRole("main").textContent).toContain(
      "for mange forsøg, prøv igen om lidt",
    );
  });

  it("does not show not_purchasable copy for reason=busy", async () => {
    await renderError({ reason: "busy" });
    expect(screen.getByRole("main").textContent).not.toContain("Varen kan ikke købes lige nu.");
  });
});

// ── S2-T-ERROR-04: reason=not_purchasable ────────────────────────────────

describe("S2-T-ERROR-04: /order/error?reason=not_purchasable — item copy shown, others absent", () => {
  it("shows 'Varen kan ikke købes lige nu.'", async () => {
    await renderError({ reason: "not_purchasable" });
    expect(screen.getByRole("main").textContent).toContain("Varen kan ikke købes lige nu.");
  });

  it("does not show busy copy for reason=not_purchasable", async () => {
    await renderError({ reason: "not_purchasable" });
    expect(screen.getByRole("main").textContent).not.toContain("for mange forsøg");
  });
});

// ── S2-T-ERROR-05: reason=unavailable → generic, neither busy nor not_purchasable ──

describe("S2-T-ERROR-05: /order/error?reason=unavailable — generic copy, specific reasons absent", () => {
  it("shows generic body 'Der skete en fejl, og du er ikke blevet opkrævet.'", async () => {
    await renderError({ reason: "unavailable" });
    expect(screen.getByRole("main").textContent).toContain(
      "Der skete en fejl, og du er ikke blevet opkrævet.",
    );
  });

  it("does not show busy copy for reason=unavailable", async () => {
    await renderError({ reason: "unavailable" });
    expect(screen.getByRole("main").textContent).not.toContain("for mange forsøg");
  });

  it("does not show not_purchasable copy for reason=unavailable", async () => {
    await renderError({ reason: "unavailable" });
    expect(screen.getByRole("main").textContent).not.toContain("Varen kan ikke købes lige nu.");
  });
});

// ── S2-T-ERROR-06: unknown reason → generic, no reflected input ──────────

describe("S2-T-ERROR-06: /order/error — unknown reason → generic, no reflected input", () => {
  it("shows generic copy and does not reflect the unknown reason string", async () => {
    await renderError({ reason: "xss-payload-<script>alert(1)</script>" });
    const main = screen.getByRole("main");
    expect(main.innerHTML).not.toContain("<script>");
    expect(main.innerHTML).not.toContain("xss-payload");
    expect(main.textContent).toContain("Der skete en fejl");
  });
});

// ── S2-T-ERROR-07: lang=en — English heading, body, no Danish heading ─────

describe("S2-T-ERROR-07: /order/error?lang=en — English heading and body, Danish heading absent", () => {
  it("renders EN heading 'Payment could not be started'", async () => {
    await renderError({ lang: "en" });
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 }))
      .toHaveTextContent("Payment could not be started");
  });

  it("does not show Danish heading 'Betalingen kunne ikke startes' when lang=en", async () => {
    await renderError({ lang: "en" });
    expect(screen.getByRole("main").textContent).not.toContain("Betalingen kunne ikke startes");
  });

  it("shows EN generic body 'An error occurred, and you have not been charged.'", async () => {
    await renderError({ lang: "en" });
    expect(screen.getByRole("main").textContent).toContain(
      "An error occurred, and you have not been charged.",
    );
  });

  it("lang=en, reason=busy shows the EN busy copy, not Danish", async () => {
    await renderError({ lang: "en", reason: "busy" });
    const text = screen.getByRole("main").textContent ?? "";
    expect(text).toContain("There have been too many attempts, please try again shortly. You have not been charged.");
    expect(text).not.toContain("forsøg");
  });
});

// ── S2-T-ERROR-08: home link hrefs ───────────────────────────────────────

describe("S2-T-ERROR-08: /order/error — home link href", () => {
  it("DA page home link points to '/'", async () => {
    await renderError({ lang: "da" });
    const links = within(screen.getByRole("main"))
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/");
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it("EN page home link points to '/en'", async () => {
    await renderError({ lang: "en" });
    const links = within(screen.getByRole("main"))
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/en");
    expect(links.length).toBeGreaterThanOrEqual(1);
  });
});
