// @vitest-environment jsdom
/**
 * Unit tests — MonitorSignupsTable component (admin-monitor-users)
 * Journey: admin-monitor-users  AC-AMU-03, AC-AMU-04, AC-AMU-05, AC-AMU-06,
 *          AC-AMU-07, AC-AMU-08, AC-AMU-09, AC-AMU-11, AC-AMU-13
 *
 * Cell index note: within(row).getAllByRole("cell") returns only <td> nodes,
 * not the email <th scope="row"> (role=rowheader). Indexes are therefore:
 *   cells[0] = Tilmeldt, cells[1] = Bekræftet, cells[2] = Overvågninger.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import MonitorSignupsTable from "@/components/admin/MonitorSignupsTable";
import type { MonitorSignup } from "@/services/admin/monitor-users";
import { formatDateTime } from "@/lib/monitor/format";

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISO_NEWER = "2026-10-15T09:00:00.000Z";
const ISO_OLDER = "2026-09-01T14:30:00.000Z";

/** Pinned from running the production formatter: formatDateTime(ISO_NEWER). */
const FORMATTED_NEWER = "15. okt. 2026, 11.00";

const LABELS = {
  email: "E-mail",
  signedUp: "Tilmeldt",
  confirmed: "Bekræftet",
  monitors: "Overvågninger",
  yes: "Ja",
  no: "Nej",
  empty: "Ingen tilmeldinger endnu.",
};

const ROWS: MonitorSignup[] = [
  { email: "newer@example.com", signedUpAt: ISO_NEWER, confirmed: true, monitorCount: 2 },
  { email: "older@example.com", signedUpAt: ISO_OLDER, confirmed: false, monitorCount: 0 },
];

function renderTable(rows: MonitorSignup[], labelledBy = "test-heading") {
  return render(
    <MonitorSignupsTable rows={rows} labelledBy={labelledBy} labels={LABELS} />,
  );
}

/** Row element for a given email (finds via row header). */
function rowFor(email: string): HTMLElement {
  const th = screen.getByRole("rowheader", { name: email });
  const tr = th.closest("tr");
  if (!tr) throw new Error(`No <tr> ancestor for rowheader "${email}"`);
  return tr;
}

// ── AC-AMU-03: column headers in order ───────────────────────────────────────

describe("AC-AMU-03: MonitorSignupsTable — four column headers in order", () => {
  it("AC-AMU-03: renders exactly 4 column headers in order: E-mail, Tilmeldt, Bekræftet, Overvågninger", () => {
    renderTable(ROWS);

    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(4);
    expect(headers[0]).toHaveTextContent("E-mail");
    expect(headers[1]).toHaveTextContent("Tilmeldt");
    expect(headers[2]).toHaveTextContent("Bekræftet");
    expect(headers[3]).toHaveTextContent("Overvågninger");
  });
});

// ── AC-AMU-04: email is a row header ─────────────────────────────────────────

describe("AC-AMU-04: MonitorSignupsTable — email cell is a row header", () => {
  it("AC-AMU-04a: newer@example.com is rendered as a rowheader", () => {
    renderTable(ROWS);

    expect(screen.getByRole("rowheader", { name: "newer@example.com" })).toBeInTheDocument();
  });

  it("AC-AMU-04b: older@example.com is rendered as a rowheader", () => {
    renderTable(ROWS);

    expect(screen.getByRole("rowheader", { name: "older@example.com" })).toBeInTheDocument();
  });
});

// ── AC-AMU-05: date formatting ────────────────────────────────────────────────

describe("AC-AMU-05: MonitorSignupsTable — Tilmeldt cell shows Danish formatted date", () => {
  it("AC-AMU-05a: newer row Tilmeldt cell contains formatDateTime(ISO_NEWER)", () => {
    renderTable(ROWS);

    const newerRow = rowFor("newer@example.com");
    const tilmeldtCell = within(newerRow).getAllByRole("cell")[0]!;
    expect(tilmeldtCell).toHaveTextContent(formatDateTime(ISO_NEWER));
  });

  it("AC-AMU-05b: pinned literal — ISO_NEWER formats to '15. okt. 2026, 11.00'", () => {
    renderTable(ROWS);

    const newerRow = rowFor("newer@example.com");
    const tilmeldtCell = within(newerRow).getAllByRole("cell")[0]!;
    expect(tilmeldtCell.textContent?.trim()).toBe(FORMATTED_NEWER);
  });

  it("AC-AMU-05c: older row Tilmeldt cell contains formatDateTime(ISO_OLDER)", () => {
    renderTable(ROWS);

    const olderRow = rowFor("older@example.com");
    const tilmeldtCell = within(olderRow).getAllByRole("cell")[0]!;
    expect(tilmeldtCell).toHaveTextContent(formatDateTime(ISO_OLDER));
  });
});

