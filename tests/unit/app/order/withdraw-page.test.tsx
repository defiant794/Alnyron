// @vitest-environment jsdom
/**
 * Unit tests: src/app/order/withdraw/page.tsx — /order/withdraw two-step form
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-WD-3..9 (web layer)
 *
 * Test IDs: S2-T-WPAG-01..14
 *
 * Copy pinned from s2-order-withdraw.html mock (no em-dash):
 *   step-1 button:        "Fortryd aftale her"
 *   heading:              "Fortryd aftale"
 *   step-2 button:        "Bekræft fortrydelse"
 *   step-2 back:          "Tilbage"
 *   step-2 pending label: "Sender ..."
 *   statement prefix:     "Jeg meddeler hermed, at jeg fortryder min aftale om køb af varen"
 *   state=received:       "Vi har modtaget din fortrydelse"
 *                         "Du får en kvittering på ordrens e-mail."
 *   state=refused:        "Vi kunne ikke finde en ordre med de oplysninger."
 *   DA metadata title:    "Fortryd aftale"
 *   robots:               "noindex, nofollow"
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";

// vi.mock factories hoisted above static imports; next-intl-server helper
// must be loaded dynamically inside the factory (static import would not
// exist at hoist time — standard test infrastructure exception).
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
  usePathname: () => "/order/withdraw",
}));
vi.mock("@/app/order/withdraw/actions", () => ({
  withdrawOrder: vi.fn(() => new Promise(() => { /* never resolves — stays pending for S2-T-WPAG-11 */ })),
}));

import WithdrawPage, { generateMetadata } from "@/app/order/withdraw/page";
import { GOODS_TEXT_VERSION } from "@/config/legal/goods-texts";

afterEach(cleanup);

type WithdrawParams = Record<string, string>;

async function renderWithdraw(params: WithdrawParams = {}) {
  render(await WithdrawPage({ searchParams: Promise.resolve(params) }));
}

const VALID_UUID = "00000000-0000-0000-0000-000000000001";
const VALID_TOKEN = "valid-token-abc123";

// ── S2-T-WPAG-01: noindex metadata ───────────────────────────────────────

describe("S2-T-WPAG-01: /order/withdraw — generateMetadata sets title + robots noindex", () => {
  it("generateMetadata returns title 'Fortryd aftale' and robots 'noindex, nofollow' for lang=da", async () => {
    const meta = await generateMetadata({ searchParams: Promise.resolve({ lang: "da" }) });
    expect(meta).toEqual({ title: "Fortryd aftale", robots: "noindex, nofollow" });
  });
});

// ── S2-T-WPAG-02: step 1 — with link (o+t): only consumer_name field ─────

describe("S2-T-WPAG-02: /order/withdraw — with o+t: only consumer_name shown (link channel)", () => {
  it("shows consumer_name field, not order_number or email field", async () => {
    await renderWithdraw({ o: VALID_UUID, t: VALID_TOKEN });
    const main = screen.getByRole("main");
    expect(main.querySelectorAll("input[name='consumer_name']").length).toBeGreaterThanOrEqual(1);
    expect(main.querySelectorAll("input[name='order_number']").length).toBe(0);
    expect(main.querySelectorAll("input[name='email']").length).toBe(0);
  });
});

// ── S2-T-WPAG-03: step 1 — without link: order_number+email+consumer_name ─

describe("S2-T-WPAG-03: /order/withdraw — without o+t: order_number+email+consumer_name shown", () => {
  it("shows order_number, email, and consumer_name fields when no link params", async () => {
    await renderWithdraw({});
    const main = screen.getByRole("main");
    expect(main.querySelectorAll("input[name='order_number']").length).toBeGreaterThanOrEqual(1);
    expect(main.querySelectorAll("input[name='email']").length).toBeGreaterThanOrEqual(1);
    expect(main.querySelectorAll("input[name='consumer_name']").length).toBeGreaterThanOrEqual(1);
  });
});

// ── S2-T-WPAG-04: step 1 heading ─────────────────────────────────────────

