// @vitest-environment jsdom
/**
 * Unit tests: src/components/site/ItemOfferBlock.tsx + BuyButton.tsx
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-CHK-1..3 (web layer - offer block on item page)
 *
 * Test IDs: S2-T-IOB-01..11
 *
 * Copy pinned from s2-item-buy.html mock (no em-dash):
 *   full price line DA: "249,95 kr. inkl. moms og levering i Danmark"
 *   full price line EN: "249.95 kr. incl. VAT and delivery in Denmark"
 *   facts (DA):   "Sendes kun i Danmark" | "Sendes inden for 3 hverdage"
 *                 | "14 dages fortrydelsesret" | "Returfragt betales af kunden"
 *   termsLink DA: "Handelsbetingelser" → /terms
 *   termsLink EN: → /en/terms
 *   form:         method=post  action=/api/checkout/item
 *   BuyButton DA: "Køb"
 *   BuyButton pending DA (U+2026): "Sender dig til betaling \u2026"
 *
 * Pending state: BuyButton intercepts the native form's submit event and
 * enters a React-state pending state (useFormStatus does NOT fire for
 * native URL form submissions). Tests: fireEvent.submit(form) triggers
 * the disabled state, a second submit is cancelled (fireEvent returns
 * false), and a back/forward-cache restore (pageshow, persisted) resets it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/components/site/SiteFooter", () => ({ default: () => <footer /> }));
// Keep the real exports: the /terms link's getPathname (next-intl createNavigation) reads them at import.
vi.mock("next/navigation", async (importOriginal) => ({
  // Exception: vi.mock factory is hoisted; must dynamically import the original here.
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ push: vi.fn() }),
}));

import ItemOfferBlock, { type ItemOfferBlockProps } from "@/components/site/ItemOfferBlock";
import BuyButton from "@/components/site/BuyButton";

afterEach(cleanup);

const DA_OFFER: ItemOfferBlockProps["offer"] = {
  itemId: "00000000-0000-0000-0000-000000000001",
  priceOre: 24995,
};

const EN_OFFER: ItemOfferBlockProps["offer"] = { ...DA_OFFER };

function renderOfferBlock(offer = DA_OFFER, locale: "da" | "en" = "da") {
  return render(<ItemOfferBlock offer={offer} locale={locale} />);
}

// ── S2-T-IOB-01: price shown as full "249,95 kr." ────────────────────────

describe("S2-T-IOB-01: ItemOfferBlock — full price string from offer.priceOre via formatKroner", () => {
  it("renders '249,95 kr.' for priceOre=24995 (DA — Danish decimal comma)", () => {
    const { container } = renderOfferBlock();
    // 24995 øre = 249,95 kr. — the kr. suffix is part of the price template.
    expect(container.textContent).toContain("249,95 kr.");
  });

  it("renders '249.95 kr.' for priceOre=24995 (EN — English decimal point)", () => {
    const { container } = renderOfferBlock(EN_OFFER, "en");
    expect(container.textContent).toContain("249.95 kr.");
  });
});

// ── S2-T-IOB-02: price note ───────────────────────────────────────────────

describe("S2-T-IOB-02: ItemOfferBlock — 'inkl. moms og levering i Danmark'", () => {
  it("shows exact price note 'inkl. moms og levering i Danmark' (DA)", () => {
    const { container } = renderOfferBlock();
    expect(container.textContent).toContain("inkl. moms og levering i Danmark");
  });

  it("shows EN price note 'incl. VAT and delivery in Denmark' (EN)", () => {
    const { container } = renderOfferBlock(EN_OFFER, "en");
    expect(container.textContent).toContain("incl. VAT and delivery in Denmark");
  });
});

// ── S2-T-IOB-03: 4 facts pinned from mock ────────────────────────────────

describe("S2-T-IOB-03: ItemOfferBlock — exact 4 facts from GOODS_TEXTS.itemPage.facts", () => {
  it("shows 'Sendes kun i Danmark' (shipsDkOnly)", () => {
    const { container } = renderOfferBlock();
    expect(container.textContent).toContain("Sendes kun i Danmark");
  });

  it("shows 'Sendes inden for 3 hverdage' (dispatch, per S2-LEGAL-5)", () => {
    const { container } = renderOfferBlock();
    expect(container.textContent).toContain("Sendes inden for 3 hverdage");
  });

  it("shows '14 dages fortrydelsesret' (withdrawal)", () => {
    const { container } = renderOfferBlock();
    expect(container.textContent).toContain("14 dages fortrydelsesret");
  });

  it("shows 'Returfragt betales af kunden' (returnShipping, per S2-LEGAL-6)", () => {
    const { container } = renderOfferBlock();
    expect(container.textContent).toContain("Returfragt betales af kunden");
  });
});

// ── S2-T-IOB-04: Handelsbetingelser link to /terms (DA) ──────────────────

describe("S2-T-IOB-04: ItemOfferBlock — Handelsbetingelser link to /terms (DA)", () => {
  it("contains a link labelled 'Handelsbetingelser' pointing to /terms", () => {
    const { container } = renderOfferBlock();
    const link = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Handelsbetingelser",
    );
    expect(link).toBeTruthy();
    expect(link!.getAttribute("href")).toBe("/terms");
  });
});

// ── S2-T-IOB-05: Terms link to /en/terms (EN) ────────────────────────────

describe("S2-T-IOB-05: ItemOfferBlock — terms link to /en/terms (EN)", () => {
  it("contains a terms link pointing to /en/terms for locale=en", () => {
    const { container } = renderOfferBlock(EN_OFFER, "en");
    const link = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/en/terms",
    );
    expect(link).toBeTruthy();
  });
});

// ── S2-T-IOB-06: native form method=post action=/api/checkout/item ────────

describe("S2-T-IOB-06: ItemOfferBlock — native form method=post action=/api/checkout/item", () => {
  it("renders a form with method=post and action=/api/checkout/item", () => {
    const { container } = renderOfferBlock();
    const form = container.querySelector("form");
    expect(form).toBeTruthy();
    expect(form!.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form!.getAttribute("action")).toBe("/api/checkout/item");
  });
});

// ── S2-T-IOB-07: hidden input item_id ────────────────────────────────────

describe("S2-T-IOB-07: ItemOfferBlock — hidden item_id = offer.itemId", () => {
  it("form has hidden input[name='item_id'] with the offer's itemId value", () => {
    const { container } = renderOfferBlock();
    const form = container.querySelector("form");
    const input = form?.querySelector("input[name='item_id']") as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.type).toBe("hidden");
    expect(input!.value).toBe(DA_OFFER.itemId);
  });
});

// ── S2-T-IOB-08: hidden input locale ─────────────────────────────────────

describe("S2-T-IOB-08: ItemOfferBlock — hidden locale = current locale", () => {
  it("form has hidden input[name='locale'] = 'da'", () => {
    const { container } = renderOfferBlock(DA_OFFER, "da");
    const input = container.querySelector("input[name='locale']") as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.type).toBe("hidden");
    expect(input!.value).toBe("da");
  });

  it("form has hidden input[name='locale'] = 'en' for EN locale", () => {
    const { container } = renderOfferBlock(EN_OFFER, "en");
    const input = container.querySelector("input[name='locale']") as HTMLInputElement | null;
    expect(input!.value).toBe("en");
  });
});

// ── S2-T-IOB-09: BuyButton — initial label 'Køb' ─────────────────────────
// BuyButton takes its labels as props (resolved from Catalog.offer on the server, like
// ItemGallery's): a client island resolving them from `locale` would bundle both message
// files into the static item page. The labels are therefore asserted through ItemOfferBlock.

describe("S2-T-IOB-09: BuyButton — initial label 'Køb' (DA)", () => {
  it("BuyButton renders submit button with text 'Køb'", () => {
    const { container } = renderOfferBlock(DA_OFFER, "da");
    const btn = container.querySelector("button[type='submit']");
    expect(btn?.textContent?.trim()).toBe("Køb");
    expect(btn).not.toBeDisabled();
  });

  it("BuyButton renders submit button with text 'Buy' (EN)", () => {
    const { container } = renderOfferBlock(EN_OFFER, "en");
    const btn = container.querySelector("button[type='submit']");
    expect(btn?.textContent?.trim()).toBe("Buy");
  });

  it("BuyButton outside a form is an enabled submit button showing its label", () => {
    render(<BuyButton label="Køb" pendingLabel={"Sender dig til betaling \u2026"} />);
    const btn = document.body.querySelector("button[type='submit']");
    expect(btn?.textContent?.trim()).toBe("Køb");
    expect(btn).not.toBeDisabled();
  });
});

// ── S2-T-IOB-10: BuyButton pending via native form submit ────────────────

describe("S2-T-IOB-10: BuyButton — disabled with 'Sender dig til betaling \u2026' after native form submit", () => {
  it("submit event disables the button and shows the pending label (U+2026 ellipsis)", () => {
    // The offer form is a native method=post form; useFormStatus does NOT fire for
    // native URL submissions. BuyButton must intercept the form's submit event via
    // its own onSubmit handler / React state to enter pending mode.
    const { container } = renderOfferBlock(DA_OFFER, "da");
    const form = container.querySelector("form") as HTMLFormElement;
    const btn = container.querySelector("button[type='submit']") as HTMLButtonElement;

    // Before submit: enabled + "Køb"
    expect(btn).not.toBeDisabled();
    expect(btn.textContent?.trim()).toBe("Køb");

    // Submit the native form
    act(() => { fireEvent.submit(form); });

    // After submit: disabled + pending label (U+2026 = …)
    expect(btn).toBeDisabled();
    expect(btn.textContent?.trim()).toBe("Sender dig til betaling \u2026");
  });

  it("cancels every further submit: the first submit goes through, the second is prevented", () => {
    const { container } = renderOfferBlock(DA_OFFER, "da");
    const form = container.querySelector("form") as HTMLFormElement;
    const btn = container.querySelector("button[type='submit']") as HTMLButtonElement;

    // fireEvent returns false when a listener called preventDefault (the native POST would not happen).
    let first = false;
    act(() => { first = fireEvent.submit(form); });
    expect(first).toBe(true);
    expect(btn).toBeDisabled();

    let second = true;
    act(() => { second = fireEvent.submit(form); });
    expect(second).toBe(false);
    expect(btn).toBeDisabled();
    expect(btn.textContent?.trim()).toBe("Sender dig til betaling \u2026");
  });

  it("a page restored from the back/forward cache (pageshow, persisted) has the 'Køb' button ready again", () => {
    const { container } = renderOfferBlock(DA_OFFER, "da");
    const form = container.querySelector("form") as HTMLFormElement;
    const btn = container.querySelector("button[type='submit']") as HTMLButtonElement;

    act(() => { fireEvent.submit(form); });
    // A normal page load's pageshow (not from the cache) changes nothing.
    act(() => { fireEvent(window, new PageTransitionEvent("pageshow", { persisted: false })); });
    expect(btn).toBeDisabled();

    act(() => { fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true })); });
    expect(btn).not.toBeDisabled();
    expect(btn.textContent?.trim()).toBe("Køb");

    // Ready again means a new submit goes through once more.
    let again = false;
    act(() => { again = fireEvent.submit(form); });
    expect(again).toBe(true);
  });
});

// ── S2-T-IOB-11: ItemOfferBlock renders inside the full item context ──────

describe("S2-T-IOB-11: ItemOfferBlock — renders without errors with minimal offer props", () => {
  it("renders a complete offer block for a models3d item", () => {
    const { container } = renderOfferBlock(DA_OFFER, "da");
    // Form, button, price, facts all present
    expect(container.querySelector("form")).toBeTruthy();
    expect(container.querySelector("button[type='submit']")).toBeTruthy();
    expect(container.textContent).toContain("249,95 kr.");
    expect(container.textContent).toContain("inkl. moms og levering i Danmark");
    // No em-dash (U+2014) in any copy (per S2-LEGAL-3)
    expect(container.textContent).not.toContain("\u2014");
  });
});
