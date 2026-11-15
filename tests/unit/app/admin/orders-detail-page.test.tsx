// @vitest-environment jsdom
/**
 * Unit tests: src/app/admin/(panel)/orders/[orderNumber]/page.tsx
 * Journey: payments-s2-3d-purchase
 * Criteria: admin order detail page (contract §3)
 *
 * Test IDs: S2-T-ORD-DET-01..13
 *
 * Copy pinned from s2-admin-order-detail.html mock, updated to amendments A1/A2
 * (charge on dispatch; no em-dash):
 *   buyer section:          "Køber og levering"
 *   moms (179,00 kr):       "35,80 kr." (3580 øre = 25% of 17900)
 *   timeline:               "Betaling reserveret" | "Ordrebekræftelse sendt" | "Afsendt" |
 *                           "Fortrydelse modtaget" | "frist"
 *   late flag:              "For sent (efter fristen)"  (late=true)
 *   reservation:            "Betaling reserveret til <dato>", warning < 48 h
 *   markShipped btn:        "Markér afsendt og træk betalingen" (reserved, no withdrawal)
 *   approveRefund btn:      "Bekræft retur" (shipped) | "Bekræft ikke afsendt" (not shipped)
 *   offline notice:         "Registrér fortrydelse" (reserved or shipped, no withdrawal yet)
 *
 * The page renders inside AdminShell's `<main>`; the tests wrap it in one as
 * the shell does. Date.now() is pinned (only Date is faked) for the
 * reservation's 48-hour warning.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockRequireAdmin, mockGetOrderByNumber, mockNotFound } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockGetOrderByNumber: vi.fn(),
  mockNotFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));

vi.mock("next-intl/server", async () =>
  // Exception: vi.mock factory is hoisted; must dynamically import the helper.
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/components/site/SiteFooter", () => ({ default: () => <footer /> }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/admin/orders/1001",
  notFound: mockNotFound,
}));
vi.mock("@/services/auth/require-admin", () => ({ requireAdmin: mockRequireAdmin }));
vi.mock("@/services/admin/orders", () => ({ getOrderByNumber: mockGetOrderByNumber }));
vi.mock("@/app/admin/(panel)/orders/actions", () => ({
  markShipped: vi.fn(),
  approveRefund: vi.fn(),
}));

import AdminOrderDetailPage from "@/app/admin/(panel)/orders/[orderNumber]/page";
import type { AdminOrderDetail } from "@/services/admin/orders";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ADMIN_USER = { userId: "admin-uuid", email: "admin@example.com", role: "admin" as const };

const BASE_ORDER: AdminOrderDetail = {
  id: "00000000-0000-0000-0000-000000000001",
  orderNumber: 1001,
  email: "jens@example.dk",
  customerName: "Jens Nielsen",
  phone: "+4512345678",
  shippingName: "Jens Nielsen",
  shippingAddress: {
    line1: "Storgade 12, 2. tv.",
    line2: null,
    postal_code: "8000",
    city: "Aarhus C",
    country: "DK",
  },
  amountTotalOre: 17900,
  amountTaxOre: 3580,
  amountRefundedOre: 0,
  locale: "da",
  status: "authorized",
  paidAt: "2026-11-13T09:40:00Z",
  confirmationSentAt: "2026-11-13T09:40:00Z",
  authorizationExpiresAt: "2026-11-20T09:40:00Z",
  capturedAt: null,
  canceledAt: null,
  cancelReason: null,
  shippedAt: null,
  trackingRef: null,
  anomaly: null,
  stripeCheckoutSessionId: "cs_live_abc123",
  stripePaymentIntentId: "pi_live_abc123",
  stripeCustomerId: null,
  stripeInvoiceId: "in_live_abc123",
  lines: [
    {
      title: "Ugle, 8 cm",
      offerKind: "physical",
      quantity: 1,
      unitAmountOre: 17900,
      amountTotalOre: 17900,
    },
  ],
  withdrawal: null,
};

/** An open withdrawal (no approval yet). */
const RECEIVED: NonNullable<AdminOrderDetail["withdrawal"]> = {
  status: "received",
  requestedAt: "2026-11-18T20:11:00Z",
  deadlineAt: "2026-12-05T10:05:00Z",
  late: false,
  refundDueAt: "2026-12-02T20:11:00Z",
  deductionOre: 0,
  deductionReason: null,
  refundOre: null,
  completedAt: null,
  manualReason: null,
};

