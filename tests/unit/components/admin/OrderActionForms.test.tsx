// @vitest-environment jsdom
/**
 * Unit tests: the order page's two action forms
 * (src/components/admin/OrderShipForm.tsx, OrderRefundForm.tsx).
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-ADM-* (web forms), contract §3 Admin actions + amendment A1 §UI, design finding D4
 *
 * Test IDs: S2-T-ORD-FRM-01..09, S2-T-ORD-FRM-D4
 *
 * - "Markér afsendt og træk betalingen": a confirmation step names the amount
 *   charged and the order (it cannot be undone); then the form's fields go to
 *   markShipped; pending spinner; the outcome (Danish, A1/A2 wording) is shown
 *   and focused, and stays after the refreshed page drops the form.
 * - Withdrawal approval: returned goods take a deduction in kroner + reason and
 *   show the refund it leaves; client checks before a confirmation step that
 *   names the amount and email; not shipped goods release the reservation
 *   ("Reservationen frigives (intet trækkes)", no deduction field), or refund
 *   in full what was captured at Checkout. Without a withdrawal (`offline`) the same
 *   approval is "Registrér fortrydelse": it records a notice that came by email or letter.
 * - D4: the server HTML hydrates unchanged for shipped/authorized orders with
 *   an offline notice or existing withdrawal, without hydration diagnostics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import da from "../../../../messages/da.json";

const { mockMarkShipped, mockApproveRefund } = vi.hoisted(() => ({
  mockMarkShipped: vi.fn(),
  mockApproveRefund: vi.fn(),
}));

vi.mock("@/app/admin/(panel)/orders/actions", () => ({
  markShipped: mockMarkShipped,
  approveRefund: mockApproveRefund,
}));

import OrderRefundForm, { type OrderRefundFormProps } from "@/components/admin/OrderRefundForm";
import OrderShipForm, { type OrderShipFormProps } from "@/components/admin/OrderShipForm";

const ORDER_ID = "00000000-0000-0000-0000-000000000001";
const { ship, refund, errors } = da.Admin.orders.detail;

/** The page's client provider: only the order actions' messages. */
function withMessages(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="da" timeZone="Europe/Copenhagen" messages={{ Admin: { orders: { detail: { ship, refund, errors } } } }}>
      {children}
    </NextIntlClientProvider>
  );
}

const SHIP_PROPS: OrderShipFormProps = {
  available: true,
  orderId: ORDER_ID,
  orderNumber: 1001,
  captured: false,
  amountOre: 17900,
};

/** "Markér afsendt og træk betalingen", then the confirmation's "Træk 179,00 kr.". */
async function shipAndConfirm(user: UserEvent): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Markér afsendt og træk betalingen" }));
  await user.click(screen.getByRole("button", { name: "Træk 179,00 kr." }));
}