describe("S2-T-WPAG-04: /order/withdraw — step 1 heading 'Fortryd aftale'", () => {
  it("renders heading 'Fortryd aftale' in main", async () => {
    await renderWithdraw({});
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1 })).toHaveTextContent("Fortryd aftale");
  });
});

// ── S2-T-WPAG-05: step 2 — click step-1 button, assert full step-2 UI ────

describe("S2-T-WPAG-05: /order/withdraw — click 'Fortryd aftale her' advances to step 2", () => {
  it("step 2 shows statement prefix, 'Bekræft fortrydelse', 'Tilbage'; Tilbage returns to step-1 fields", async () => {
    const user = userEvent.setup();
    await renderWithdraw({ o: VALID_UUID, t: VALID_TOKEN, lang: "da" });
    const main = screen.getByRole("main");

    // Fill consumer_name and click the step-1 submit button (exact label)
    await user.type(within(main).getByRole("textbox", { name: /navn/i }), "Mette Hansen");
    await user.click(within(main).getByRole("button", { name: "Fortryd aftale her" }));

    // Step 2: pinned buttons by exact name
    expect(within(main).getByRole("button", { name: "Bekræft fortrydelse" })).toBeInTheDocument();
    expect(within(main).getByRole("button", { name: "Tilbage" })).toBeInTheDocument();

    // Step 2: statement prefix shown (from GOODS_TEXTS withdrawal statement)
    expect(main.textContent).toContain(
      "Jeg meddeler hermed, at jeg fortryder min aftale om køb af varen",
    );

    // Clicking Tilbage returns to step-1 fields
    await user.click(within(main).getByRole("button", { name: "Tilbage" }));
    expect(main.querySelector("input[name='consumer_name']")).toBeInTheDocument();
    expect(within(main).queryByRole("button", { name: "Bekræft fortrydelse" })).toBeNull();
  });
});

// ── S2-T-WPAG-06: step 2 — hidden inputs carry o, t, statement_version, locale

describe("S2-T-WPAG-06: /order/withdraw — step 2 form has all required hidden inputs", () => {
  it("step 2 form has hidden o, t, statement_version, locale inputs with correct values", async () => {
    const user = userEvent.setup();
    await renderWithdraw({ o: VALID_UUID, t: VALID_TOKEN, lang: "da" });
    const main = screen.getByRole("main");

    await user.type(within(main).getByRole("textbox", { name: /navn/i }), "Mette Hansen");
    await user.click(within(main).getByRole("button", { name: "Fortryd aftale her" }));

    // Required hidden inputs for the Server Action: the names withdrawOrder reads
    // (withdraw-actions.test.ts: order_id, token, channel), carrying the link's o and t.
    const oInput = main.querySelector("input[name='order_id']") as HTMLInputElement | null;
    expect(oInput?.value).toBe(VALID_UUID);

    const tInput = main.querySelector("input[name='token']") as HTMLInputElement | null;
    expect(tInput?.value).toBe(VALID_TOKEN);

    const channelInput = main.querySelector("input[name='channel']") as HTMLInputElement | null;
    expect(channelInput?.value).toBe("link");

    const svInput = main.querySelector("input[name='statement_version']") as HTMLInputElement | null;
    expect(svInput?.value).toBe(GOODS_TEXT_VERSION);

    const localeInput = main.querySelector("input[name='locale']") as HTMLInputElement | null;
    expect(localeInput?.value).toBe("da");
  });

  it("step 2 form channel=form has hidden channel, order_number, email, consumer_name, statement_version, locale inputs", async () => {
    const user = userEvent.setup();
    await renderWithdraw({ lang: "da" }); // no o+t → form channel
    const main = screen.getByRole("main");

    const numberInput = main.querySelector("input[name='order_number']") as HTMLInputElement;
    const emailInput = main.querySelector("input[name='email']") as HTMLInputElement;
    const nameInput = main.querySelector("input[name='consumer_name']") as HTMLInputElement;

    await user.type(numberInput, "1001");
    await user.type(emailInput, "kunde@example.dk");
    await user.type(nameInput, "Mette Hansen");
    await user.click(within(main).getByRole("button", { name: "Fortryd aftale her" }));

    // Step 2 posts only hidden inputs: every field the Server Action reads.
    const hidden = Object.fromEntries(
      [...main.querySelectorAll<HTMLInputElement>("input[type='hidden']")].map((input) => [input.name, input.value]),
    );
    expect(hidden).toEqual({
      channel: "form",
      order_number: "1001",
      email: "kunde@example.dk",
      consumer_name: "Mette Hansen",
      statement_version: GOODS_TEXT_VERSION,
      locale: "da",
    });
    expect(main.querySelector("input[name='order_id']")).toBeNull();
    expect(main.querySelector("input[name='token']")).toBeNull();
  });

  it("a link whose o is not a uuid (or whose t is malformed) falls back to the form channel", async () => {
    await renderWithdraw({ o: "1001", t: VALID_TOKEN, lang: "da" });
    let main = screen.getByRole("main");
    expect(within(main).getByRole("textbox", { name: "Ordrenummer" })).toBeInTheDocument();
    expect(main.querySelector("input[name='email']")).toBeInTheDocument();
    cleanup();

    await renderWithdraw({ o: VALID_UUID, t: "not a token!", lang: "da" });
    main = screen.getByRole("main");
    expect(within(main).getByRole("textbox", { name: "Ordrenummer" })).toBeInTheDocument();
  });
});