/** Reserved order withdrawn before dispatch: Markér afsendt hidden, "Bekræft ikke afsendt" shown. */
const PAID_WITH_WD: AdminOrderDetail = {
  ...BASE_ORDER,
  withdrawal: { ...RECEIVED, deadlineAt: null },
};

/** Shipped (captured) order with late withdrawal (deadline in the past). */
const SHIPPED_LATE_WD: AdminOrderDetail = {
  ...BASE_ORDER,
  status: "shipped",
  capturedAt: "2026-11-14T10:05:00Z",
  shippedAt: "2026-11-14T10:05:00Z",
  trackingRef: "00370712345678",
  amountRefundedOre: 0,
  withdrawal: {
    ...RECEIVED,
    deadlineAt: "2026-11-05T10:05:00Z", // before requestedAt → late
    late: true,
  },
};

/** Refunded order: neither action shown. */
const REFUNDED_ORDER: AdminOrderDetail = {
  ...BASE_ORDER,
  status: "refunded",
  amountRefundedOre: 17900,
  capturedAt: "2026-11-14T10:05:00Z",
  shippedAt: "2026-11-14T10:05:00Z",
  withdrawal: {
    ...RECEIVED,
    status: "completed",
    refundOre: 17900,
    completedAt: "2026-11-25T08:00:00Z",
  },
};

/** Anomaly order */
const ANOMALY_ORDER: AdminOrderDetail = {
  ...BASE_ORDER,
  anomaly: "tax_mismatch",
};

/** "Now" for every test: 2026-11-14 12:00 UTC, so BASE_ORDER's reservation (until 2026-11-20) is not yet near its end. */
const NOW = new Date("2026-11-14T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mockRequireAdmin.mockResolvedValue(ADMIN_USER);
  mockGetOrderByNumber.mockResolvedValue(BASE_ORDER);
});

async function renderDetail(orderNumber: string | number) {
  render(
    <main>
      {await AdminOrderDetailPage({
        params: Promise.resolve({ orderNumber: String(orderNumber) }),
      })}
    </main>,
  );
}

// ── S2-T-ORD-DET-01: 404 for invalid number without DB call ───────────────

describe("S2-T-ORD-DET-01: AdminOrderDetailPage — 404 for invalid numbers", () => {
  it.each(["abc", "1.5", "1e3"])(
    "notFound() called for '%s' without calling getOrderByNumber",
    async (n) => {
      await expect(renderDetail(n)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mockNotFound).toHaveBeenCalled();
      expect(mockGetOrderByNumber).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "-1"])("notFound() called for numeric-but-invalid '%s'", async (n) => {
    mockGetOrderByNumber.mockResolvedValue(null);
    await expect(renderDetail(n)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });

  it("notFound() called when getOrderByNumber returns null (unknown order)", async () => {
    mockGetOrderByNumber.mockResolvedValue(null);
    await expect(renderDetail(99999)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

// ── S2-T-ORD-DET-02: requireAdmin before getOrderByNumber ─────────────────

describe("S2-T-ORD-DET-02: AdminOrderDetailPage — requireAdmin called before getOrderByNumber", () => {
  it("requireAdmin invocation order < getOrderByNumber invocation order", async () => {
    await renderDetail("1001");
    expect(mockRequireAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetOrderByNumber.mock.invocationCallOrder[0]!,
    );
  });
});

// ── S2-T-ORD-DET-03: buyer section with all fields ───────────────────────

describe("S2-T-ORD-DET-03: AdminOrderDetailPage — buyer section", () => {
  it("shows 'Køber og levering' section heading", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("Køber og levering");
  });

  it("shows buyer email 'jens@example.dk'", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("jens@example.dk");
  });

  it("shows phone number '+4512345678'", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("+4512345678");
  });

  it("shows shipping address 'Storgade 12'", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("Storgade 12");
  });
});

// ── S2-T-ORD-DET-04: line items and amounts ──────────────────────────────

describe("S2-T-ORD-DET-04: AdminOrderDetailPage — line items and amounts", () => {
  it("shows item title 'Ugle, 8 cm'", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("Ugle, 8 cm");
  });

  it("shows total amount 179,00 kr.", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("179,00");
  });

  it("shows moms '35,80' (amountTaxOre=3580) in the amounts section", async () => {
    await renderDetail("1001");
    // Scoped to the "Varer" section (the buyer's <dl> comes first, as in the mock).
    const amounts = screen.getByRole("region", { name: "Varer" });
    expect(amounts.textContent).toContain("35,80");
    // Moms label present alongside the amount
    expect(amounts.textContent).toMatch(/moms \(25 %\)/i);
  });

  it("shows non-zero refunded amount '159,00' when amountRefundedOre=15900", async () => {
    // Use a fixture with a real refunded amount to avoid "0,00" false-positive via
    // substrings of other amounts (formatKroner renders 0 øre as "0", not "0,00").
    mockGetOrderByNumber.mockResolvedValue({
      ...BASE_ORDER,
      amountRefundedOre: 15900,
    });
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("159,00");
  });
});