const REFUND_PROPS: OrderRefundFormProps = {
  available: true,
  offline: false,
  orderId: ORDER_ID,
  orderNumber: 1001,
  email: "jens@example.dk",
  shipped: true,
  captured: true,
  availableOre: 17900,
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe("S2-T-ORD-FRM-01: OrderShipForm — sends the form to markShipped, pending, then the outcome", () => {
  it("submits orderId, orderNumber and the tracking reference; spinner while pending; success notice focused", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<unknown>();
    mockMarkShipped.mockReturnValue(pending.promise);
    render(withMessages(<OrderShipForm {...SHIP_PROPS} />));

    await user.type(screen.getByLabelText("Track & trace (valgfri)"), "00370712345678");
    await shipAndConfirm(user);

    const formData = mockMarkShipped.mock.calls[0]?.[0] as FormData;
    expect(Object.fromEntries(formData)).toEqual({
      orderId: ORDER_ID,
      orderNumber: "1001",
      trackingRef: "00370712345678",
    });
    expect(screen.getByRole("button", { name: "Træk 179,00 kr." })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Tilbage" })).toBeDisabled();

    pending.resolve({ ok: true, status: "shipped" });
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Ordren er markeret som afsendt, og betalingen er trukket. Køberen får en e-mail.");
    await waitFor(() => expect(notice).toHaveFocus());
  });

  it("keeps the outcome when the refreshed page no longer offers the form", async () => {
    const user = userEvent.setup();
    mockMarkShipped.mockResolvedValue({ ok: true, status: "shipped" });
    const { rerender } = render(withMessages(<OrderShipForm {...SHIP_PROPS} />));
    await shipAndConfirm(user);
    await screen.findByRole("status");

    rerender(withMessages(<OrderShipForm {...SHIP_PROPS} available={false} />));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Ordren er markeret som afsendt");
  });

  it("renders nothing when the order cannot be shipped and nothing was done", () => {
    const { container } = render(withMessages(<OrderShipForm {...SHIP_PROPS} available={false} />));
    expect(container).toBeEmptyDOMElement();
  });

  it("a payment captured at Checkout: 'Markér afsendt', confirmed without charging anything", async () => {
    const user = userEvent.setup();
    mockMarkShipped.mockResolvedValue({ ok: true, status: "shipped" });
    render(withMessages(<OrderShipForm {...SHIP_PROPS} captured />));
    expect(screen.getByText(ship.leadCaptured)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Markér afsendt" }));
    expect(screen.getByText("Markér ordre #1001 som afsendt? Køberen får en e-mail.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bekræft afsendelse" }));
    expect(mockMarkShipped).toHaveBeenCalledOnce();
  });
});

describe("S2-T-ORD-FRM-02: OrderShipForm — refusals in Danish (A1 / A2-3)", () => {
  it.each([
    ["authorization-expired", "Betalingen er udløbet. Send ikke varen; kontakt køberen."],
    ["capture-refused", "Betalingen kunne ikke trækkes. Varen er ikke markeret som afsendt."],
    ["withdrawal-pending", "Køberen har fortrudt købet. Send ikke varen."],
  ])("%s → alert '%s', focused", async (error, message) => {
    const user = userEvent.setup();
    mockMarkShipped.mockResolvedValue({ ok: false, error });
    render(withMessages(<OrderShipForm {...SHIP_PROPS} />));
    await shipAndConfirm(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("a request that got no answer is 'unavailable'", async () => {
    const user = userEvent.setup();
    mockMarkShipped.mockRejectedValue(new TypeError("Failed to fetch"));
    render(withMessages(<OrderShipForm {...SHIP_PROPS} />));
    await shipAndConfirm(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(errors.unavailable);
  });
});

describe("S2-T-ORD-FRM-08: OrderShipForm — confirmation before the payment is captured", () => {
  it("names amount and order, sends nothing until confirmed; 'Tilbage' returns focus to the first button", async () => {
    const user = userEvent.setup();
    render(withMessages(<OrderShipForm {...SHIP_PROPS} />));
    await user.type(screen.getByLabelText("Track & trace (valgfri)"), "0037");
    await user.click(screen.getByRole("button", { name: "Markér afsendt og træk betalingen" }));

    const question = screen.getByText("Træk 179,00 kr. og markér ordre #1001 som afsendt? Det kan ikke fortrydes.");
    await waitFor(() => expect(question).toHaveFocus());
    expect(screen.getByLabelText("Track & trace (valgfri)")).toHaveAttribute("readonly");
    expect(mockMarkShipped).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Tilbage" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Markér afsendt og træk betalingen" })).toHaveFocus(),
    );
    expect(screen.queryByText(/Det kan ikke fortrydes/)).toBeNull();
    expect(mockMarkShipped).not.toHaveBeenCalled();
  });
});

describe("S2-T-ORD-FRM-03: OrderRefundForm — returned goods: deduction, computed refund, client checks", () => {
  it("shows the refund the deduction leaves", async () => {
    const user = userEvent.setup();
    render(withMessages(<OrderRefundForm {...REFUND_PROPS} />));
    expect(screen.getByText("Refunderes: 179,00 kr.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Fradrag for værdiforringelse (kr., valgfri)"), "49,95");
    expect(screen.getByText("Refunderes: 129,05 kr. (179,00 kr. − 49,95 kr.)")).toBeInTheDocument();
  });

  it.each([
    ["abc", "Begrundelse", "Fradrag for værdiforringelse (kr., valgfri)", errors["deduction-format"]],
    ["179,00", "Begrundelse", "Fradrag for værdiforringelse (kr., valgfri)", errors["deduction-too-large"]],
    ["49,95", "", "Begrundelse (kræves ved fradrag)", errors["reason-required"]],
  ])("deduction '%s' with reason '%s' → error at '%s', focused, no action", async (deduction, reason, field, message) => {
    const user = userEvent.setup();
    render(withMessages(<OrderRefundForm {...REFUND_PROPS} />));
    await user.type(screen.getByLabelText("Fradrag for værdiforringelse (kr., valgfri)"), deduction);
    if (reason) await user.type(screen.getByLabelText("Begrundelse (kræves ved fradrag)"), reason);
    await user.click(screen.getByRole("button", { name: "Bekræft retur" }));

    const input = screen.getByLabelText(field);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(expect.stringContaining(message));
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.queryByRole("button", { name: /^Refundér/ })).toBeNull();
    expect(mockApproveRefund).not.toHaveBeenCalled();
  });
});

