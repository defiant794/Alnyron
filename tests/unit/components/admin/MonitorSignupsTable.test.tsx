// @vitest-environment jsdom
/**
 * Unit tests — MonitorSignupsTable component (admin-monitor-users-cleanup + admin-monitor-users-sites)
 *
 * Journey: admin-monitor-users-cleanup  AMC-16, AMC-17, AMC-18, AMC-19, AMC-20,
 *          AMC-21, AMC-22, AMC-23, AMC-24, AMC-25, AMC-26, AMC-27
 * Journey: payments-slice1-foundation   PAY1-AC6d
 * Journey: admin-monitor-users-sites    AMSS-7, AMSS-8, AMSS-9, AMSS-11 (headers and count: AMC-16, AC-AMU-08/09)
 *
 * Cell index note: within(row).getAllByRole("cell") returns only <td> nodes,
 * not the email <th scope="row"> (role=rowheader). Indexes are therefore:
 *   cells[0] = Oprettet, cells[1] = Status, cells[2] = Overvåger, cells[3] = Overvågninger, cells[4] = Handlinger.
 *
 * Also covers: AC-AMU-04 (email row header), AC-AMU-05 (date),
 *   AC-AMU-08/09 (monitor count), AC-AMU-11 (empty state), AC-AMU-13 (labelled-by),
 *   AC-AMU-16 (the scroll wrapper is the sr-only suffixes' containing block).
 *
 * summary prop: the page (server component) formats the ICU summary string via
 * t("summary", counts) and passes the formatted string to the client table.
 * The dialog body is formatted by next-intl in the client: the table renders
 * under a NextIntlClientProvider holding the real `Admin.monitorUsers.delete.body`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { NextIntlClientProvider } from "next-intl";
import MonitorSignupsTable, { type MonitorSignupsTableProps } from "@/components/admin/MonitorSignupsTable";
import type { MonitorSignup } from "@/services/admin/monitor-users";
import type { MonitorSignupStatus } from "@/lib/monitor/signup-status";
import type { DeleteMonitorUserResult } from "@/services/admin/monitor-users";
import { formatDateTime } from "@/lib/monitor/format";
import da from "../../../../messages/da.json";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const { mockDeleteMonitorSignup } = vi.hoisted(() => ({
  mockDeleteMonitorSignup: vi.fn<(id: unknown) => Promise<DeleteMonitorUserResult>>(),
}));

vi.mock("@/app/admin/(panel)/monitor-users/actions", () => ({
  deleteMonitorSignup: mockDeleteMonitorSignup,
}));

// jsdom: HTMLDialogElement lacks showModal / close; polyfill for unit tests.
// close() fires the `close` event as a browser does (the table moves the focus on it).
beforeEach(() => {
  vi.clearAllMocks();
  // Set default after clearAllMocks so the value survives.
  mockDeleteMonitorSignup.mockResolvedValue({ ok: true });
  HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn().mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISO_NEWER = "2026-10-15T09:00:00.000Z";
const ISO_OLDER = "2026-09-01T14:30:00.000Z";

/** Pinned from running the production formatter: formatDateTime(ISO_NEWER). */
const FORMATTED_NEWER = "15. okt. 2026, 11.00";

type TableLabels = MonitorSignupsTableProps["labels"];

/** Column, empty-state and dialog copy as the page passes it (the dialog body comes from the provider). */
const LABELS: TableLabels = {
  email: "E-mail",
  signedUp: "Oprettet",
  status: "Status",
  sites: "Overvåger",
  sitesNone: "Ingen",
  sitesPaused: "sat på pause",
  newTab: "åbner i ny fane",
  monitors: "Overvågninger",
  actions: "Handlinger",
  empty: "Ingen tilmeldinger endnu.",
  delete: {
    open: "Slet",
    title: "Slet tilmelding?",
    confirm: "Slet tilmelding",
    pending: "Sletter\u2026",
    cancel: "Annuller",
    errors: {
      failed: "Tilmeldingen kunne ikke slettes. Prøv igen.",
      notFound: "Tilmeldingen findes ikke længere.",
      notMonitorUser: "Kun Monitor-brugere kan slettes her.",
      hasActiveSubscription: "Kontoen har et abonnement, der ikke er ophørt, og kan først slettes, når det er ophørt.",
    },
  },
};

const STATUSES: Record<MonitorSignupStatus, string> = {
  registered: "Tilmeldt",
  pending: "Afventer bekræftelse",
  expired: "Udløbet",
};

/**
 * Labels with extra confirmed/yes/no keys (the copy of a "Bekræftet" column
 * with Ja/Nej badges): AMC-17 proves the table renders none of them even
 * when they are supplied.
 */
const LABELS_WITH_CONFIRMED = {
  ...LABELS,
  confirmed: "Bekræftet",
  yes: "Ja",
  no: "Nej",
};