// ── S2-T-ORD-DET-05: Stripe IDs ──────────────────────────────────────────

describe("S2-T-ORD-DET-05: AdminOrderDetailPage — Stripe IDs shown", () => {
  it("shows checkout session ID", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("cs_live_abc123");
  });

  it("shows payment intent ID", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("pi_live_abc123");
  });

  it("shows invoice ID", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("in_live_abc123");
  });
});

// ── S2-T-ORD-DET-06: anomaly shown ───────────────────────────────────────

describe("S2-T-ORD-DET-06: AdminOrderDetailPage — anomaly text shown", () => {
  it("shows 'tax_mismatch' when anomaly present", async () => {
    mockGetOrderByNumber.mockResolvedValue(ANOMALY_ORDER);
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("tax_mismatch");
  });

  it("does not show anomaly content when anomaly is null", async () => {
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).not.toContain("tax_mismatch");
  });
});

// ── S2-T-ORD-DET-07: timeline scoped to timeline list ────────────────────

describe("S2-T-ORD-DET-07: AdminOrderDetailPage — timeline entries", () => {
  function getTimeline() {
    // The timeline is an ordered list named by its "Forløb" heading
    return screen.getByRole("list", { name: "Forløb" });
  }

  it("shows the 'Betaling reserveret' entry (A1: authorized at Checkout, not paid) in the timeline", async () => {
    await renderDetail("1001");
    expect(getTimeline().textContent).toContain("Betaling reserveret");
    expect(getTimeline().textContent).toContain("2026");
  });

  it("shows 'Ordrebekræftelse sendt' when confirmationSentAt set", async () => {
    await renderDetail("1001");
    expect(getTimeline().textContent).toContain("Ordrebekræftelse sendt");
  });

  it("shows 'Afsendt' and tracking ref when shippedAt set", async () => {
    mockGetOrderByNumber.mockResolvedValue(SHIPPED_LATE_WD);
    await renderDetail("1001");
    expect(getTimeline().textContent).toContain("Afsendt");
    expect(getTimeline().textContent).toContain("00370712345678");
  });

  it("shows 'Fortrydelse modtaget' and 'frist' when withdrawal present", async () => {
    mockGetOrderByNumber.mockResolvedValue(SHIPPED_LATE_WD);
    await renderDetail("1001");
    expect(getTimeline().textContent).toContain("Fortrydelse modtaget");
    expect(getTimeline().textContent).toContain("frist");
  });
});

// ── S2-T-ORD-DET-08: late flag ────────────────────────────────────────────

describe("S2-T-ORD-DET-08: AdminOrderDetailPage — late flag", () => {
  it("shows 'For sent (efter fristen)' when late=true", async () => {
    mockGetOrderByNumber.mockResolvedValue(SHIPPED_LATE_WD);
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain("For sent (efter fristen)");
  });

  it("does not show 'For sent' when late=false", async () => {
    mockGetOrderByNumber.mockResolvedValue(PAID_WITH_WD);
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).not.toContain("For sent (efter fristen)");
  });
});

// ── S2-T-ORD-DET-09: Markér afsendt visibility rules ─────────────────────

describe("S2-T-ORD-DET-09: AdminOrderDetailPage — Markér afsendt visibility", () => {
  it("'Markér afsendt og træk betalingen' shown for a reserved order with no withdrawal", async () => {
    await renderDetail("1001");
    expect(
      within(screen.getByRole("main")).getByRole("button", { name: "Markér afsendt og træk betalingen" }),
    ).toBeInTheDocument();
  });

  it("'Markér afsendt' (no capture) for a reserved order whose payment was captured at Checkout", async () => {
    mockGetOrderByNumber.mockResolvedValue({
      ...BASE_ORDER,
      capturedAt: BASE_ORDER.paidAt,
      anomaly: "captured_at_checkout",
    });
    await renderDetail("1001");
    expect(within(screen.getByRole("main")).getByRole("button", { name: "Markér afsendt" })).toBeInTheDocument();
  });

  it("hidden for a reserved order with a pending withdrawal (withdrawal_pending guards)", async () => {
    mockGetOrderByNumber.mockResolvedValue(PAID_WITH_WD);
    await renderDetail("1001");
    expect(
      within(screen.getByRole("main")).queryByRole("button", { name: /Markér afsendt/ }),
    ).toBeNull();
  });

  it("hidden for refunded order", async () => {
    mockGetOrderByNumber.mockResolvedValue(REFUNDED_ORDER);
    await renderDetail("1001");
    expect(
      within(screen.getByRole("main")).queryByRole("button", { name: /Markér afsendt/ }),
    ).toBeNull();
  });
});