// ── S2-T-WPAG-07: state=received — exact copy, other states absent ────────

describe("S2-T-WPAG-07: /order/withdraw?state=received — exact success copy", () => {
  it("shows 'Vi har modtaget din fortrydelse'", async () => {
    await renderWithdraw({ state: "received" });
    expect(screen.getByRole("main").textContent).toContain("Vi har modtaget din fortrydelse");
  });

  it("shows 'Du får en kvittering på ordrens e-mail.'", async () => {
    await renderWithdraw({ state: "received" });
    expect(screen.getByRole("main").textContent).toContain(
      "Du får en kvittering på ordrens e-mail.",
    );
  });

  it("does not show refused, busy, or unavailable copy", async () => {
    await renderWithdraw({ state: "received" });
    const text = screen.getByRole("main").textContent ?? "";
    expect(text).not.toContain("Vi kunne ikke finde");
    expect(text).not.toContain("For mange forsøg");
    expect(text).not.toContain("ikke tilgængelig");
  });
});

// ── S2-T-WPAG-08: state=refused — exact generic copy, no other states ────

describe("S2-T-WPAG-08: /order/withdraw?state=refused — exact generic refused copy", () => {
  it("shows 'Vi kunne ikke finde en ordre med de oplysninger.'", async () => {
    await renderWithdraw({ state: "refused" });
    expect(screen.getByRole("main").textContent).toContain(
      "Vi kunne ikke finde en ordre med de oplysninger.",
    );
  });

  it("does not reveal token-invalid or wrong-email detail", async () => {
    await renderWithdraw({ state: "refused" });
    const text = screen.getByRole("main").textContent ?? "";
    // Generic: same message for all identification failures
    expect(text).not.toContain("token");
    expect(text).not.toContain("udløbet");
  });

  it("does not show received, busy, or unavailable copy", async () => {
    await renderWithdraw({ state: "refused" });
    const text = screen.getByRole("main").textContent ?? "";
    expect(text).not.toContain("Vi har modtaget din fortrydelse");
    expect(text).not.toContain("For mange forsøg");
    expect(text).not.toContain("ikke tilgængelig");
  });
});

// ── S2-T-WPAG-09: state=busy — exact busy copy, no other states ──────────

describe("S2-T-WPAG-09: /order/withdraw?state=busy — busy copy shown, others absent", () => {
  it("shows rate-limit busy message", async () => {
    await renderWithdraw({ state: "busy" });
    const text = screen.getByRole("main").textContent ?? "";
    // Pinned from GOODS_TEXTS — the page must contain this exact phrase
    expect(text).toContain("For mange forsøg");
  });

  it("does not show received, refused, or unavailable copy", async () => {
    await renderWithdraw({ state: "busy" });
    const text = screen.getByRole("main").textContent ?? "";
    expect(text).not.toContain("Vi har modtaget din fortrydelse");
    expect(text).not.toContain("Vi kunne ikke finde");
    expect(text).not.toContain("ikke tilgængelig");
  });
});

