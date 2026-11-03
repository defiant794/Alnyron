/**
 * E2E tests — public catalog pages (F2.2 catalog-public)
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-01, AC-CATPUB-02, AC-CATPUB-03,
 *                 AC-CATPUB-10, AC-CATPUB-11,
 *                 AC-CATPUB-20, AC-CATPUB-21,
 *                 AC-CATPUB-30, AC-CATPUB-31
 *
 * Runs against the ISOLATED e2e Supabase project (giokcppmmzrrknmllfjc).
 *
 * Setup: create git-ignored tests/.env.e2e-project with the keys listed in
 * tests/helpers/e2e-project-env.ts (SUPABASE_E2E_REF, SUPABASE_E2E_DB_HOST,
 * SUPABASE_E2E_DB_PASSWORD, NEXT_PUBLIC_SUPABASE_URL, etc.). playwright.config.ts
 * applies it via e2eProjectEnv(), which validates the ref, throws on a missing
 * key or mismatch, and replaces or removes every Supabase key the shell held
 * (the production SUPABASE_DB_PASSWORD included). The shared db.ts pool then
 * routes to the e2e project. Start the app against the same project:
 * `npm run dev:e2e`. See User Setup U2.1.
 *
 * Guard: the outer describe has a describe-level test.skip that checks
 * SUPABASE_E2E_REF === "giokcppmmzrrknmllfjc". Describe-level skip also
 * prevents afterAll hooks from running, so no DB call reaches prod when
 * tests/.env.e2e-project is absent.
 *
 * Prerequisites:
 *   - Dev server at PLAYWRIGHT_BASE_URL (default http://localhost:3000) or
 *     `npm run dev:e2e` to point it at the e2e project
 *   - tests/.env.e2e-project with SUPABASE_E2E_REF + DB credentials
 *   - Optional: E2E_REVALIDATE_SECRET for production-build ISR cache busting
 */

import { test, expect } from "@playwright/test";
import { endPool } from "../integration/rls/helpers/db";
import {
  addCatalogTestItem,
  removeCatalogTestItems,
  hasRealPublicCatalogItem,
  setCategoryStatus,
  snapshotCategoryStatuses,
  restoreCategoryStatuses,
  type CategoryStatusSnapshot,
} from "./fixtures/db-state";
import { revalidateSite } from "./fixtures/revalidate";

/**
 * hreflang alternates of the sitemap `<url>` whose `<loc>` has `pathname`, as
 * hreflang to href pathname; `undefined` when no entry has that path. Only that
 * entry's block is read, so another entry's links cannot satisfy a check, and
 * `new URL(href)` has no base, so a relative href fails the test.
 */
function sitemapAlternates(xml: string, pathname: string): Record<string, string> | undefined {
  for (const [block] of xml.matchAll(/<url>[\s\S]*?<\/url>/g)) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
    if (!loc || new URL(loc).pathname !== pathname) continue;
    const alternates: Record<string, string> = {};
    for (const [, hreflang, href] of block.matchAll(
      /<xhtml:link\b[^>]*?\bhreflang="([^"]+)"[^>]*?\bhref="([^"]+)"/g,
    )) {
      if (hreflang && href) alternates[hreflang] = new URL(href).pathname;
    }
    return alternates;
  }
  return undefined;
}

// ── Pool cleanup ──────────────────────────────────────────────────────────────

test.afterAll(async () => {
  await endPool();
});