/** The one message the page's client provider holds: the real dialog body. */
const BODY_MESSAGES = { Admin: { monitorUsers: { delete: { body: da.Admin.monitorUsers.delete.body } } } };

type RowWithStatus = MonitorSignup & { status: MonitorSignupStatus };

const ROWS: RowWithStatus[] = [
  {
    email: "newer@example.com",
    userId: "u-newer-uuid",
    signedUpAt: ISO_NEWER,
    confirmed: true,
    monitorCount: 2,
    monitors: [],
    status: "registered",
  },
  {
    email: "pending@example.com",
    userId: "u-pending-uuid",
    signedUpAt: ISO_OLDER,
    confirmed: false,
    monitorCount: 0,
    monitors: [],
    status: "pending",
  },
  {
    email: "older@example.com",
    userId: "u-older-uuid",
    signedUpAt: ISO_OLDER,
    confirmed: false,
    monitorCount: 0,
    monitors: [],
    status: "expired",
  },
];

/**
 * Summary string passed from the server page (the page calls
 * t("summary", counts) and passes the result). The table renders it verbatim.
 */
const SUMMARY = "1 tilmeldt · 1 afventer · 1 udløbet";

/** The table as the page renders it (inside the client provider with the dialog body), for render and rerender. */
function tableUi(
  rows: RowWithStatus[] = ROWS,
  summary: string = SUMMARY,
  labelledBy = "test-heading",
  labels: TableLabels = LABELS,
) {
  return (
    <NextIntlClientProvider locale="da" messages={BODY_MESSAGES}>
      <MonitorSignupsTable rows={rows} labelledBy={labelledBy} summary={summary} statuses={STATUSES} labels={labels} />
    </NextIntlClientProvider>
  );
}

function renderTable(rows?: RowWithStatus[], summary?: string, labelledBy?: string, labels?: TableLabels) {
  return render(tableUi(rows, summary, labelledBy, labels));
}