// ── S2-T-ORD-DET-10: Bekræft retur visibility rules ─────────────────────

describe("S2-T-ORD-DET-10: AdminOrderDetailPage — withdrawal approval visibility (A1 goods states)", () => {
  it("'Bekræft ikke afsendt' shown when the withdrawal of a reserved, unshipped order is received", async () => {
    mockGetOrderByNumber.mockResolvedValue(PAID_WITH_WD);
    await renderDetail("1001");
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("button", { name: "Bekræft ikke afsendt" })).toBeInTheDocument();
    expect(main.getByText("Reservationen frigives (intet trækkes).")).toBeInTheDocument();
    expect(main.queryByLabelText(/Fradrag/)).toBeNull();
  });

  it("'Bekræft retur' with the deduction field shown when the withdrawal of a shipped order is received", async () => {
    mockGetOrderByNumber.mockResolvedValue(SHIPPED_LATE_WD);
    await renderDetail("1001");
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("button", { name: "Bekræft retur" })).toBeInTheDocument();
    expect(main.getByLabelText(/Fradrag for værdiforringelse/)).toBeInTheDocument();
    expect(main.getByRole("radio", { name: "Varen er modtaget retur" })).toBeChecked();
    expect(main.getByRole("radio", { name: "Varen er ikke afsendt" })).toBeDisabled();
  });

  it("a reserved order with no withdrawal: offered as the offline notice ('Registrér fortrydelse'), not 'Behandl fortrydelse'", async () => {
    await renderDetail("1001");
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("heading", { level: 2, name: "Registrér fortrydelse" })).toBeInTheDocument();
    expect(main.queryByRole("heading", { level: 2, name: "Behandl fortrydelse" })).toBeNull();
  });

  it("hidden for refunded (completed) order", async () => {
    mockGetOrderByNumber.mockResolvedValue(REFUNDED_ORDER);
    await renderDetail("1001");
    expect(
      within(screen.getByRole("main")).queryByRole("button", { name: /Bekræft (retur|ikke afsendt)/i }),
    ).toBeNull();
  });
});

// ── S2-T-ORD-DET-11: reservation expiry (A1) ──────────────────────────────

describe("S2-T-ORD-DET-11: AdminOrderDetailPage — 'Betaling reserveret til' and the 48-hour warning", () => {
  it("shows until when the payment is reserved, without a warning while more than 48 h are left", async () => {
    await renderDetail("1001");
    const main = screen.getByRole("main");
    expect(main.textContent).toMatch(/Betaling reserveret til 20\. nov\. 2026/);
    expect(main.textContent).not.toContain("Reservationen udløber om under 48 timer");
  });

  it("warns once less than 48 h are left", async () => {
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).toContain(
      "Reservationen udløber om under 48 timer. Send varen, og markér den afsendt inden da, ellers bortfalder betalingen.",
    );
  });

  it("says not to send the goods once the reservation has lapsed", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
    await renderDetail("1001");
    const main = screen.getByRole("main");
    expect(main.textContent).toContain("Reservationen er udløbet. Send ikke varen.");
    expect(main.textContent).not.toContain("Betaling reserveret til");
  });

  it("shows no reservation for a shipped (captured) order", async () => {
    mockGetOrderByNumber.mockResolvedValue(SHIPPED_LATE_WD);
    await renderDetail("1001");
    expect(screen.getByRole("main").textContent).not.toContain("Betaling reserveret til");
  });
});

// ── S2-T-ORD-DET-12: canceled and refunded outcomes in the timeline (A1) ──

