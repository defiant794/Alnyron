// @vitest-environment jsdom
/**
 * Unit tests — PagesTable area row (monitor-nav Slice B)
 * Journey: monitor-nav  AC-MONNAV-1
 *
 * An area row (kind="area", the Monitor app area) in PagesTable:
 *   - Renders an accessible nav switch (role="switch", checked state): visible label
 *     `labels.toggle` ("Vis i menuen"), accessible name "Vis i menuen: Monitor" (sr-only suffix)
 *   - Shows the area's description under its name, where a content row shows its title
 *   - Clicking the switch calls the setPageNav prop with (id, !current)
 *   - Shows the new state while the save runs (switch aria-disabled, label dimmed, focus kept),
 *     ignores clicks until it ends
 *   - A failed save, or a request that never answers, shows the error alert and the switch
 *     returns to the row's value; a dropped move shows the alert too
 *   - A redirect from the action (expired session) still reaches the router
 *   - No Rediger link on an area row
 *   - Flyt op/ned (move up/down) buttons still work on an area row
 *   - Content rows (kind="content") still render a Rediger link (unchanged)
 *
 * PagesTable is a "use client" component; no next-intl server mock needed.
 * reorder and setPageNav are passed as props, so they are mocked inline.
 */

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { redirect } from "next/navigation";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import PagesTable, { type PagesTableProps, type PagesTableRow } from "@/components/admin/PagesTable";
import type { PageActionResult } from "@/services/admin/pages";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

// ── Fixtures ───────────────────────────────────────────────────────────────────

const AREA_DESCRIPTION = "Appområde på /monitor, uden tekst at redigere";

const AREA_ROW: PagesTableRow = {
  id: "monitor-uuid",
  name: "Monitor",
  status: "published",
  showInNav: false,
  pinned: false,
  kind: "area",
  description: AREA_DESCRIPTION,
};

const AREA_ROW_NAV_ON: PagesTableRow = {
  ...AREA_ROW,
  showInNav: true,
};

const CONTACT_TITLE = "Kontakt side";
const CONTACT_EDIT_HREF = "/admin/pages/contact-uuid";

const CONTENT_ROW: PagesTableRow = {
  id: "contact-uuid",
  name: "Kontakt",
  title: CONTACT_TITLE,
  status: "published",
  showInNav: true,
  pinned: false,
  kind: "content",
  editHref: CONTACT_EDIT_HREF,
};

const HOME_ROW: PagesTableRow = {
  id: "home-uuid",
  name: "Forside",
  title: "Forside tekst",
  status: "published",
  showInNav: true,
  pinned: true,
  kind: "content",
  editHref: "/admin/pages/home-uuid",
};

const LABELS: PagesTableProps["labels"] = {
  page: "Side",
  status: "Status",
  actions: "Handlinger",
  statuses: { published: "Offentlig", draft: "Kladde" },
  shown: "Vises i menuen",
  hidden: "Ikke i menuen",
  toggle: "Vis i menuen",
  edit: "Rediger",
  moveUp: "Flyt op",
  moveDown: "Flyt ned",
  errors: {
    invalid: "Ugyldig",
    "da-title-required": "DA titel krævet",
    "slug-taken": "Adresse i brug",
    "system-slug": "Fast adresse",
    "missing-slugs": "Mangler adresse",
    "system-always-published": "Altid offentlig",
    "not-found": "Ikke fundet",
    forbidden: "Ingen adgang",
    failed: "Fejl",
  },
};

/** Accessible name of the Monitor row's switch: the visible label plus the sr-only ": Monitor" (jsdom joins them without a space). */
const TOGGLE_NAME = `${LABELS.toggle}: ${AREA_ROW.name}`;

/** What `fetch` rejects with when the request is aborted or the network drops. */
const NETWORK_ERROR = new TypeError("Failed to fetch");

const mockReorder = vi.fn<PagesTableProps["reorder"]>().mockResolvedValue({ ok: true });
const mockSetPageNav = vi.fn<PagesTableProps["setPageNav"]>().mockResolvedValue({ ok: true });