describe("S2-T-ORD-FRM-04: OrderRefundForm — confirmation step before the refund", () => {
  it("names amount and email, 'Tilbage' returns to the form, the second button sends the form", async () => {
    const user = userEvent.setup();
    mockApproveRefund.mockResolvedValue({ ok: true, status: "completed" });
    render(withMessages(<OrderRefundForm {...REFUND_PROPS} />));
    await user.type(screen.getByLabelText("Fradrag for værdiforringelse (kr., valgfri)"), "49,95");
    await user.type(screen.getByLabelText("Begrundelse (kræves ved fradrag)"), "Returfragt");
    await user.click(screen.getByRole("button", { name: "Bekræft retur" }));

    const question = screen.getByText("Refundér 129,05 kr. til jens@example.dk? Det kan ikke fortrydes.");
    await waitFor(() => expect(question).toHaveFocus());
    expect(mockApproveRefund).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Tilbage" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Bekræft retur" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Bekræft retur" }));
    await user.click(screen.getByRole("button", { name: "Refundér 129,05 kr." }));
    const formData = mockApproveRefund.mock.calls[0]?.[0] as FormData;
    expect(Object.fromEntries(formData)).toEqual({
      orderId: ORDER_ID,
      orderNumber: "1001",
      goodsState: "returned",
      deduction: "49,95",
      deductionReason: "Returfragt",
    });
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(refund.done.completed);
    await waitFor(() => expect(notice).toHaveFocus());
  });

  it("a refusal returns to the form with the Danish alert", async () => {
    const user = userEvent.setup();
    mockApproveRefund.mockResolvedValue({ ok: false, error: "order-refunded" });
    render(withMessages(<OrderRefundForm {...REFUND_PROPS} />));
    await user.click(screen.getByRole("button", { name: "Bekræft retur" }));
    await user.click(screen.getByRole("button", { name: "Refundér 179,00 kr." }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ordren er allerede refunderet.");
    expect(screen.getByRole("button", { name: "Bekræft retur" })).toBeInTheDocument();
  });
});

describe("S2-T-ORD-FRM-05: OrderRefundForm — not shipped and never captured: the reservation is released", () => {
  const PROPS = { ...REFUND_PROPS, shipped: false, captured: false };

  it("shows 'Reservationen frigives (intet trækkes).', no deduction field, 'Varen er ikke afsendt' checked", () => {
    render(withMessages(<OrderRefundForm {...PROPS} />));
    expect(screen.getByText("Reservationen frigives (intet trækkes).")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Fradrag/)).toBeNull();
    expect(screen.getByRole("radio", { name: "Varen er ikke afsendt" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Varen er modtaget retur" })).toBeDisabled();
  });

  it("confirms the release and sends goodsState not_shipped without a deduction", async () => {
    const user = userEvent.setup();
    mockApproveRefund.mockResolvedValue({ ok: true, status: "canceled" });
    render(withMessages(<OrderRefundForm {...PROPS} />));
    await user.click(screen.getByRole("button", { name: "Bekræft ikke afsendt" }));
    expect(
      screen.getByText("Frigiv reservationen på 179,00 kr. for jens@example.dk? Køberen trækkes ikke. Det kan ikke fortrydes."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Frigiv reservationen" }));
    expect(Object.fromEntries(mockApproveRefund.mock.calls[0]?.[0] as FormData)).toEqual({
      orderId: ORDER_ID,
      orderNumber: "1001",
      goodsState: "not_shipped",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(refund.done.canceled);
  });
});

describe("S2-T-ORD-FRM-06: OrderRefundForm — not shipped but captured at Checkout: refunded in full", () => {
  it("says the whole amount is refunded and confirms a refund", async () => {
    const user = userEvent.setup();
    render(withMessages(<OrderRefundForm {...REFUND_PROPS} shipped={false} />));
    expect(
      screen.getByText("Betalingen blev trukket ved bestillingen, så hele beløbet refunderes: 179,00 kr."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bekræft ikke afsendt" }));
    expect(screen.getByRole("button", { name: "Refundér 179,00 kr." })).toBeInTheDocument();
  });
});

describe("S2-T-ORD-FRM-07: OrderRefundForm — pending and after the refresh", () => {
  it("the confirm button shows a spinner and 'Tilbage' is disabled while the Worker works; the outcome stays", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<unknown>();
    mockApproveRefund.mockReturnValue(pending.promise);
    const { rerender } = render(withMessages(<OrderRefundForm {...REFUND_PROPS} />));
    await user.click(screen.getByRole("button", { name: "Bekræft retur" }));
    await user.click(screen.getByRole("button", { name: "Refundér 179,00 kr." }));
    expect(screen.getByRole("button", { name: "Refundér 179,00 kr." })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Tilbage" })).toBeDisabled();

    pending.resolve({ ok: true, status: "approved" });
    await screen.findByRole("status");
    rerender(withMessages(<OrderRefundForm {...REFUND_PROPS} available={false} />));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(refund.done.approved);
  });
});

describe("S2-T-ORD-FRM-09: OrderRefundForm — a notice that came by email or letter (no withdrawal yet)", () => {
  it("is headed 'Registrér fortrydelse' and says it records a withdrawal received by email or letter, without an em-dash", () => {
    render(withMessages(<OrderRefundForm {...REFUND_PROPS} offline />));
    expect(screen.getByRole("heading", { level: 2, name: "Registrér fortrydelse" })).toBeInTheDocument();
    const lead = screen.getByText(/^Har køberen fortrudt købet i en e-mail eller et brev/);
    expect(lead).toHaveTextContent(
      "Har køberen fortrudt købet i en e-mail eller et brev, registrerer du fortrydelsen her. Godkend, når varen er kommet retur, eller frigiv reservationen, hvis varen ikke er sendt.",
    );
    expect(lead.textContent).not.toContain("\u2014");
    expect(screen.queryByRole("heading", { name: "Behandl fortrydelse" })).toBeNull();
  });

  it("approves like an online withdrawal: the same confirmation, then approveRefund with the order's fields", async () => {
    const user = userEvent.setup();
    mockApproveRefund.mockResolvedValue({ ok: true, status: "completed" });
    render(withMessages(<OrderRefundForm {...REFUND_PROPS} offline />));
    await user.click(screen.getByRole("button", { name: "Bekræft retur" }));
    expect(screen.getByText("Refundér 179,00 kr. til jens@example.dk? Det kan ikke fortrydes.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refundér 179,00 kr." }));
    expect(await screen.findByRole("status")).toHaveTextContent(refund.done.completed);
    expect(mockApproveRefund).toHaveBeenCalledOnce();
    const sent = mockApproveRefund.mock.calls[0]![0] as FormData;
    expect(Object.fromEntries(sent)).toEqual({
      orderId: ORDER_ID,
      orderNumber: "1001",
      goodsState: "returned",
      deduction: "",
      deductionReason: "",
    });
  });

  it("an unshipped, uncaptured order: releasing the reservation, 'Bekræft ikke afsendt'", () => {
    render(withMessages(<OrderRefundForm {...REFUND_PROPS} offline shipped={false} captured={false} />));
    expect(screen.getByRole("heading", { level: 2, name: "Registrér fortrydelse" })).toBeInTheDocument();
    expect(screen.getByText("Reservationen frigives (intet trækkes).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bekræft ikke afsendt" })).toBeInTheDocument();
  });
});

describe("S2-T-ORD-FRM-D4: deterministic initial refund form hydration", () => {
  it.each([
    {
      state: "shipped, offline notice",
      props: { ...REFUND_PROPS, offline: true, availableOre: 24995 },
      heading: "Registrér fortrydelse",
      summary: "Refunderes: 249,95 kr.",
      selected: "Varen er modtaget retur",
      disabled: "Varen er ikke afsendt",
    },
    {
      state: "authorized, offline notice",
      props: { ...REFUND_PROPS, offline: true, shipped: false, captured: false, availableOre: 24995 },
      heading: "Registrér fortrydelse",
      summary: "Reservationen frigives (intet trækkes).",
      selected: "Varen er ikke afsendt",
      disabled: "Varen er modtaget retur",
    },
    {
      state: "authorized, existing withdrawal",
      props: { ...REFUND_PROPS, shipped: false, captured: false, availableOre: 24995 },
      heading: "Behandl fortrydelse",
      summary: "Reservationen frigives (intet trækkes).",
      selected: "Varen er ikke afsendt",
      disabled: "Varen er modtaget retur",
    },
  ])("$state: keeps the server's heading, amount, ids and radio state without hydration diagnostics", async ({
    props, heading, summary, selected, disabled,
  }) => {
    const element = withMessages(<OrderRefundForm {...props} />);
    let serverHtml: string;
    try {
      vi.stubGlobal("window", undefined);
      vi.stubGlobal("document", undefined);
      vi.stubGlobal("navigator", undefined);
      serverHtml = renderToString(element);
    } finally {
      vi.unstubAllGlobals();
    }
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    // Compare parsed DOM: HTML parsing lowercases attributes such as React's noValidate.
    const serverDom = container.innerHTML;
    document.body.appendChild(container);
    const form = within(container);
    expect(form.getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
    expect(container).toHaveTextContent(summary);
    expect(form.getByRole("radio", { name: selected })).toBeChecked();
    expect(form.getByRole("radio", { name: disabled })).toBeDisabled();
    expect(container.querySelector("[style]")).toBeNull();

    const diagnostics = vi.spyOn(console, "error");
    try {
      await act(async () => {
        render(element, { container, hydrate: true });
      });
      expect(container.innerHTML).toBe(serverDom);
      expect(diagnostics).not.toHaveBeenCalled();
    } finally {
      diagnostics.mockRestore();
    }
  });
});