// ── S2-T-WPAG-10: state=unavailable — exact unavailable copy, no others ──

describe("S2-T-WPAG-10: /order/withdraw?state=unavailable — unavailable copy shown", () => {
  it("shows unavailable service message", async () => {
    await renderWithdraw({ state: "unavailable" });
    const text = screen.getByRole("main").textContent ?? "";
    // Pinned from GOODS_TEXTS
    expect(text).toContain("ikke tilgængelig");
  });

  it("does not show received, refused, or busy copy", async () => {
    await renderWithdraw({ state: "unavailable" });
    const text = screen.getByRole("main").textContent ?? "";
    expect(text).not.toContain("Vi har modtaget din fortrydelse");
    expect(text).not.toContain("Vi kunne ikke finde");
    expect(text).not.toContain("For mange forsøg");
  });
});

// ── S2-T-WPAG-11: Bekræft fortrydelse button disabled while pending ───────

describe("S2-T-WPAG-11: /order/withdraw — 'Bekræft fortrydelse' disabled + 'Sender ...' while pending", () => {
  it("confirm button is disabled with pending label during form submission", async () => {
    const user = userEvent.setup();
    await renderWithdraw({ o: VALID_UUID, t: VALID_TOKEN, lang: "da" });
    const main = screen.getByRole("main");

    await user.type(within(main).getByRole("textbox", { name: /navn/i }), "Mette Hansen");
    await user.click(within(main).getByRole("button", { name: "Fortryd aftale her" }));

    const confirmBtn = within(main).getByRole("button", { name: "Bekræft fortrydelse" });

    // Click submit — the mocked withdrawOrder never resolves, so the button
    // must become disabled (via useFormStatus pending=true).
    await user.click(confirmBtn);
    expect(confirmBtn).toBeDisabled();
    // Pending label "Sender ..." (from GOODS_TEXTS) shown instead of or alongside button text
    expect(main.textContent).toContain("Sender");
  });
});

// ── S2-T-WPAG-12: goods notice / return instructions in step 1 ───────────

describe("S2-T-WPAG-12: /order/withdraw — return address and instructions in step 1", () => {
  it("shows return address Nyvej 4, 7860 Spøttrup", async () => {
    await renderWithdraw({});
    expect(screen.getByRole("main").textContent).toContain("Nyvej 4, 7860 Spøttrup");
  });

  it("shows buyer pays return shipping", async () => {
    await renderWithdraw({});
    expect(screen.getByRole("main").textContent).toContain("returfragten");
  });
});

// ── S2-T-WPAG-13: lang=en — English heading, not Danish ──────────────────

describe("S2-T-WPAG-13: /order/withdraw?lang=en — English heading, Danish absent", () => {
  it("renders English heading 'Withdraw purchase' and not Danish 'Fortryd aftale'", async () => {
    await renderWithdraw({ lang: "en" });
    const main = screen.getByRole("main");
    const h1 = within(main).getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Withdraw purchase");
    expect(within(main).getByRole("button", { name: "Withdraw from the contract here" })).toBeInTheDocument();
    expect(main.textContent).not.toContain("Fortryd aftale");
    expect(main.textContent).not.toContain("Ordrenummer");
  });
});

// ── S2-T-WPAG-14: step-1 button label ─────────────────────────────────────

describe("S2-T-WPAG-14: /order/withdraw — step-1 submit button is 'Fortryd aftale her'", () => {
  it("step-1 submit button text is exactly 'Fortryd aftale her'", async () => {
    await renderWithdraw({ o: VALID_UUID, t: VALID_TOKEN });
    const main = screen.getByRole("main");
    expect(within(main).getByRole("button", { name: "Fortryd aftale her" })).toBeInTheDocument();
  });
});