function renderTable(
  rows: PagesTableRow[],
  setPageNav: PagesTableProps["setPageNav"] = mockSetPageNav,
  reorder: PagesTableProps["reorder"] = mockReorder,
) {
  return render(
    <PagesTable rows={rows} labelledBy="heading" reorder={reorder} setPageNav={setPageNav} labels={LABELS} />,
  );
}

/**
 * The table row whose row header starts with the page's fixed `name` (the header's
 * accessible name goes on with the page's title and status).
 */
function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) =>
      within(candidate).queryByRole("rowheader", { name: (accessibleName) => accessibleName.startsWith(name) }),
    );
  if (!row) throw new Error(`no table row for "${name}"`);
  return row;
}

/** The element's text as a sighted reader sees it: `.sr-only` content left out, whitespace collapsed. */
function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The `<label>` that wraps the switch (its visible label and pending style). */
function labelOf(toggle: HTMLElement): HTMLLabelElement {
  const label = toggle.closest("label");
  if (!label) throw new Error("the switch is not wrapped in a <label>");
  return label;
}

/** The error a Server Action rejects with when it calls `redirect()` (an expired session sent to the login page). */
function redirectError(): unknown {
  try {
    redirect("/admin/login");
  } catch (error) {
    return error;
  }
}

/** Error boundary standing in for Next's: reports what reached it and renders nothing after. */
class CatchBoundary extends Component<{ onError: (error: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ── AC-MONNAV-1a: area row renders a switch ────────────────────────────────────

describe("AC-MONNAV-1a: PagesTable area row — renders an accessible switch (role='switch')", () => {
  it("AC-MONNAV-1a: area row renders exactly one switch, named by labels.toggle plus the row name", () => {
    renderTable([AREA_ROW]);
    // Exactly one switch — guards against jsdom seeing the status cell rendered twice.
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(1);
    // Name must be the label followed by the row name, like "Rediger" / "Flyt op" on the same row.
    expect(switches[0]).toHaveAccessibleName(TOGGLE_NAME);
  });

  it("AC-MONNAV-1a-visible: the visible switch label is the compact labels.toggle; the row name is sr-only", () => {
    renderTable([AREA_ROW]);
    const label = labelOf(screen.getByRole("switch", { name: TOGGLE_NAME }));
    expect(visibleText(label)).toBe(LABELS.toggle);
    expect(label.querySelector(".sr-only")).toHaveTextContent(`: ${AREA_ROW.name}`);
  });
});

// ── AC-MONNAV-1n: area description under the name ──────────────────────────────

describe("AC-MONNAV-1n: PagesTable rows — the line under the name", () => {
  it("AC-MONNAV-1n: an area row shows its description under its name, a content row its title", () => {
    renderTable([CONTENT_ROW, AREA_ROW]);
    const monitorHeader = within(rowOf("Monitor")).getByRole("rowheader");
    expect(within(monitorHeader).getByText(AREA_DESCRIPTION)).toBeInTheDocument();
    const contactHeader = within(rowOf("Kontakt")).getByRole("rowheader");
    expect(within(contactHeader).getByText(CONTACT_TITLE)).toBeInTheDocument();
    expect(within(contactHeader).queryByText(AREA_DESCRIPTION)).toBeNull();
  });
});

// ── AC-MONNAV-1b/c: checked state reflects showInNav ──────────────────────────

describe("AC-MONNAV-1b/c: PagesTable area row — aria-checked reflects showInNav state", () => {
  it("AC-MONNAV-1b: showInNav=false → switch is not checked (aria-checked='false')", () => {
    renderTable([AREA_ROW]);
    expect(screen.getByRole("switch", { name: TOGGLE_NAME })).not.toBeChecked();
  });

  it("AC-MONNAV-1c: showInNav=true → switch is checked (aria-checked='true')", () => {
    renderTable([AREA_ROW_NAV_ON]);
    expect(screen.getByRole("switch", { name: TOGGLE_NAME })).toBeChecked();
  });
});

// ── AC-MONNAV-1d/e: clicking the switch calls setPageNav ──────────────────────

describe("AC-MONNAV-1d/e: PagesTable area row — clicking switch calls setPageNav", () => {
  it("AC-MONNAV-1d: click when showInNav=false → setPageNav(id, true)", async () => {
    const user = userEvent.setup();
    renderTable([AREA_ROW]);
    await user.click(screen.getByRole("switch", { name: TOGGLE_NAME }));
    expect(mockSetPageNav).toHaveBeenCalledExactlyOnceWith(AREA_ROW.id, true);
  });

  it("AC-MONNAV-1e: click when showInNav=true → setPageNav(id, false)", async () => {
    const user = userEvent.setup();
    renderTable([AREA_ROW_NAV_ON]);
    await user.click(screen.getByRole("switch", { name: TOGGLE_NAME }));
    expect(mockSetPageNav).toHaveBeenCalledExactlyOnceWith(AREA_ROW_NAV_ON.id, false);
  });
});

// ── AC-MONNAV-1i/j/k/l/m: saving, failed saves and dropped requests ──────────

describe("AC-MONNAV-1i/j/k/l/m: PagesTable area row — switch state while saving and after a failure", () => {
  it("AC-MONNAV-1i: while setPageNav runs the switch shows the new state, is marked busy (aria-disabled, dimmed label, focus kept), the table is busy and a second click is ignored", async () => {
    const user = userEvent.setup();
    const save = Promise.withResolvers<PageActionResult>();
    // React entangles every transition with a pending async action, even in another root: if an
    // assertion fails before the save ends, settle it anyway so the next test's switch is not stuck.
    onTestFinished(() => save.resolve({ ok: true }));
    const setPageNav = vi.fn<PagesTableProps["setPageNav"]>().mockReturnValue(save.promise);
    const { rerender } = renderTable([AREA_ROW], setPageNav);
    const toggle = screen.getByRole("switch", { name: TOGGLE_NAME });
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(labelOf(toggle)).toHaveClass("cursor-pointer");

    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    // Busy, not disabled: the switch keeps the keyboard focus while it saves.
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveFocus();
    expect(labelOf(toggle)).toHaveClass("cursor-wait", "opacity-60");
    expect(labelOf(toggle)).not.toHaveClass("cursor-pointer");

    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(setPageNav).toHaveBeenCalledExactlyOnceWith(AREA_ROW.id, true);

    // The saved list arrives with the new value, then the save ends: the row's own value takes over.
    rerender(
      <PagesTable
        rows={[AREA_ROW_NAV_ON]}
        labelledBy="heading"
        reorder={mockReorder}
        setPageNav={setPageNav}
        labels={LABELS}
      />,
    );
    await act(async () => {
      save.resolve({ ok: true });
    });
    await waitFor(() => expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy"));
    expect(toggle).toBeChecked();
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(labelOf(toggle)).not.toHaveClass("cursor-wait", "opacity-60");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("AC-MONNAV-1j: a failed setPageNav shows the error alert and the switch returns to the row's value", async () => {
    const user = userEvent.setup();
    const setPageNav = vi
      .fn<PagesTableProps["setPageNav"]>()
      .mockResolvedValue({ ok: false, error: "forbidden" });
    renderTable([AREA_ROW], setPageNav);
    const toggle = screen.getByRole("switch", { name: TOGGLE_NAME });

    await user.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent(LABELS.errors.forbidden);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy");
    expect(setPageNav).toHaveBeenCalledExactlyOnceWith(AREA_ROW.id, true);
  });

  it("AC-MONNAV-1k: a setPageNav request that never answers (rejects) shows the failed alert in the table, not an error boundary, and the switch returns to the row's value", async () => {
    const user = userEvent.setup();
    const onError = vi.fn<(error: unknown) => void>();
    const setPageNav = vi.fn<PagesTableProps["setPageNav"]>().mockRejectedValue(NETWORK_ERROR);
    render(
      <CatchBoundary onError={onError}>
        <PagesTable rows={[AREA_ROW]} labelledBy="heading" reorder={mockReorder} setPageNav={setPageNav} labels={LABELS} />
      </CatchBoundary>,
    );
    const toggle = screen.getByRole("switch", { name: TOGGLE_NAME });

    await user.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent(LABELS.errors.failed);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy");
    expect(onError).not.toHaveBeenCalled();
    expect(setPageNav).toHaveBeenCalledExactlyOnceWith(AREA_ROW.id, true);
  });

  it("AC-MONNAV-1l: a reorder request that never answers (rejects) shows the failed alert in the table, not an error boundary, and does not move the focus later", async () => {
    const user = userEvent.setup();
    const onError = vi.fn<(error: unknown) => void>();
    const reorder = vi.fn<PagesTableProps["reorder"]>().mockRejectedValue(NETWORK_ERROR);
    const rows = [HOME_ROW, CONTENT_ROW, AREA_ROW];
    const table = (current: PagesTableRow[]) => (
      <CatchBoundary onError={onError}>
        <PagesTable rows={current} labelledBy="heading" reorder={reorder} setPageNav={mockSetPageNav} labels={LABELS} />
      </CatchBoundary>
    );
    const { rerender } = render(table(rows));

    await user.click(within(rowOf("Monitor")).getByRole("button", { name: `${LABELS.moveUp}: ${AREA_ROW.name}` }));

    expect(await screen.findByRole("alert")).toHaveTextContent(LABELS.errors.failed);
    await waitFor(() => expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy"));
    expect(onError).not.toHaveBeenCalled();
    expect(reorder).toHaveBeenCalledExactlyOnceWith([AREA_ROW.id, CONTENT_ROW.id]);

    // The failed move is forgotten: a later refresh of the list leaves the focus where the user put it.
    const editLink = within(rowOf("Kontakt")).getByRole("link", { name: /Rediger/ });
    act(() => editLink.focus());
    rerender(table([...rows]));
    expect(editLink).toHaveFocus();
  });

  it("AC-MONNAV-1m: a redirect from setPageNav (expired session) is rethrown for the router, not shown as a failed save", async () => {
    // React reports the error the boundary caught on console.error.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => consoleError.mockRestore());
    const user = userEvent.setup();
    const onError = vi.fn<(error: unknown) => void>();
    const redirecting = redirectError();
    const setPageNav = vi.fn<PagesTableProps["setPageNav"]>().mockRejectedValue(redirecting);
    render(
      <CatchBoundary onError={onError}>
        <PagesTable rows={[AREA_ROW]} labelledBy="heading" reorder={mockReorder} setPageNav={setPageNav} labels={LABELS} />
      </CatchBoundary>,
    );

    await user.click(screen.getByRole("switch", { name: TOGGLE_NAME }));

    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(redirecting));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ── AC-MONNAV-1f: no Rediger link on area row ─────────────────────────────────

describe("AC-MONNAV-1f: PagesTable area row — no Rediger link", () => {
  it("AC-MONNAV-1f: area row does not render a 'Rediger' link", () => {
    renderTable([AREA_ROW]);
    expect(within(rowOf("Monitor")).queryByRole("link", { name: /Rediger/i })).toBeNull();
  });
});

// ── AC-MONNAV-1g: Flyt op/ned on area row ────────────────────────────────────

describe("AC-MONNAV-1g: PagesTable area row — Flyt op/ned buttons present", () => {
  it("AC-MONNAV-1g: the last movable row (Monitor) has 'Flyt op' enabled, 'Flyt ned' disabled, and Flyt op reorders it", async () => {
    const user = userEvent.setup();
    renderTable([HOME_ROW, CONTENT_ROW, AREA_ROW]);
    const monitorRow = within(rowOf("Monitor"));
    const up = monitorRow.getByRole("button", { name: "Flyt op: Monitor" });

    expect(up).toBeEnabled();
    expect(monitorRow.getByRole("button", { name: "Flyt ned: Monitor" })).toBeDisabled();

    await user.click(up);
    expect(mockReorder).toHaveBeenCalledExactlyOnceWith([AREA_ROW.id, CONTENT_ROW.id]);
  });
});

// ── AC-MONNAV-1h: content rows still have Rediger links (unchanged) ────────────

describe("AC-MONNAV-1h: PagesTable content rows — Rediger link unchanged by area feature", () => {
  it("AC-MONNAV-1h: content row (Kontakt) renders a Rediger link pointing to editHref", () => {
    renderTable([CONTENT_ROW, AREA_ROW]);
    const editLink = within(rowOf("Kontakt")).getByRole("link", { name: /Rediger/i });
    expect(editLink).toHaveAttribute("href", CONTACT_EDIT_HREF);
  });

  it("AC-MONNAV-1h-no-switch: content row does not render a switch", () => {
    renderTable([CONTENT_ROW]);
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
