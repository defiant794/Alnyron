// @vitest-environment jsdom
/**
 * Unit tests — CatalogOverviewTable component (F2.3 catalog-admin)
 * Journey: catalog-admin
 * Acceptance IDs: AC-CATADM-01, AC-CATADM-02, AC-CATADM-03, AC-CATADM-04, AC-CATADM-05
 *
 * The component renders the four catalog sections as rows in the overview table:
 *   DA title, visibility badge, published/draft counts, Rediger link.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import CatalogOverviewTable from "@/components/admin/CatalogOverviewTable";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_ROWS = [
  {
    id: "cat-apps",
    kind: "apps" as const,
    title: "Apps",
    status: "published" as const,
    publishedCount: 3,
    draftCount: 1,
    editHref: "/admin/catalog/categories/cat-apps",
  },
  {
    id: "cat-websites",
    kind: "websites" as const,
    title: "Hjemmesider",
    status: "published" as const,
    publishedCount: 0,
    draftCount: 2,
    editHref: "/admin/catalog/categories/cat-websites",
  },
  {
    id: "cat-services",
    kind: "services" as const,
    title: "Ydelser",
    status: "published" as const,
    publishedCount: 5,
    draftCount: 0,
    editHref: "/admin/catalog/categories/cat-services",
  },
  {
    id: "cat-models3d",
    kind: "models3d" as const,
    title: "3D-modeller",
    status: "draft" as const,
    publishedCount: 0,
    draftCount: 0,
    editHref: "/admin/catalog/categories/cat-models3d",
  },
];

const LABELS = {
  edit: "Rediger",
  visibility: {
    synlig: "Synlig",
    visesVedForste: "Vises ved første udgivne element",
    skjult: "Skjult",
  },
  counts: {
    published: (n: number) => `${n} udgivet`,
    draft: (n: number) => `${n} kladde`,
  },
};

afterEach(cleanup);

// ── AC-CATADM-01: all four rows are rendered ──────────────────────────────────

describe("AC-CATADM-01: CatalogOverviewTable renders a row for each section", () => {
  it("AC-CATADM-01a: renders four rows", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    // One row per section — check all four titles appear
    expect(screen.getByText("Apps")).toBeInTheDocument();
    expect(screen.getByText("Hjemmesider")).toBeInTheDocument();
    expect(screen.getByText("Ydelser")).toBeInTheDocument();
    expect(screen.getByText("3D-modeller")).toBeInTheDocument();
  });

  it("AC-CATADM-01b: renders published and draft counts for each row", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    expect(screen.getByText("3 udgivet")).toBeInTheDocument();
    expect(screen.getByText("1 kladde")).toBeInTheDocument();
    expect(screen.getByText("5 udgivet")).toBeInTheDocument();
  });
});

// ── AC-CATADM-02: Synlig badge (published + publishedCount >= 1) ───────────────

describe("AC-CATADM-02: visibility badge — Synlig when published with items", () => {
  it("AC-CATADM-02a: Apps row (published, 3 published) shows Synlig badge", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    const appsRow = screen.getByText("Apps").closest("tr") ?? screen.getByText("Apps").parentElement!;
    expect(within(appsRow as HTMLElement).getByText("Synlig")).toBeInTheDocument();
  });

  it("AC-CATADM-02b: Ydelser row (published, 5 published) shows Synlig badge", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    const row = screen.getByText("Ydelser").closest("tr") ?? screen.getByText("Ydelser").parentElement!;
    expect(within(row as HTMLElement).getByText("Synlig")).toBeInTheDocument();
  });
});

// ── AC-CATADM-03: Vises ved første udgivne element (published, 0 published items) ──

describe("AC-CATADM-03: visibility badge — 'Vises ved første udgivne element' when published with 0 published items", () => {
  it("AC-CATADM-03a: Hjemmesider row (published, 0 published, 2 draft) shows 'Vises ved første udgivne element'", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    expect(screen.getByText("Vises ved første udgivne element")).toBeInTheDocument();
  });

  it("AC-CATADM-03b: only one row shows the 'Vises ved første' badge in BASE_ROWS", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    expect(screen.getAllByText("Vises ved første udgivne element")).toHaveLength(1);
  });
});

// ── AC-CATADM-04: Skjult badge (draft category) ──────────────────────────────

describe("AC-CATADM-04: visibility badge — Skjult when category is draft", () => {
  it("AC-CATADM-04a: 3D-modeller row (draft, 0 items) shows Skjult badge", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    const row = screen.getByText("3D-modeller").closest("tr") ?? screen.getByText("3D-modeller").parentElement!;
    expect(within(row as HTMLElement).getByText("Skjult")).toBeInTheDocument();
  });

  it("AC-CATADM-04b: draft category with items also shows Skjult (status wins)", () => {
    const rows = [
      {
        id: "cat-x",
        kind: "apps" as const,
        title: "TestApps",
        status: "draft" as const,
        publishedCount: 5,
        draftCount: 2,
        editHref: "/admin/catalog/categories/cat-x",
      },
    ];
    render(<CatalogOverviewTable rows={rows} labels={LABELS} />);
    expect(screen.getByText("Skjult")).toBeInTheDocument();
    expect(screen.queryByText("Synlig")).not.toBeInTheDocument();
  });
});

// ── AC-CATADM-05: Rediger link ────────────────────────────────────────────────

describe("AC-CATADM-05: each row has a Rediger link pointing to /admin/catalog/categories/[id]", () => {
  it("AC-CATADM-05a: Apps row Rediger links to /admin/catalog/categories/cat-apps", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    const appsRow = screen.getByText("Apps").closest("tr") ?? screen.getByText("Apps").parentElement!;
    const link = within(appsRow as HTMLElement).getByRole("link", { name: "Rediger" });
    expect(link).toHaveAttribute("href", "/admin/catalog/categories/cat-apps");
  });

  it("AC-CATADM-05b: all four rows have a Rediger link", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    expect(screen.getAllByRole("link", { name: "Rediger" })).toHaveLength(4);
  });

  it("AC-CATADM-05c: 3D-modeller row Rediger links to /admin/catalog/categories/cat-models3d", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);
    const row = screen.getByText("3D-modeller").closest("tr") ?? screen.getByText("3D-modeller").parentElement!;
    const link = within(row as HTMLElement).getByRole("link", { name: "Rediger" });
    expect(link).toHaveAttribute("href", "/admin/catalog/categories/cat-models3d");
  });
});

// ── A11Y-12: scroll wrapper is positioned, sr-only contained ─────────────────

describe("A11Y-12: CatalogOverviewTable — scroll wrapper is positioned so sr-only spans are contained within it", () => {
  it("A11Y-12: the overflow-x-auto wrapper has 'relative', every sr-only inside has its nearest positioned ancestor within the wrapper", () => {
    render(<CatalogOverviewTable rows={BASE_ROWS} labels={LABELS} />);

    const wrapper = screen.getByRole("table").parentElement;
    expect(wrapper).toHaveClass("relative", "overflow-x-auto");

    const srOnlySpans = [...(wrapper?.querySelectorAll(".sr-only") ?? [])];
    expect(srOnlySpans.length).toBeGreaterThan(0);

    for (const span of srOnlySpans) {
      const containingBlock = span.parentElement?.closest(".relative, .absolute, .fixed, .sticky") ?? null;
      expect(
        containingBlock !== null && wrapper?.contains(containingBlock),
        `sr-only "${span.textContent?.trim()}" must have its nearest positioned ancestor inside the scroll wrapper`,
      ).toBe(true);
    }
  });
});
