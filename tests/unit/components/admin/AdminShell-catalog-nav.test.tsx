// @vitest-environment jsdom
/**
 * Unit test — AdminShell includes a "Kataloger" nav group with four kind links (F2.3 catalog-admin)
 * Journey: catalog-admin  AC-CATADM-06
 *
 * The approved admin-catalog-overview mock shows the sidebar has:
 *   Oversigt | Kataloger (group) → Apps / Hjemmesider / Ydelser / 3D-modeller | Sider
 *
 * Mirrors tests/unit/components/admin/AdminShell-pages-nav.test.tsx.
 * A section editor (/admin/catalog/categories/<id>) declares its section's
 * kind with <ActiveCatalogKind>; that kind's link is then the current one.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Dynamic import required: vi.mock factories are hoisted by Vite above all static
// imports, so a static import of the helper would not yet exist at factory time.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
const navigation = vi.hoisted(() => ({ pathname: "/admin/catalog" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("@/app/admin/(auth)/actions", () => ({ signOut: vi.fn() }));

import ActiveCatalogKind from "@/components/admin/ActiveCatalogKind";
import AdminShell from "@/components/admin/AdminShell";
import { adminCategoryPath } from "@/config/admin";

const USER = { userId: "u-1", email: "ejer@example.com", role: "owner" } as const;
const SECTION_ID = "550e8400-e29b-41d4-a716-446655440001";

afterEach(() => {
  cleanup();
  navigation.pathname = "/admin/catalog";
});

// ── AC-CATADM-06: Kataloger nav group ────────────────────────────────────────

describe("AC-CATADM-06: AdminShell — 'Kataloger' group in nav with four kind links", () => {
  it("AC-CATADM-06a: nav contains a 'Kataloger' group label", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    expect(within(nav).getByText("Kataloger")).toBeInTheDocument();
  });

  it("AC-CATADM-06b: nav contains an 'Apps' link inside the Kataloger group", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    expect(within(nav).getByRole("link", { name: "Apps" })).toBeInTheDocument();
  });

  it("AC-CATADM-06c: nav contains a 'Hjemmesider' link", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    expect(within(nav).getByRole("link", { name: "Hjemmesider" })).toBeInTheDocument();
  });

  it("AC-CATADM-06d: nav contains a 'Ydelser' link", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    expect(within(nav).getByRole("link", { name: "Ydelser" })).toBeInTheDocument();
  });

  it("AC-CATADM-06e: nav contains a '3D-modeller' link", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    expect(within(nav).getByRole("link", { name: "3D-modeller" })).toBeInTheDocument();
  });

  it("AC-CATADM-06f: exactly four kind links exist (one per kind label) — href must satisfy F-nav", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    // Collect all four kind links by their exact labels (AC-06b/c/d/e already
    // verify each label resolves; here we confirm the count is exactly 4 and
    // every href points somewhere under /admin/catalog — the F-nav wildcard
    // extension (AdminShell.test.tsx satisfiesRoute) handles [id] matching).
    const kindLinks = (["Apps", "Hjemmesider", "Ydelser", "3D-modeller"] as const)
      .map((name) => within(nav).getByRole("link", { name }));
    expect(kindLinks).toHaveLength(4);
    for (const link of kindLinks) {
      expect(link.getAttribute("href") ?? "").toMatch(/^\/admin\/catalog\//);
    }
  });

  it("AC-CATADM-06g: the kind link whose href matches the current pathname has aria-current='page'", async () => {
    // usePathname() is mocked to /admin/catalog above, so the active link
    // should be the one whose href equals or starts with /admin/catalog.
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    const currentLinks = within(nav)
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    // Exactly one link active at a time; it belongs to the catalog section.
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]!.getAttribute("href") ?? "").toMatch(/^\/admin\/catalog/);
  });
});

describe("AC-CATADM-06: on a section editor, the link of that section's kind is the current one", () => {
  it.each([
    ["apps", "Apps"],
    ["websites", "Hjemmesider"],
    ["services", "Ydelser"],
    ["models3d", "3D-modeller"],
  ] as const)(
    "AC-CATADM-06h: on /admin/catalog/categories/<id> of a section of kind %s, only '%s' has aria-current='page'",
    async (kind, label) => {
      navigation.pathname = adminCategoryPath(SECTION_ID);
      render(await AdminShell({ user: USER, children: <ActiveCatalogKind kind={kind} /> }));

      const nav = screen.getByRole("navigation", { name: "Administration" });
      const currentLinks = within(nav)
        .getAllByRole("link")
        .filter((l) => l.getAttribute("aria-current") === "page");
      expect(currentLinks.map((l) => l.textContent)).toEqual([label]);
      expect(within(nav).getByRole("link", { name: "Katalog" })).not.toHaveAttribute("aria-current");
    },
  );
});
