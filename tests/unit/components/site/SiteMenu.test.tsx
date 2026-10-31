// @vitest-environment jsdom
// Tests for the small-screen header menu (DESIGN.md Nav: below 768px the nav
// and language switcher collapse behind a "Menu" disclosure button).
// tests/e2e/home-page.spec.ts drives it at 375px in a real browser; these pin
// the disclosure contract:
// - the toggle is a named button with aria-expanded + aria-controls pointing
//   at the panel that holds the header contents;
// - Escape closes the open panel and returns focus to the toggle;
// - a link click inside the panel closes it (also a link to the page shown);
// - navigating to another page closes it.
// jsdom loads no CSS, so "open" is asserted through aria-expanded and the
// `hidden` class that hides the panel below md.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { NextIntlClientProvider } from "next-intl";

// ── Mock the Next router hooks ───────────────────────────────────────────────
// As in LanguageSwitcher.test.tsx: `useSelectedLayoutSegments` returns the
// internal segments below the `[locale]` layout and `useParams` the route
// params; everything above them is real.
const route = vi.hoisted(() => ({
  segments: [] as string[],
  params: { locale: "da" } as Record<string, string>,
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSelectedLayoutSegments: () => route.segments,
  useParams: () => route.params,
}));

import SiteMenu from "@/components/site/SiteMenu";

afterEach(cleanup);

/**
 * Renders the menu around header-like contents on the DA page with the
 * internal `segments` (`[]` is the home page). `navigate` re-renders on
 * another page, as a client-side navigation does (the header layout, and so
 * the menu state, survives it).
 */
function renderMenu(segments: string[] = []) {
  route.segments = segments;
  route.params = { locale: "da" };
  // A fresh element per render: React skips re-rendering an identical element.
  const ui = () => (
    <NextIntlClientProvider locale="da">
      <SiteMenu toggleLabel="Menu">
        <nav aria-label="Navigation">
          <a href="#kontakt">
            <span>Kontakt</span>
          </a>
        </nav>
        <p>Sprog</p>
      </SiteMenu>
    </NextIntlClientProvider>
  );
  const { rerender } = render(ui());
  const toggle = screen.getByRole("button", { name: "Menu" });
  const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  return {
    user: userEvent.setup(),
    toggle,
    panel,
    navigate(nextSegments: string[]) {
      route.segments = nextSegments;
      rerender(ui());
    },
  };
}

// ── Disclosure button ────────────────────────────────────────────────────────

describe("SiteMenu: disclosure button controls the header panel", () => {
  it("toggle is named by its label, starts collapsed and aria-controls the panel with the header contents", () => {
    const { toggle, panel } = renderMenu();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).not.toBeNull();
    expect(panel).toContainElement(screen.getByRole("navigation", { name: "Navigation" }));
    expect(panel).toHaveClass("hidden");
  });

  it("clicking the toggle opens the panel and clicking it again closes it", async () => {
    const { user, toggle, panel } = renderMenu();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel).not.toHaveClass("hidden");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveClass("hidden");
  });
});

// ── Escape ───────────────────────────────────────────────────────────────────

describe("SiteMenu: Escape closes the panel", () => {
  it("Escape inside the open panel closes it and returns focus to the toggle", async () => {
    const { user, toggle, panel } = renderMenu();
    await user.click(toggle);
    screen.getByRole("link", { name: "Kontakt" }).focus();

    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveClass("hidden");
    expect(toggle).toHaveFocus();
  });

  it("Escape while closed leaves focus where it is", async () => {
    const { user, toggle } = renderMenu();
    const link = screen.getByRole("link", { name: "Kontakt" });
    link.focus();

    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(link).toHaveFocus();
  });
});

// ── Link click and navigation ────────────────────────────────────────────────

describe("SiteMenu: closes on a link click and on navigation", () => {
  it("a click on a link in the panel closes it, also when it lands on an element inside the link", async () => {
    const { user, toggle, panel } = renderMenu();
    await user.click(toggle);

    await user.click(screen.getByText("Kontakt"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveClass("hidden");
  });

  it("a click on non-link content in the panel keeps it open", async () => {
    const { user, toggle } = renderMenu();
    await user.click(toggle);

    await user.click(screen.getByText("Sprog"));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("navigating to another page closes the open panel", async () => {
    const { user, toggle, panel, navigate } = renderMenu([]);
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    navigate(["contact"]);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveClass("hidden");
  });
});