/** A row's Slet button (whitespace-tolerant: Chromium may insert a space before the sr-only address). */
function sletButton(email: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^\\s*Slet[\\s\\S]*${email.replace(/[.@]/g, "\\$&")}`) });
}

/** Opens the dialog for `email` and presses "Slet tilmelding"; returns the dialog. */
async function confirmDeleteOf(user: UserEvent, email: string): Promise<HTMLElement> {
  await user.click(sletButton(email));
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));
  return dialog;
}

/**
 * A browser moves the focus to <body> from a focused button once it is disabled (the pressed
 * "Slet tilmelding" while the delete runs). jsdom keeps it on the button and ignores a disabled
 * button's blur(), so a stand-in button takes the focus and leaves it.
 */
function dropFocusToBody(): void {
  const standIn = document.body.appendChild(document.createElement("button"));
  standIn.focus();
  standIn.blur();
  standIn.remove();
}

/** Row element for a given email (finds via row header). */
function rowFor(email: string): HTMLElement {
  const th = screen.getByRole("rowheader", { name: email });
  const tr = th.closest("tr");
  if (!tr) throw new Error(`No <tr> parent found for rowheader "${email}"`);
  return tr as HTMLElement;
}

// ── AMC-16: six column headers in order ──────────────────────────────────────

describe("AMC-16: MonitorSignupsTable — six column headers in order", () => {
  it("AMC-16: headers are E-mail, Oprettet, Status, Overvåger, Overvågninger, Handlinger", () => {
    renderTable();
    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(6);
    expect(headers[0]).toHaveTextContent("E-mail");
    expect(headers[1]).toHaveTextContent("Oprettet");
    expect(headers[2]).toHaveTextContent("Status");
    expect(headers[3]).toHaveTextContent("Overvåger");
    expect(headers[4]).toHaveTextContent("Overvågninger");
    expect(headers[5]).toHaveTextContent("Handlinger");
  });
});

// ── AMC-17: no Bekræftet column, no Ja/Nej badges ────────────────────────────
// LABELS_WITH_CONFIRMED includes confirmed/yes/no to prove the table ignores them.

describe("AMC-17: MonitorSignupsTable — Bekræftet column and Ja/Nej badges absent", () => {
  it("AMC-17a: 'Bekræftet' is not a column header even when labels.confirmed is supplied", () => {
    renderTable(ROWS, SUMMARY, "test-heading", LABELS_WITH_CONFIRMED);
    const headerTexts = screen.getAllByRole("columnheader").map((h) => h.textContent ?? "");
    expect(headerTexts).not.toContain("Bekræftet");
  });

  it("AMC-17b: 'Ja' text is absent from the table even when labels.yes is supplied", () => {
    renderTable(ROWS, SUMMARY, "test-heading", LABELS_WITH_CONFIRMED);
    const table = screen.getByRole("table");
    expect(within(table).queryByText("Ja")).toBeNull();
  });

  it("AMC-17c: 'Nej' text is absent from the table even when labels.no is supplied", () => {
    renderTable(ROWS, SUMMARY, "test-heading", LABELS_WITH_CONFIRMED);
    const table = screen.getByRole("table");
    expect(within(table).queryByText("Nej")).toBeNull();
  });
});

// ── AC-AMU-04: email is a row header ─────────────────────────────────────────

describe("AC-AMU-04: MonitorSignupsTable — email cell is a row header", () => {
  it("AC-AMU-04: each email renders as role=rowheader", () => {
    renderTable();
    expect(screen.getByRole("rowheader", { name: "newer@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "older@example.com" })).toBeInTheDocument();
  });
});

// ── AC-AMU-05: date formatting ────────────────────────────────────────────────

describe("AC-AMU-05: MonitorSignupsTable — Oprettet cell shows Danish formatted date", () => {
  it("AC-AMU-05a: newer row's Oprettet cell shows formatted date", () => {
    renderTable();
    const row = rowFor("newer@example.com");
    const cells = within(row).getAllByRole("cell");
    // cells[0] = Oprettet
    expect(cells[0]).toHaveTextContent(FORMATTED_NEWER);
  });

  it("AC-AMU-05b: pinned formatter output for ISO_NEWER matches FORMATTED_NEWER", () => {
    expect(formatDateTime(ISO_NEWER)).toBe(FORMATTED_NEWER);
  });
});

// ── AMC-18: Status badge "Tilmeldt" for registered ────────────────────────────

describe("AMC-18: MonitorSignupsTable — registered row shows 'Tilmeldt' badge", () => {
  it("AMC-18: row with status='registered' has status cell text 'Tilmeldt'", () => {
    renderTable();
    const row = rowFor("newer@example.com");
    const cells = within(row).getAllByRole("cell");
    // cells[1] = Status
    expect(cells[1]).toHaveTextContent("Tilmeldt");
  });
});

// ── AMC-19: Status badge "Afventer bekræftelse" for pending ───────────────────

describe("AMC-19: MonitorSignupsTable — pending row shows 'Afventer bekræftelse' badge", () => {
  it("AMC-19: row with status='pending' has status cell text 'Afventer bekræftelse'", () => {
    renderTable();
    const row = rowFor("pending@example.com");
    const cells = within(row).getAllByRole("cell");
    // cells[1] = Status
    expect(cells[1]).toHaveTextContent("Afventer bekræftelse");
  });
});

// ── AMC-20: Status badge "Udløbet" + muted row for expired ───────────────────

describe("AMC-20: MonitorSignupsTable — expired row shows 'Udløbet' badge and is muted", () => {
  it("AMC-20a: row with status='expired' has status cell text 'Udløbet'", () => {
    renderTable();
    const row = rowFor("older@example.com");
    const cells = within(row).getAllByRole("cell");
    // cells[1] = Status
    expect(cells[1]).toHaveTextContent("Udløbet");
  });

  it("AMC-20b: expired row element has a muted class (text-muted)", () => {
    renderTable();
    const row = rowFor("older@example.com");
    expect(row.className).toMatch(/text-muted/);
  });

  it("AMC-20c: the Udløbet row keeps its Slet button", () => {
    renderTable();
    const row = rowFor("older@example.com");
    expect(within(row).getByRole("button", { name: /^\s*Slet[\s\S]*older@example\.com/ })).toBeInTheDocument();
  });
});

// ── AC-AMU-08/09: monitor count ────────────────────────────────────────────────

describe("AC-AMU-08: MonitorSignupsTable — zero monitor count renders '0'", () => {
  it("AC-AMU-08: row with monitorCount=0 shows '0' in Overvågninger cell", () => {
    renderTable();
    const row = rowFor("older@example.com");
    const cells = within(row).getAllByRole("cell");
    // cells[3] = Overvågninger (shifted right by the new Overvåger column at cells[2])
    expect(cells[3]).toHaveTextContent("0");
  });
});

describe("AC-AMU-09: MonitorSignupsTable — non-zero monitor count renders correctly", () => {
  it("AC-AMU-09: row with monitorCount=2 shows '2' in Overvågninger cell", () => {
    renderTable();
    const row = rowFor("newer@example.com");
    const cells = within(row).getAllByRole("cell");
    // cells[3] = Overvågninger (shifted right by the new Overvåger column at cells[2])
    expect(cells[3]).toHaveTextContent("2");
  });
});

// ── AC-AMU-11: empty state ─────────────────────────────────────────────────────

describe("AC-AMU-11: MonitorSignupsTable — empty state renders <p> and no table", () => {
  it("AC-AMU-11a: empty rows renders the empty message paragraph", () => {
    renderTable([], "");
    expect(screen.getByText("Ingen tilmeldinger endnu.")).toBeInTheDocument();
  });

  it("AC-AMU-11b: empty rows does not render a table", () => {
    renderTable([], "");
    expect(screen.queryByRole("table")).toBeNull();
  });
});

// ── AC-AMU-13: table labelled by its heading ──────────────────────────────────

describe("AC-AMU-13: MonitorSignupsTable — table is labelled by labelledBy prop", () => {
  it("AC-AMU-13: table has aria-labelledby pointing to the given heading id", () => {
    renderTable(ROWS, SUMMARY, "my-heading");
    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("aria-labelledby", "my-heading");
  });
});

// ── AC-AMU-16: the table scrolls in its card, never the page ──────────────────

describe("AC-AMU-16: MonitorSignupsTable — the scroll wrapper contains the Slet buttons' sr-only addresses", () => {
  it("AC-AMU-16: the table's overflow-x-auto wrapper is positioned, so each sr-only (absolute) suffix is placed inside it", () => {
    renderTable();
    const wrapper = screen.getByRole("table").parentElement;
    expect(wrapper).toHaveClass("relative", "overflow-x-auto");
    const suffixes = [...(wrapper?.querySelectorAll(".sr-only") ?? [])];
    expect(suffixes).toHaveLength(ROWS.length);
    for (const suffix of suffixes) {
      // The suffix's containing block: its nearest positioned ancestor must lie within the scroll wrapper.
      const containingBlock = suffix.parentElement?.closest(".relative, .absolute, .fixed, .sticky") ?? null;
      expect(containingBlock !== null && wrapper?.contains(containingBlock)).toBe(true);
    }
  });
});

// ── AMC-27: summary line ──────────────────────────────────────────────────────

describe("AMC-27: MonitorSignupsTable — renders the pre-formatted summary string above the table", () => {
  it("AMC-27a: summary '2 tilmeldte · 1 afventer · 3 udløbne' is rendered verbatim", () => {
    renderTable(ROWS, "2 tilmeldte · 1 afventer · 3 udløbne");
    expect(screen.getByText("2 tilmeldte · 1 afventer · 3 udløbne")).toBeInTheDocument();
  });

  it("AMC-27b: singular '1 tilmeldt · 0 afventer · 1 udløbet' is rendered verbatim", () => {
    renderTable(ROWS, "1 tilmeldt · 0 afventer · 1 udløbet");
    expect(screen.getByText("1 tilmeldt · 0 afventer · 1 udløbet")).toBeInTheDocument();
  });
});

// ── AMC-21: Slet opens dialog with email ────────────────────────────────────

describe("AMC-21: MonitorSignupsTable — Slet button opens dialog naming the email", () => {
  it("AMC-21: clicking Slet on newer@example.com opens a dialog with that email", async () => {
    const user = userEvent.setup();
    renderTable();

    // Whitespace-tolerant: Chromium may insert a space before sr-only suffix
    const sletBtn = screen.getByRole("button", {
      name: /^\s*Slet[\s\S]*newer@example\.com/,
    });
    await user.click(sletBtn);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/newer@example\.com/)).toBeInTheDocument();
  });

  it("AMC-21b: the dialog is named by its title and described by its body, the address in bold", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(sletButton("newer@example.com"));

    const dialog = screen.getByRole("dialog", {
      name: "Slet tilmelding?",
      description: "newer@example.com og alle kontoens overvågninger slettes permanent. Det kan ikke fortrydes.",
    });
    expect(within(dialog).getByText("newer@example.com", { selector: "strong" })).toBeInTheDocument();
  });
});

// ── AMC-22: Annuller closes dialog ────────────────────────────────────────────

describe("AMC-22: MonitorSignupsTable — Annuller closes dialog without calling action", () => {
  it("AMC-22: Annuller closes the dialog and deleteMonitorSignup is not called", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: /^\s*Slet[\s\S]*newer@example\.com/ }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Annuller" }));

    expect(mockDeleteMonitorSignup).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { hidden: false })).toBeNull();
  });
});

// ── AMC-23: confirm calls deleteMonitorSignup with userId ────────────────────

describe("AMC-23: MonitorSignupsTable — confirm button calls deleteMonitorSignup(userId)", () => {
  it("AMC-23: clicking 'Slet tilmelding' calls deleteMonitorSignup with the row's userId", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: /^\s*Slet[\s\S]*newer@example\.com/ }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));

    expect(mockDeleteMonitorSignup).toHaveBeenCalledWith("u-newer-uuid");
  });
});

// ── AMC-24: pending state ────────────────────────────────────────────────────

describe("AMC-24: MonitorSignupsTable — confirm button shows 'Sletter…' and is disabled while pending", () => {
  it("AMC-24: while deleteMonitorSignup is in flight, confirm button is 'Sletter…' and disabled", async () => {
    const { promise, resolve: resolveDelete } = Promise.withResolvers<DeleteMonitorUserResult>();
    mockDeleteMonitorSignup.mockReturnValue(promise);

    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: /^\s*Slet[\s\S]*newer@example\.com/ }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));

    // While in flight: button text changes and is disabled
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Sletter\u2026" })).toBeDisabled();
    });

    resolveDelete({ ok: true });

    // Dialog should close after success
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { hidden: false })).toBeNull();
    });
  });

  it("AMC-24b: the dialog's cancel (Escape) is prevented while the delete runs, and is not once it ended", async () => {
    const { promise, resolve: resolveDelete } = Promise.withResolvers<DeleteMonitorUserResult>();
    mockDeleteMonitorSignup.mockReturnValue(promise);
    const user = userEvent.setup();
    renderTable();

    const dialog = await confirmDeleteOf(user, "newer@example.com");
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Sletter\u2026" })).toBeDisabled();
    });

    // On Escape a browser fires a cancelable `cancel` event at the modal dialog; preventing it holds the
    // dialog open, though Chromium closes it on a repeated Escape anyway (AMC-25i). jsdom has no Escape handling.
    const escapeWhilePending = new Event("cancel", { cancelable: true });
    fireEvent(dialog, escapeWhilePending);
    expect(escapeWhilePending.defaultPrevented).toBe(true);
    expect(dialog).toHaveAttribute("open");

    resolveDelete({ ok: false, error: "failed" });
    await within(dialog).findByRole("alert");
    // The alert can commit before the transition ends (flaky under the full suite); "Slet tilmelding" is back once it has.
    await within(dialog).findByRole("button", { name: "Slet tilmelding" });

    const escapeAfterwards = new Event("cancel", { cancelable: true });
    fireEvent(dialog, escapeAfterwards);
    expect(escapeAfterwards.defaultPrevented).toBe(false);
  });
});

// ── AMC-25: failure shows inline alert ───────────────────────────────────────

describe("AMC-25: MonitorSignupsTable — failure shows inline role=alert with Danish message", () => {
  it("AMC-25a: {ok:false, error:'failed'} → 'Tilmeldingen kunne ikke slettes. Prøv igen.'", async () => {
    mockDeleteMonitorSignup.mockResolvedValue({ ok: false, error: "failed" });

    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: /^\s*Slet[\s\S]*newer@example\.com/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Tilmeldingen kunne ikke slettes. Prøv igen.",
      );
    });
  });

  it("AMC-25b: {ok:false, error:'not-found'} → 'Tilmeldingen findes ikke længere.'", async () => {
    mockDeleteMonitorSignup.mockResolvedValue({ ok: false, error: "not-found" });

    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: /^\s*Slet[\s\S]*newer@example\.com/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Tilmeldingen findes ikke længere.",
      );
    });
  });

  it("AMC-25c: {ok:false, error:'not-monitor-user'} → 'Kun Monitor-brugere kan slettes her.'", async () => {
    mockDeleteMonitorSignup.mockResolvedValue({ ok: false, error: "not-monitor-user" });

    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: /^\s*Slet[\s\S]*newer@example\.com/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Kun Monitor-brugere kan slettes her.",
      );
    });
  });

  it("AMC-25d: thrown/rejected action → generic failed alert, row still present", async () => {
    mockDeleteMonitorSignup.mockRejectedValue(new Error("network error"));

    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: /^\s*Slet[\s\S]*newer@example\.com/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Tilmeldingen kunne ikke slettes. Prøv igen.",
      );
    });
    // Row still present in the DOM
    expect(screen.getByRole("rowheader", { name: "newer@example.com" })).toBeInTheDocument();
  });

  it("AMC-25e: a retry removes the alert while it runs and announces a repeated failure with a new alert", async () => {
    mockDeleteMonitorSignup.mockResolvedValueOnce({ ok: false, error: "failed" });
    const user = userEvent.setup();
    renderTable();

    const dialog = await confirmDeleteOf(user, "newer@example.com");
    const firstAlert = await within(dialog).findByRole("alert");
    expect(firstAlert).toHaveTextContent("Tilmeldingen kunne ikke slettes. Prøv igen.");

    const { promise, resolve: resolveRetry } = Promise.withResolvers<DeleteMonitorUserResult>();
    mockDeleteMonitorSignup.mockReturnValueOnce(promise);
    await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Sletter\u2026" })).toBeDisabled();
    });
    expect(within(dialog).queryByRole("alert")).toBeNull();

    resolveRetry({ ok: false, error: "failed" });

    const secondAlert = await within(dialog).findByRole("alert");
    expect(secondAlert).toHaveTextContent("Tilmeldingen kunne ikke slettes. Prøv igen.");
    expect(secondAlert).not.toBe(firstAlert);
  });

  it("AMC-25f: not-found on the last row keeps the dialog and its alert while the list empties; closing it focuses the empty text", async () => {
    mockDeleteMonitorSignup.mockResolvedValue({ ok: false, error: "not-found" });
    const user = userEvent.setup();
    const { rerender } = renderTable([ROWS[0]!], "1 tilmeldt · 0 afventer · 0 udløbne");

    const dialog = await confirmDeleteOf(user, "newer@example.com");
    await within(dialog).findByRole("alert");

    // The action revalidated the list: the signup was already gone.
    rerender(tableUi([], ""));

    expect(screen.getByText("Ingen tilmeldinger endnu.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Tilmeldingen findes ikke længere.");

    await user.click(within(dialog).getByRole("button", { name: "Annuller" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Ingen tilmeldinger endnu.")).toHaveFocus();
  });

  it("AMC-25g: not-found for a row the list dropped before the confirm still moves the focus on close to the Slet button now in its place", async () => {
    mockDeleteMonitorSignup.mockResolvedValue({ ok: false, error: "not-found" });
    const user = userEvent.setup();
    const { rerender } = renderTable();

    await user.click(sletButton("newer@example.com"));
    const dialog = screen.getByRole("dialog");
    // The list refreshed while the dialog was open: the signup is already gone.
    rerender(tableUi(ROWS.slice(1), "0 tilmeldte · 1 afventer · 1 udløbet"));
    await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));
    await within(dialog).findByRole("alert");

    await user.click(within(dialog).getByRole("button", { name: "Annuller" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sletButton("pending@example.com")).toHaveFocus();
  });

  it("AMC-25h: after a not-found with other rows left 'Slet tilmelding' stays disabled with the focus on Annuller, and closing focuses the Slet button now in the row's place", async () => {
    mockDeleteMonitorSignup.mockResolvedValue({ ok: false, error: "not-found" });
    const user = userEvent.setup();
    const { rerender } = renderTable();

    const dialog = await confirmDeleteOf(user, "newer@example.com");
    await within(dialog).findByRole("alert");
    // The action revalidated the list: the signup was already gone.
    rerender(tableUi(ROWS.slice(1), "0 tilmeldte · 1 afventer · 1 udløbet"));

    const confirm = within(dialog).getByRole("button", { name: "Slet tilmelding" });
    const cancel = within(dialog).getByRole("button", { name: "Annuller" });
    expect(confirm).toBeDisabled();
    await waitFor(() => {
      expect(cancel).toHaveFocus();
    });
    await user.click(confirm);
    expect(mockDeleteMonitorSignup).toHaveBeenCalledTimes(1);

    await user.click(cancel);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sletButton("pending@example.com")).toHaveFocus();
  });

  it("AMC-25i: a failure after the browser closed the dialog during the delete opens it again with its alert", async () => {
    const { promise, resolve: resolveDelete } = Promise.withResolvers<DeleteMonitorUserResult>();
    mockDeleteMonitorSignup.mockReturnValue(promise);
    const user = userEvent.setup();
    renderTable();

    const dialog = await confirmDeleteOf(user, "newer@example.com");
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Sletter\u2026" })).toBeDisabled();
    });
    // Chromium closes a modal dialog on a repeated Escape even though its `cancel` event is prevented.
    dialog.closest("dialog")?.close();
    expect(screen.queryByRole("dialog")).toBeNull();

    resolveDelete({ ok: false, error: "failed" });

    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toContainElement(alert);
    expect(alert).toHaveTextContent("Tilmeldingen kunne ikke slettes. Prøv igen.");
    expect(screen.getByRole("rowheader", { name: "newer@example.com" })).toBeInTheDocument();
  });

  it("AMC-25j: after {ok:false, error:'failed'} the focus moves to the enabled 'Slet tilmelding' for a retry", async () => {
    const { promise, resolve: resolveDelete } = Promise.withResolvers<DeleteMonitorUserResult>();
    mockDeleteMonitorSignup.mockReturnValue(promise);
    const user = userEvent.setup();
    renderTable();

    const dialog = await confirmDeleteOf(user, "newer@example.com");
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Sletter\u2026" })).toBeDisabled();
    });
    dropFocusToBody();
    expect(document.body).toHaveFocus();

    resolveDelete({ ok: false, error: "failed" });

    await within(dialog).findByRole("alert");
    const confirm = await within(dialog).findByRole("button", { name: "Slet tilmelding" });
    await waitFor(() => {
      expect(confirm).toHaveFocus();
    });
    expect(confirm).toBeEnabled();
  });

  it("AMC-25k: after {ok:false, error:'not-monitor-user'} the focus moves to Annuller (nothing to retry)", async () => {
    const { promise, resolve: resolveDelete } = Promise.withResolvers<DeleteMonitorUserResult>();
    mockDeleteMonitorSignup.mockReturnValue(promise);
    const user = userEvent.setup();
    renderTable();

    const dialog = await confirmDeleteOf(user, "newer@example.com");
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Sletter\u2026" })).toBeDisabled();
    });
    dropFocusToBody();
    expect(document.body).toHaveFocus();

    resolveDelete({ ok: false, error: "not-monitor-user" });

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Kun Monitor-brugere kan slettes her.");
    const cancel = within(dialog).getByRole("button", { name: "Annuller" });
    await waitFor(() => {
      expect(cancel).toHaveFocus();
    });
    expect(cancel).toBeEnabled();
  });

  it("AMC-25l: a 'failed' after the browser closed the dialog during the delete opens it again with the focus on 'Slet tilmelding'", async () => {
    const { promise, resolve: resolveDelete } = Promise.withResolvers<DeleteMonitorUserResult>();
    mockDeleteMonitorSignup.mockReturnValue(promise);
    const user = userEvent.setup();
    renderTable();

    const dialog = await confirmDeleteOf(user, "newer@example.com");
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Sletter\u2026" })).toBeDisabled();
    });
    // Chromium closes the modal dialog on a repeated Escape and returns the focus to the button that opened it.
    dialog.closest("dialog")?.close();
    sletButton("newer@example.com").focus();

    resolveDelete({ ok: false, error: "failed" });

    await screen.findByRole("alert");
    expect(dialog).toHaveAttribute("open");
    const confirm = await within(dialog).findByRole("button", { name: "Slet tilmelding" });
    await waitFor(() => {
      expect(confirm).toHaveFocus();
    });
    expect(confirm).toBeEnabled();
  });
});

// ── AMC-26: success closes dialog ────────────────────────────────────────────

describe("AMC-26: MonitorSignupsTable — success closes the dialog", () => {
  it("AMC-26: {ok:true} → dialog is no longer open", async () => {
    mockDeleteMonitorSignup.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: /^\s*Slet[\s\S]*newer@example\.com/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Slet tilmelding" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { hidden: false })).toBeNull();
    });
  });

  it("AMC-26b: once the refreshed list drops the row, the focus moves to the Slet button now in its place", async () => {
    const user = userEvent.setup();
    const { rerender } = renderTable();

    await confirmDeleteOf(user, "newer@example.com");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    rerender(tableUi(ROWS.slice(1), "0 tilmeldte · 1 afventer · 1 udløbet"));

    expect(sletButton("pending@example.com")).toHaveFocus();
  });

  it("AMC-26c: deleting the last row shows the empty text and moves the focus to it", async () => {
    const user = userEvent.setup();
    const { rerender } = renderTable([ROWS[2]!], "0 tilmeldte · 0 afventer · 1 udløbet");

    await confirmDeleteOf(user, "older@example.com");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    rerender(tableUi([], ""));

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Ingen tilmeldinger endnu.")).toHaveFocus();
  });

  it("AMC-26d: a success after the browser closed the dialog during the delete leaves it closed, and the refreshed list moves the focus", async () => {
    const { promise, resolve: resolveDelete } = Promise.withResolvers<DeleteMonitorUserResult>();
    mockDeleteMonitorSignup.mockReturnValue(promise);
    const user = userEvent.setup();
    const { rerender } = renderTable();

    const dialog = await confirmDeleteOf(user, "newer@example.com");
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Sletter\u2026" })).toBeDisabled();
    });
    dialog.closest("dialog")?.close();

    resolveDelete({ ok: true });
    await waitFor(() => {
      expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);

    rerender(tableUi(ROWS.slice(1), "0 tilmeldte · 1 afventer · 1 udløbet"));

    expect(sletButton("pending@example.com")).toHaveFocus();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Journey: admin-monitor-users-sites — Overvåger column (AMSS-7, AMSS-8, AMSS-9, AMSS-11)
// ═══════════════════════════════════════════════════════════════════════════════

// Extra fixtures: rows with real monitor data for the new column tests.
const ROW_WITH_MONITORS: RowWithStatus = {
  email: "withmon@example.com",
  userId: "u-withmon",
  signedUpAt: ISO_NEWER,
  confirmed: true,
  monitorCount: 2,
  monitors: [
    { url: "https://alpha.example.com", label: "Alpha",  status: "active" },
    { url: "https://beta.example.com",  label: null,     status: "paused" },
  ],
  status: "registered",
};

const ROW_NO_MONITORS: RowWithStatus = {
  email: "nomon@example.com",
  userId: "u-nomon",
  signedUpAt: ISO_OLDER,
  confirmed: true,
  monitorCount: 0,
  monitors: [],
  status: "registered",
};

// ── AMSS-7: Overvåger column links ────────────────────────────────────────────
// Journey: admin-monitor-users-sites   AC: each monitor rendered as external link

describe("AMSS-7: MonitorSignupsTable — Overvåger column renders each monitor as external link", () => {
  it("AMSS-7a: active monitor with label is rendered as a link with label text", () => {
    renderTable([ROW_WITH_MONITORS]);
    const link = screen.getByRole("link", { name: /Alpha/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://alpha.example.com");
  });

  it("AMSS-7b: active link has target=_blank and rel=noopener noreferrer", () => {
    renderTable([ROW_WITH_MONITORS]);
    const link = screen.getByRole("link", { name: /Alpha/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("AMSS-7c: monitor with label=null uses displayUrl(url) as link text", () => {
    renderTable([ROW_WITH_MONITORS]);
    // displayUrl("https://beta.example.com") = "beta.example.com"
    expect(screen.getByRole("link", { name: /beta\.example\.com/ })).toBeInTheDocument();
  });

  it("AMSS-7d: null-label link href equals the full URL", () => {
    renderTable([ROW_WITH_MONITORS]);
    const link = screen.getByRole("link", { name: /beta\.example\.com/ });
    expect(link).toHaveAttribute("href", "https://beta.example.com");
  });

  it("AMSS-7e: each link's accessible name includes the sr-only newTab string 'åbner i ny fane'", () => {
    renderTable([ROW_WITH_MONITORS]);
    // next-intl labels.newTab = "åbner i ny fane" is rendered sr-only inside the <a>;
    // Testing Library includes hidden text in accessible-name computation.
    expect(screen.getByRole("link", { name: /Alpha.*åbner i ny fane/i })).toBeInTheDocument();
  });
});

// ── AMSS-8: empty monitors shows "Ingen" ─────────────────────────────────────
// Journey: admin-monitor-users-sites   AC: Ingen shown when monitors is []

describe("AMSS-8: MonitorSignupsTable — Overvåger column shows 'Ingen' for a row with no monitors", () => {
  it("AMSS-8: row with monitors=[] shows 'Ingen' and no links in Overvåger cell", () => {
    renderTable([ROW_NO_MONITORS]);
    const row = rowFor("nomon@example.com");
    const cells = within(row).getAllByRole("cell");
    // cells[2] = Overvåger
    expect(cells[2]).toHaveTextContent("Ingen");
    expect(within(cells[2]!).queryAllByRole("link")).toHaveLength(0);
  });
});

// ── AMSS-9: paused monitor marked at item level ───────────────────────────────
// Journey: admin-monitor-users-sites   AC: paused monitor has visible paused indicator;
//   the active monitor does NOT carry the marker.

describe("AMSS-9: MonitorSignupsTable — paused monitor has visible paused indicator on its own list item", () => {
  it("AMSS-9a: paused monitor's list item contains 'sat på pause'", () => {
    renderTable([ROW_WITH_MONITORS]);
    // beta.example.com is the paused monitor; its closest <li> must carry the marker
    const pausedLink = screen.getByRole("link", { name: /beta\.example\.com/ });
    expect(pausedLink.closest("li")).toHaveTextContent("sat på pause");
  });

  it("AMSS-9b: active monitor's list item does NOT contain 'sat på pause'", () => {
    renderTable([ROW_WITH_MONITORS]);
    // Alpha is the active monitor; its <li> must NOT show the paused marker
    const activeLink = screen.getByRole("link", { name: /Alpha/i });
    expect(activeLink.closest("li")).not.toHaveTextContent("sat på pause");
  });
});

// ── AMSS-11: Overvåger cell is cells[2] ──────────────────────────────────────
// Journey: admin-monitor-users-sites   AC: column position between Status and Overvågninger

describe("AMSS-11: MonitorSignupsTable — Overvåger column is at cell index 2 (between Status and Overvågninger)", () => {
  it("AMSS-11: cells[1]=Status badge, cells[2]=Overvåger links, cells[3]=Overvågninger count", () => {
    renderTable([ROW_WITH_MONITORS]);
    const row = rowFor("withmon@example.com");
    const cells = within(row).getAllByRole("cell");
    // Status badge at index 1
    expect(cells[1]).toHaveTextContent("Tilmeldt");
    // Overvåger links at index 2
    expect(within(cells[2]!).getAllByRole("link")).toHaveLength(2);
    // Count at index 3
    expect(cells[3]).toHaveTextContent("2");
  });
});

// ── PAY1-AC6d: has-active-subscription dialog copy ───────────────────────────
// Journey: payments-slice1-foundation  PAY1-AC6d
//
// Pin the exact Danish copy. Admin.monitorUsers.delete.errors.hasActiveSubscription
// maps the 'has-active-subscription' error from the delete dialog.

const DA_HAS_ACTIVE_SUBSCRIPTION =
  "Kontoen har et abonnement, der ikke er ophørt, og kan først slettes, når det er ophørt.";

describe("PAY1-AC6d: MonitorSignupsTable — has-active-subscription error shows DA copy in delete dialog", () => {
  it("PAY1-AC6d: {ok:false, error:'has-active-subscription'} → DA copy in role=alert, focus moves to Annuller", async () => {
    const result: DeleteMonitorUserResult = { ok: false, error: "has-active-subscription" };
    mockDeleteMonitorSignup.mockResolvedValueOnce(result);

    const user = userEvent.setup();
    renderTable();

    const dialog = await confirmDeleteOf(user, "newer@example.com");

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent(DA_HAS_ACTIVE_SUBSCRIPTION);
    });
    // A retry cannot succeed; focus moves to Annuller (mirrors not-monitor-user pattern).
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Annuller" })).toHaveFocus();
    });
  });
});
