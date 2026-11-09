// @vitest-environment jsdom
/**
 * Unit test — `/admin/pages` ("Sider") builds the PagesTable rows from the
 * system pages (monitor-nav, design review #2 and #5). The page is an async
 * server component: it is awaited and its element rendered with the real
 * Danish messages, so the copy under test is the shipped copy:
 *   - an app area (Monitor) shows a description under its name (with the host
 *     it is served on, derived from NEXT_PUBLIC_SITE_URL), where a content
 *     page shows its Danish title; the area's own (blank) title is never used
 *   - the area's nav switch shows the compact "Vis i menuen" and is named
 *     "Vis i menuen: Monitor", like the row's "Flyt op: Monitor"
 * The table's own behaviour is covered by tests/unit/components/admin/PagesTable-area-row.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { AdminPageSummary } from "@/services/admin/pages";
import da from "../../../../messages/da.json";

const { mockListSystemPages } = vi.hoisted(() => ({ mockListSystemPages: vi.fn<() => Promise<AdminPageSummary[]>>() }));

// vi.mock is hoisted above the imports, so the shared factory is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/services/auth/require-admin", () => ({
  requireAdmin: vi.fn(async () => ({ userId: "u-1", email: "ejer@example.com", role: "owner" })),
}));
vi.mock("@/services/admin/pages", () => ({ listSystemPages: mockListSystemPages }));
vi.mock("@/app/admin/(panel)/pages/actions", () => ({ reorderNav: vi.fn(), setPageNav: vi.fn() }));
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/env")>()),
  parseSiteEnv: () => ({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk" }),
}));

import AdminPagesPage from "@/app/admin/(panel)/pages/page";

const PAGES: AdminPageSummary[] = [
  { id: "home-id", systemKey: "home", status: "published", showInNav: true, title: "Velkommen" },
  { id: "contact-id", systemKey: "contact", status: "published", showInNav: true, title: "Skriv til os" },
  { id: "monitor-id", systemKey: "monitor", status: "published", showInNav: false, title: "" },
];

/** The table row whose row header starts with the page's fixed name. */
function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) =>
      within(candidate).queryByRole("rowheader", { name: (accessibleName) => accessibleName.startsWith(name) }),
    );
  if (!row) throw new Error(`no table row for "${name}"`);
  return row;
}

afterEach(cleanup);

describe("AC-MONNAV-1o: /admin/pages labels the Monitor row", () => {
  it("AC-MONNAV-1o: the Monitor row shows the area description (the Monitor host filled in), a content row its title", async () => {
    mockListSystemPages.mockResolvedValue(PAGES);
    render(await AdminPagesPage());

    // The shipped copy, pinned literally (the host derived from NEXT_PUBLIC_SITE_URL=https://alnyron.dk).
    const description = "Appområde på monitor.alnyron.dk, uden tekst at redigere";
    const monitorHeader = within(rowOf(da.Nav.monitor)).getByRole("rowheader");
    expect(within(monitorHeader).getByText(description)).toBeInTheDocument();

    const contactHeader = within(rowOf(da.Nav.contact)).getByRole("rowheader");
    expect(within(contactHeader).getByText("Skriv til os")).toBeInTheDocument();
    expect(within(contactHeader).queryByText(description)).toBeNull();
  });

  it("AC-MONNAV-1o-switch: the Monitor switch is labelled by Admin.pages.menu.toggle and named with the row name", async () => {
    mockListSystemPages.mockResolvedValue(PAGES);
    render(await AdminPagesPage());

    const toggle = within(rowOf(da.Nav.monitor)).getByRole("switch");
    expect(toggle).toHaveAccessibleName(`${da.Admin.pages.menu.toggle}: ${da.Nav.monitor}`);
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });
});