describe("S2-T-ORD-DET-12: AdminOrderDetailPage — canceled (released) and refunded orders", () => {
  it("a reservation released after a withdrawal: 'Annulleret' badge, 'Reservationen frigivet' and the cancel reason", async () => {
    mockGetOrderByNumber.mockResolvedValue({
      ...PAID_WITH_WD,
      status: "canceled",
      canceledAt: "2026-11-19T08:00:00Z",
      cancelReason: "withdrawn",
      withdrawal: {
        ...PAID_WITH_WD.withdrawal!,
        status: "completed",
        completedAt: "2026-11-19T08:00:00Z",
      },
    });
    await renderDetail("1001");
    const main = within(screen.getByRole("main"));
    expect(main.getByText("Annulleret", { selector: "span" })).toBeInTheDocument();
    const timeline = screen.getByRole("list", { name: "Forløb" }).textContent;
    expect(timeline).toContain("Reservationen frigivet");
    expect(timeline).toContain("købet blev fortrudt før afsendelse");
    expect(main.queryByRole("button")).toBeNull();
  });

  it("a refund after a deduction: the refunded amount, the deduction and its reason", async () => {
    mockGetOrderByNumber.mockResolvedValue({
      ...REFUNDED_ORDER,
      amountRefundedOre: 12900,
      withdrawal: {
        ...REFUNDED_ORDER.withdrawal!,
        deductionOre: 5000,
        deductionReason: "Figuren er malet om.",
        refundOre: 12900,
      },
    });
    await renderDetail("1001");
    const timeline = screen.getByRole("list", { name: "Forløb" }).textContent;
    expect(timeline).toContain("Refunderet 129,00 kr.");
    expect(timeline).toContain("Fradrag 50,00 kr.: Figuren er malet om.");
  });
});

// ── S2-T-ORD-DET-13: a notice by email or letter (S2-ADM-* web detail) ───

describe("S2-T-ORD-DET-13: AdminOrderDetailPage — 'Registrér fortrydelse' for an open order without a withdrawal", () => {
  const LEAD =
    "Har køberen fortrudt købet i en e-mail eller et brev, registrerer du fortrydelsen her. Godkend, når varen er kommet retur, eller frigiv reservationen, hvis varen ikke er sendt.";

  it("a reserved order: the notice can be recorded as not shipped (release), next to 'Markér afsendt'", async () => {
    await renderDetail("1001");
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("heading", { level: 2, name: "Registrér fortrydelse" })).toBeInTheDocument();
    expect(main.getByText(LEAD)).toBeInTheDocument();
    expect(main.getByRole("radio", { name: "Varen er ikke afsendt" })).toBeChecked();
    expect(main.getByRole("button", { name: "Bekræft ikke afsendt" })).toBeInTheDocument();
    expect(main.getByRole("button", { name: "Markér afsendt og træk betalingen" })).toBeInTheDocument();
  });

  it("a shipped order: the notice is recorded as returned, with the deduction field", async () => {
    mockGetOrderByNumber.mockResolvedValue({ ...SHIPPED_LATE_WD, withdrawal: null });
    await renderDetail("1001");
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("heading", { level: 2, name: "Registrér fortrydelse" })).toBeInTheDocument();
    expect(main.getByText(LEAD)).toBeInTheDocument();
    expect(main.getByRole("radio", { name: "Varen er modtaget retur" })).toBeChecked();
    expect(main.getByLabelText(/Fradrag for værdiforringelse/)).toBeInTheDocument();
    expect(main.getByRole("button", { name: "Bekræft retur" })).toBeInTheDocument();
  });

  it("a received online withdrawal keeps 'Behandl fortrydelse' and its own lead", async () => {
    mockGetOrderByNumber.mockResolvedValue(SHIPPED_LATE_WD);
    await renderDetail("1001");
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("heading", { level: 2, name: "Behandl fortrydelse" })).toBeInTheDocument();
    expect(main.queryByText(LEAD)).toBeNull();
  });

  it.each([
    ["a canceled order", { status: "canceled" as const, canceledAt: "2026-11-19T08:00:00Z", cancelReason: "authorization_expired" as const }],
    ["a refunded order", { status: "refunded" as const, capturedAt: "2026-11-14T10:05:00Z", shippedAt: "2026-11-14T10:05:00Z", amountRefundedOre: 17900 }],
  ])("not offered for %s without a withdrawal", async (_, changes) => {
    mockGetOrderByNumber.mockResolvedValue({ ...BASE_ORDER, ...changes, withdrawal: null });
    await renderDetail("1001");
    const main = within(screen.getByRole("main"));
    expect(main.queryByRole("heading", { name: /fortrydelse/ })).toBeNull();
    expect(main.queryByRole("button", { name: /Bekræft (retur|ikke afsendt)/ })).toBeNull();
  });
});