// ─────────────────────────────────────────────────────────────────────────────
// Serial: shared DB + ISR cache. Each describe manages its fixture rows.
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Catalog public pages (DB fixture, serial)", () => {
  test.describe.configure({ mode: "serial" });

  // Describe-level skip: also prevents afterAll hooks from running, so
  // removeCatalogTestItems() never connects to prod when the e2e project
  // isn't configured. A beforeAll-level skip would still run afterAll.
  test.skip(
    process.env.SUPABASE_E2E_REF !== "giokcppmmzrrknmllfjc",
    "catalog-public E2E requires tests/.env.e2e-project (SUPABASE_E2E_REF=giokcppmmzrrknmllfjc) — " +
      "without it DB fixtures target production. See User Setup U2.1.",
  );

  test.beforeAll(async () => {
    // Sweep any rows left by an aborted earlier run.
    await removeCatalogTestItems();
    await revalidateSite();
  });

  test.afterAll(async () => {
    await removeCatalogTestItems();
    await revalidateSite();
  });

  // ── AC-CATPUB-01: empty section (no published items) → 404 ────────────────
  //
  // Presence anchor = home h1 visible (proves app is up).

  test.describe("AC-CATPUB-01: empty section → 404 + absent from nav", () => {
    test("presence anchor: GET / renders h1", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("h1")).toBeVisible();
    });

    test("GET /ydelser returns 404 when services has no published items", async ({
      page,
    }) => {
      test.skip(
        await hasRealPublicCatalogItem("services"),
        "Real published services content exists; section is legitimately visible",
      );
      const response = await page.goto("/ydelser");
      expect(response?.status()).toBe(404);
    });

    test("GET /en/services returns 404 when services has no published items", async ({
      page,
    }) => {
      test.skip(
        await hasRealPublicCatalogItem("services"),
        "Real published services content exists",
      );
      const response = await page.goto("/en/services");
      expect(response?.status()).toBe(404);
    });

    test("empty section absent from main nav", async ({ page }) => {
      test.skip(
        await hasRealPublicCatalogItem("services"),
        "Real published services content exists; category is legitimately in nav",
      );
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: /navigat/i });
      await expect(nav.getByRole("link", { name: /Forside/i })).toBeVisible(); // presence
      await expect(nav.getByRole("link", { name: /Ydelser/i })).toHaveCount(0);
    });
  });

  // ── AC-CATPUB-01/03/10: published item → section + item detail render ──────

  test.describe("AC-CATPUB-01/10: published item appears on section index and item detail", () => {
    test.beforeAll(async () => {
      await addCatalogTestItem("services", "published", {
        daSlug: "e2e-cat-webudvikling",
        daTitle: "E2E Webudvikling",
        daSummary: "Moderne, hurtige sites i Next.js.",
        enSlug: "e2e-cat-web-development",
        enTitle: "E2E Web Development",
        enSummary: "", // blank → DA fallback on EN page
        priceType: "from",
        priceAmount: 12000,
        featured: false,
      });
      await revalidateSite();
    });

    test.afterAll(async () => {
      await removeCatalogTestItems();
      await revalidateSite();
    });

    test("AC-CATPUB-01: /ydelser shows the published item card", async ({ page }) => {
      await page.goto("/ydelser");
      await expect(page.getByRole("heading", { name: "Ydelser" })).toBeVisible();
      await expect(page.getByText("E2E Webudvikling")).toBeVisible();
    });

    test("AC-CATPUB-01: /en/services shows item with EN title", async ({ page }) => {
      await page.goto("/en/services");
      await expect(page.getByText("E2E Web Development")).toBeVisible();
    });

    test("AC-CATPUB-01: published section appears in main nav", async ({ page }) => {
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: /navigat/i });
      await expect(nav.getByRole("link", { name: /Ydelser/i })).toBeVisible();
    });

    test("AC-CATPUB-03: 'from' price renders 'fra 12.000 kr. inkl. moms' on DA section index", async ({
      page,
    }) => {
      await page.goto("/ydelser");
      await expect(page.getByText(/fra.*12\.000.*kr\..*inkl\. moms/i)).toBeVisible();
    });

    test("AC-CATPUB-10: DA item detail /ydelser/e2e-cat-webudvikling renders title", async ({
      page,
    }) => {
      await page.goto("/ydelser/e2e-cat-webudvikling");
      await expect(page.getByRole("heading", { name: "E2E Webudvikling" })).toBeVisible();
    });

    test("AC-CATPUB-10: EN item detail /en/services/e2e-cat-web-development renders EN title", async ({
      page,
    }) => {
      await page.goto("/en/services/e2e-cat-web-development");
      await expect(page.getByRole("heading", { name: "E2E Web Development" })).toBeVisible();
    });

    test("AC-CATPUB-11: item detail shows 'Kontakt os' CTA linking to /kontakt", async ({
      page,
    }) => {
      await page.goto("/ydelser/e2e-cat-webudvikling");
      const cta = page.getByRole("link", { name: /kontakt os/i });
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute("href", "/kontakt");
    });

    // Language switch — locators use hreflang attribute (per i18n-routing.spec.ts pattern;
    // accessible name in Chromium is "EN English" / "DA Dansk", not "EN"/"DA").
    test("AC-CATPUB-21: language switcher on /ydelser navigates to /en/services", async ({
      page,
    }) => {
      await page.goto("/ydelser");
      await page.locator('a[hreflang="en"]').first().click();
      await expect(page).toHaveURL(/\/en\/services/);
    });

    test("AC-CATPUB-21: language switcher on /en/services navigates to /ydelser", async ({
      page,
    }) => {
      await page.goto("/en/services");
      await page.locator('a[hreflang="da"]').first().click();
      await expect(page).toHaveURL(/\/ydelser(?!\/)/);
    });

    test("AC-CATPUB-21: language switch on DA item navigates to EN item", async ({ page }) => {
      await page.goto("/ydelser/e2e-cat-webudvikling");
      await page.locator('a[hreflang="en"]').first().click();
      await expect(page).toHaveURL(/\/en\/services\/e2e-cat-web-development/);
    });

    // Sitemap — presence anchor (status 200 + /kontakt) before dynamic assertions.
    test("AC-CATPUB-30: sitemap.xml returns 200", async ({ page }) => {
      const response = await page.goto("/sitemap.xml");
      expect(response?.status()).toBe(200);
    });

    test("AC-CATPUB-30: sitemap contains DA section URL", async ({ page }) => {
      await page.goto("/sitemap.xml");
      const content = await page.content();
      expect(content).toContain("/kontakt"); // always-present anchor
      expect(content).toContain("/ydelser");
    });

    test("AC-CATPUB-30: sitemap contains EN section URL", async ({ page }) => {
      await page.goto("/sitemap.xml");
      const content = await page.content();
      expect(content).toContain("/kontakt");
      expect(content).toContain("/en/services");
    });

    test("AC-CATPUB-30: sitemap contains DA item URL", async ({ page }) => {
      await page.goto("/sitemap.xml");
      const content = await page.content();
      expect(content).toContain("/kontakt");
      expect(content).toContain("/ydelser/e2e-cat-webudvikling");
    });

    test("AC-CATPUB-30: sitemap contains EN item URL", async ({ page }) => {
      await page.goto("/sitemap.xml");
      const content = await page.content();
      expect(content).toContain("/kontakt");
      expect(content).toContain("/en/services/e2e-cat-web-development");
    });

    // E2E-PUB-32: each catalog <url> block is parsed on its own. System pages carry
    // hreflang links too, so a whole-document match says nothing about the catalog.
    test("AC-CATPUB-31: catalog <url> entries carry da, en and x-default (DA) alternates", async ({
      request,
    }) => {
      const response = await request.get("/sitemap.xml");
      expect(response.status()).toBe(200);
      const xml = await response.text();
      const section = { da: "/ydelser", en: "/en/services", "x-default": "/ydelser" };
      const item = {
        da: "/ydelser/e2e-cat-webudvikling",
        en: "/en/services/e2e-cat-web-development",
        "x-default": "/ydelser/e2e-cat-webudvikling",
      };
      // The DA and the EN <url> of a page carry the same alternates.
      for (const alternates of [section, item]) {
        for (const pathname of [alternates.da, alternates.en]) {
          expect(sitemapAlternates(xml, pathname), `sitemap <url> ${pathname}`).toEqual(alternates);
        }
      }
    });
  });

  // ── AC-CATPUB-01: set item to draft → 404 + absent nav + sitemap ──────────
  //
  // After the publish block's afterAll sweeps test rows, the section has no
  // published items → it should be hidden.
  //
  // Sitemap absence: presence anchor (200 + /kontakt) before not.toContain.

  test.describe("AC-CATPUB-01: draft items (none published) → 404 + absent", () => {
    test("GET /ydelser returns 404 after test items removed", async ({
      page,
    }) => {
      test.skip(
        await hasRealPublicCatalogItem("services"),
        "Real published services content exists; route is legitimately visible",
      );
      await page.goto("/");
      await expect(page.locator("h1")).toBeVisible(); // presence anchor
      const response = await page.goto("/ydelser");
      expect(response?.status()).toBe(404);
    });

    test("section absent from nav after items removed", async ({
      page,
    }) => {
      test.skip(
        await hasRealPublicCatalogItem("services"),
        "Real published services content exists; category is legitimately in nav",
      );
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: /navigat/i });
      await expect(nav.getByRole("link", { name: /Forside/i })).toBeVisible();
      await expect(nav.getByRole("link", { name: /Ydelser/i })).toHaveCount(0);
    });

    test("AC-CATPUB-30: test item absent from sitemap after removal", async ({ page }) => {
      // Presence anchor: sitemap returns 200 and contains /kontakt.
      const response = await page.goto("/sitemap.xml");
      expect(response?.status()).toBe(200);
      const content = await page.content();
      expect(content).toContain("/kontakt");
      expect(content).not.toContain("e2e-cat-webudvikling");
    });
  });

  // ── AC-CATPUB-02: featured item pins first with Udvalgt badge ─────────────

  test.describe("AC-CATPUB-02: featured item pins first with Udvalgt badge", () => {
    test.beforeAll(async () => {
      await addCatalogTestItem("services", "published", {
        daSlug: "e2e-cat-udvalgt",
        daTitle: "E2E Udvalgt Ydelse",
        enSlug: "e2e-cat-udvalgt-en",
        enTitle: "E2E Featured Service",
        featured: true,
      });
      await addCatalogTestItem("services", "published", {
        daSlug: "e2e-cat-normal",
        daTitle: "E2E Normal Ydelse",
        enSlug: "e2e-cat-normal-en",
        enTitle: "E2E Regular Service",
        featured: false,
      });
      await revalidateSite();
    });

    test.afterAll(async () => {
      await removeCatalogTestItems();
      await revalidateSite();
    });

    test("AC-CATPUB-02: featured item card shows 'Udvalgt' badge", async ({ page }) => {
      await page.goto("/ydelser");
      await expect(page.getByRole("heading", { name: "Ydelser" })).toBeVisible();
      const featuredCard = page.locator("article", { hasText: "E2E Udvalgt Ydelse" });
      await expect(featuredCard.getByText("Udvalgt", { exact: true })).toBeVisible();
    });

    test("AC-CATPUB-02: featured item appears before non-featured in DOM", async ({ page }) => {
      await page.goto("/ydelser");
      await expect(page.getByRole("heading", { name: "Ydelser" })).toBeVisible();
      await expect(page.locator("article").first()).toContainText("E2E Udvalgt Ydelse");
    });

    test("AC-CATPUB-02: non-featured item has no 'Udvalgt' badge", async ({ page }) => {
      await page.goto("/ydelser");
      const nonFeaturedCard = page.locator("article", { hasText: "E2E Normal Ydelse" });
      await expect(nonFeaturedCard.getByText("Udvalgt")).toHaveCount(0);
    });
  });

  // ── AC-CATPUB-10: draft item → 404, published item → 200 (presence anchor) ─

  test.describe("AC-CATPUB-10: draft item → 404 (published anchor → 200 first)", () => {
    test.beforeAll(async () => {
      await addCatalogTestItem("services", "published", {
        daSlug: "e2e-cat-anchor",
        daTitle: "E2E Anchor Item",
        enSlug: "e2e-cat-anchor-en",
        enTitle: "E2E Anchor EN",
      });
      await addCatalogTestItem("services", "draft", {
        daSlug: "e2e-cat-draft",
        daTitle: "E2E Draft Item",
        enSlug: "e2e-cat-draft-en",
        enTitle: "E2E Draft EN",
      });
      await revalidateSite();
    });

    test.afterAll(async () => {
      await removeCatalogTestItems();
      await revalidateSite();
    });

    test("presence anchor: /ydelser/e2e-cat-anchor returns 200", async ({ page }) => {
      const response = await page.goto("/ydelser/e2e-cat-anchor");
      expect(response?.status()).toBe(200);
    });

    test("AC-CATPUB-10: /ydelser/e2e-cat-draft returns 404", async ({ page }) => {
      const response = await page.goto("/ydelser/e2e-cat-draft");
      expect(response?.status()).toBe(404);
    });

    test("AC-CATPUB-10: draft item absent from section index", async ({ page }) => {
      await page.goto("/ydelser");
      await expect(page.getByText("E2E Anchor Item")).toBeVisible(); // presence
      await expect(page.getByText("E2E Draft Item")).toHaveCount(0);
    });
  });

  // ── AC-CATPUB-01: draft category → 404 even with published items ──────────
  //
  // Snapshot via setCategoryStatus("services","draft"); restore in afterAll.

  test.describe("AC-CATPUB-01: draft category → 404 on both locales + absent nav/sitemap", () => {
    let categorySnapshot: CategoryStatusSnapshot[] = [];

    test.beforeAll(async () => {
      // Snapshot each row's id + status before changing it, so afterAll can
      // restore exactly what was there (seeded categories may start as draft).
      categorySnapshot = await snapshotCategoryStatuses("services");
      await addCatalogTestItem("services", "published", {
        daSlug: "e2e-cat-draftcat-anchor",
        daTitle: "E2E DraftCat Anchor",
        enSlug: "e2e-cat-draftcat-anchor-en",
        enTitle: "E2E DraftCat Anchor EN",
      });
      // Target only the first-by-nav_order row (same as addCatalogTestItem).
      await setCategoryStatus("services", "draft");
      await revalidateSite();
    });

    test.afterAll(async () => {
      // Restore each row to its original status by id (not by kind).
      await restoreCategoryStatuses(categorySnapshot);
      await removeCatalogTestItems();
      await revalidateSite();
    });

    test("presence anchor: GET / renders h1 (proves app is up)", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("h1")).toBeVisible();
    });

    test("AC-CATPUB-01: /ydelser returns 404 when category is draft", async ({ page }) => {
      const response = await page.goto("/ydelser");
      expect(response?.status()).toBe(404);
    });

    test("AC-CATPUB-01: /en/services returns 404 when category is draft", async ({ page }) => {
      const response = await page.goto("/en/services");
      expect(response?.status()).toBe(404);
    });

    test("AC-CATPUB-01: draft category absent from main nav", async ({ page }) => {
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: /navigat/i });
      await expect(nav.getByRole("link", { name: /Forside/i })).toBeVisible();
      await expect(nav.getByRole("link", { name: /Ydelser/i })).toHaveCount(0);
    });

    test("AC-CATPUB-30: draft category absent from sitemap", async ({ page }) => {
      const response = await page.goto("/sitemap.xml");
      expect(response?.status()).toBe(200);
      const content = await page.content();
      expect(content).toContain("/kontakt"); // anchor
      expect(content).not.toContain("/ydelser");
    });
  });

  // ── AC-CATPUB-20: EN locale DA fallback with lang="da" ─────────────────────

  test.describe("AC-CATPUB-20: EN section shows DA-fallback title with lang='da'", () => {
    test.beforeAll(async () => {
      await addCatalogTestItem("services", "published", {
        daSlug: "e2e-cat-da-kun",
        daTitle: "E2E DA-Kun Ydelse",
        enSlug: "e2e-cat-da-kun-en",
        enTitle: "", // blank → fallback expected
      });
      await revalidateSite();
    });

    test.afterAll(async () => {
      await removeCatalogTestItems();
      await revalidateSite();
    });

    test("AC-CATPUB-20: EN section index shows DA-fallback item title", async ({ page }) => {
      await page.goto("/en/services");
      await expect(page.getByText("E2E DA-Kun Ydelse")).toBeVisible();
    });

    test("AC-CATPUB-20: DA-fallback title carries lang='da' (WCAG 3.1.2)", async ({ page }) => {
      await page.goto("/en/services");
      const titleEl = page.getByText("E2E DA-Kun Ydelse");
      await expect(titleEl).toHaveAttribute("lang", "da");
    });
  });
});