// ── AC-AMU-06: confirmed badge ────────────────────────────────────────────────

describe("AC-AMU-06: MonitorSignupsTable — confirmed user shows '✓ Ja' badge", () => {
  it("AC-AMU-06: confirmed=true renders aria-hidden glyph '✓' and text 'Ja' in Bekræftet cell", () => {
    renderTable(ROWS);

    // cells[1] = Bekræftet (cells[0] = Tilmeldt, cells[2] = Overvågninger)
    const bekraeftetCell = within(rowFor("newer@example.com")).getAllByRole("cell")[1]!;
    const glyph = within(bekraeftetCell).getByText("✓");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(bekraeftetCell).toHaveTextContent("Ja");
  });
});

// ── AC-AMU-07: unconfirmed badge ─────────────────────────────────────────────

describe("AC-AMU-07: MonitorSignupsTable — unconfirmed user shows '✗ Nej' badge", () => {
  it("AC-AMU-07: confirmed=false renders aria-hidden glyph '✗' and text 'Nej' in Bekræftet cell", () => {
    renderTable(ROWS);

    // cells[1] = Bekræftet
    const bekraeftetCell = within(rowFor("older@example.com")).getAllByRole("cell")[1]!;
    const glyph = within(bekraeftetCell).getByText("✗");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(bekraeftetCell).toHaveTextContent("Nej");
  });
});

// ── AC-AMU-08: monitor count 0 ───────────────────────────────────────────────

describe("AC-AMU-08: MonitorSignupsTable — zero monitor count renders '0'", () => {
  it("AC-AMU-08: monitorCount=0 renders exactly '0' in the Overvågninger cell", () => {
    renderTable(ROWS);

    // cells[2] = Overvågninger
    const countCell = within(rowFor("older@example.com")).getAllByRole("cell")[2]!;
    expect(countCell.textContent?.trim()).toBe("0");
  });
});

// ── AC-AMU-09: monitor count >0 ──────────────────────────────────────────────

describe("AC-AMU-09: MonitorSignupsTable — non-zero monitor count renders correctly", () => {
  it("AC-AMU-09: monitorCount=2 renders exactly '2' in the Overvågninger cell", () => {
    renderTable(ROWS);

    // cells[2] = Overvågninger
    const countCell = within(rowFor("newer@example.com")).getAllByRole("cell")[2]!;
    expect(countCell.textContent?.trim()).toBe("2");
  });
});

// ── AC-AMU-11: empty state ────────────────────────────────────────────────────

describe("AC-AMU-11: MonitorSignupsTable — empty state renders <p> and no table", () => {
  it("AC-AMU-11a: renders a <p> element with 'Ingen tilmeldinger endnu.' when rows is empty", () => {
    renderTable([]);

    const el = screen.getByText("Ingen tilmeldinger endnu.");
    expect(el.tagName).toBe("P");
  });

  it("AC-AMU-11b: does not render a <table> when rows is empty", () => {
    renderTable([]);

    expect(screen.queryByRole("table")).toBeNull();
  });
});

// ── AC-AMU-13: table labelled by its heading ──────────────────────────────────

describe("AC-AMU-13: MonitorSignupsTable — table is labelled by labelledBy prop", () => {
  it("AC-AMU-13a: the <table> has aria-labelledby matching the labelledBy prop", () => {
    renderTable(ROWS, "monitor-users-heading");

    expect(screen.getByRole("table")).toHaveAttribute("aria-labelledby", "monitor-users-heading");
  });

  it("AC-AMU-13b: table accessible name resolves when an h2 with that id is present", () => {
    const { container } = render(
      <div>
        <h2 id="mu-heading">Tilmeldinger</h2>
        <MonitorSignupsTable rows={ROWS} labelledBy="mu-heading" labels={LABELS} />
      </div>,
    );

    const table = container.querySelector('[aria-labelledby="mu-heading"]');
    expect(table).not.toBeNull();
    expect(screen.getByRole("table", { name: "Tilmeldinger" })).toBeInTheDocument();
  });
});
