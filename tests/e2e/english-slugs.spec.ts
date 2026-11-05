/**
 * E2E tests: English slugs on every public URL (english-slugs feature)
 * Journey: english-slugs (E2E Scenarios)
 * Acceptance IDs: AC-ENSLUG-01 to 01g, 02 to 02g, 04 to 04e, 05 to 05d, 06,
 * 06b, 06c, 06e, 07, 07b and 08. Covered elsewhere: AC-ENSLUG-03 (unit,
 * tests/unit/app/[locale]/section-page.test.tsx and item-page.test.tsx),
 * AC-ENSLUG-06d, 06f and 06g (unit, the sitemap entries' alternates in
 * tests/unit/services/content/catalog.test.ts), AC-ENSLUG-07c
 * (tests/e2e/catalog-admin.spec.ts, AC-CATADM-30), AC-ENSLUG-09
 * (tests/integration/catalog/english-slugs-migration.test.ts) and
 * AC-ENSLUG-10 (unit, tests/unit/services/content/catalog.test.ts).
 *
 * Runs against the ISOLATED e2e Supabase project (giokcppmmzrrknmllfjc).
 * Guard: the outer describe-level test.skip on SUPABASE_E2E_REF keeps every
 * DB call away from prod when tests/.env.e2e-project is absent.
 *
 * 404 and link checks use `request.get` with `maxRedirects: 0`, so a redirect
 * surfaces as its 3xx status instead of being followed.
 *
 * Test data: a section page only exists while its section is published and
 * holds a published item, so the "every section" block seeds one published
 * item in each of the four sections and publishes the sections, then puts
 * every section back to its earlier status. This spec's catalog items have
 * DA slugs starting with `e2e-enslug-`, and it sweeps only that prefix. The
 * prefix lies outside `e2e-cat-`, so the `e2e-cat-` sweeps of other catalog
 * specs never delete these rows, and this spec never deletes theirs.
 *
 * Prerequisites:
 *   - Dev server at PLAYWRIGHT_BASE_URL against the e2e project (`npm run dev:e2e`)
 *   - tests/.env.e2e-project with SUPABASE_E2E_REF=giokcppmmzrrknmllfjc
 */

import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { PoolClient } from "../integration/rls/helpers/db";
import {
  getClient,
  endPool,
  randomE2ePassword,
  E2E_ENSLUG_ADMIN,
  seedCatalogAdmin,
  cleanupCatalogAdmin,
} from "./fixtures/catalog-admin-seed";
import { loginAs } from "./fixtures/admin-login";
import {
  addCatalogTestItem,
  removeCatalogTestItems,
  restoreCategoryStatuses,
  setCategoryStatus,
  snapshotCategoryStatuses,
  type CategoryStatusSnapshot,
} from "./fixtures/db-state";
import { revalidateSite } from "./fixtures/revalidate";

/** DA slug prefix of this spec's test items: the only catalog rows it deletes. */
const ITEM_SLUG_PREFIX = "e2e-enslug-";

/**
 * The four catalog sections: the section path (its English route slug, below
 * the locale prefix on both locales), its DA and EN titles in the e2e DB, the
 * journey ID of its DA page, and the published test item this spec seeds in
 * it. Each item's DA slug differs from its EN slug, the only one that may
 * appear in a URL, and is no prefix or substring of it.
 */
const SECTIONS = [
  {
    kind: "websites",
    path: "/websites",
    daTitle: "Hjemmesider",
    enTitle: "Websites",
    daPageAc: "AC-ENSLUG-01c",
    item: {
      daSlug: "e2e-enslug-hjemmeside",
      daTitle: "E2E DA Hjemmeside",
      enSlug: "e2e-enslug-website-en",
      enTitle: "E2E EN Website",
    },
  },
  {
    kind: "apps",
    path: "/apps",
    daTitle: "Apps",
    enTitle: "Apps",
    daPageAc: "AC-ENSLUG-01d",
    item: {
      daSlug: "e2e-enslug-dansk-app",
      daTitle: "E2E DA App",
      enSlug: "e2e-enslug-app-en",
      enTitle: "E2E EN App",
    },
  },
  {
    kind: "services",
    path: "/services",
    daTitle: "Ydelser",
    enTitle: "Services",
    daPageAc: "AC-ENSLUG-01e",
    item: {
      daSlug: "e2e-enslug-webudvikling",
      daTitle: "E2E DA Webudvikling",
      enSlug: "e2e-enslug-web-development",
      enTitle: "E2E EN Web Development",
    },
  },
  {
    kind: "models3d",
    path: "/3d-models",
    daTitle: "3D-modeller",
    enTitle: "3D models",
    daPageAc: "AC-ENSLUG-01f",
    item: {
      daSlug: "e2e-enslug-dansk-3d",
      daTitle: "E2E DA 3D-model",
      enSlug: "e2e-enslug-3d-model-en",
      enTitle: "E2E EN 3D Model",
    },
  },
] as const;

/** The sections whose test item gets the item page checks: the journey's services example and websites. */
const ITEM_PAGE_SECTIONS = SECTIONS.filter(({ kind }) => kind === "services" || kind === "websites");

/** A path at or below an old Danish section slug, on either locale. */
const OLD_SECTION_PATH = /^(\/en)?\/(hjemmesider|ydelser|3d-modeller)(\/|$)/;

test.afterAll(async () => {
  await endPool();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The `<loc>` pathnames of the sitemap. */
async function sitemapPaths(request: APIRequestContext): Promise<string[]> {
  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  const xml = await response.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].flatMap(([, loc]) => (loc ? [new URL(loc).pathname] : []));
}

/** The pathname of the page's `<head>` canonical link. */
async function canonicalPath(page: Page): Promise<string> {
  const href = await page.locator('head link[rel="canonical"]').evaluate((link) => (link as HTMLLinkElement).href);
  return new URL(href).pathname;
}

/** The page's `<head>` hreflang alternates, as hreflang to pathname. */
async function headAlternates(page: Page): Promise<Record<string, string>> {
  const links = await page.locator('head link[rel="alternate"][hreflang]').evaluateAll((elements) =>
    elements.map((element) => ({
      hreflang: element.getAttribute("hreflang") ?? "",
      href: (element as HTMLLinkElement).href,
    })),
  );
  return Object.fromEntries(links.map(({ hreflang, href }) => [hreflang, new URL(href).pathname]));
}

/**
 * `path` answers 200 as a `lang` page that shows `content`: copy the page
 * renders in that locale only (a message label, the e2e DB's section title).
 */
async function expectLocalePage(page: Page, path: string, lang: "da" | "en", content: Locator): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
  await expect(content).toBeVisible();
}

/**
 * The open section page lists the seeded item under its `title` in the
 * page's locale, and nowhere under its title in the other locale.
 */
async function expectItemCard(page: Page, title: string, otherLocaleTitle: string): Promise<void> {
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(main.getByText(otherLocaleTitle, { exact: true })).toHaveCount(0);
}

/**
 * Every internal link under `selector` on `path` answers 200 with no redirect.
 * The hrefs are read before any request; mailto:, absolute and fragment links
 * are not internal paths and are left out.
 */
async function expectInternalLinksOk(
  page: Page,
  request: APIRequestContext,
  path: string,
  selector: string,
): Promise<void> {
  await page.goto(path);
  const hrefs = await page
    .locator(selector)
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  const internal = [...new Set(hrefs.filter((href) => href.startsWith("/")))];
  expect(internal.length, `internal links under "${selector}" on ${path}`).toBeGreaterThan(0);
  for (const href of internal) {
    const response = await request.get(href, { maxRedirects: 0 });
    expect(response.status(), `"${selector}" link ${href} on ${path}`).toBe(200);
  }
}

// ── Guard: skip the whole file when the e2e project is not configured ─────────

test.describe("English slugs: public URLs use English on both locales", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    process.env.SUPABASE_E2E_REF !== "giokcppmmzrrknmllfjc",
    "english-slugs E2E requires tests/.env.e2e-project (SUPABASE_E2E_REF=giokcppmmzrrknmllfjc)",
  );

  // ── System pages at English slugs ─────────────────────────────────────────
  //
  // The contact page labels the contact details the e2e DB fills with the
  // Contact messages; the privacy page marks its own footer link (Nav
  // messages) as the current page. Both labels exist in one language only.

  test("AC-ENSLUG-01: GET /contact returns 200 on DA locale with Danish content", async ({ page }) => {
    await expectLocalePage(page, "/contact", "da", page.getByRole("main").getByText("Svartid", { exact: true }));
  });

  test("AC-ENSLUG-01b: GET /privacy returns 200 on DA locale with Danish content", async ({ page }) => {
    await expectLocalePage(
      page,
      "/privacy",
      "da",
      page.locator('footer a[aria-current="page"]', { hasText: /^Privatliv$/ }),
    );
  });

  test("AC-ENSLUG-04: GET /en/contact returns 200 on EN locale with English content", async ({ page }) => {
    await expectLocalePage(
      page,
      "/en/contact",
      "en",
      page.getByRole("main").getByText("Response time", { exact: true }),
    );
  });

  test("AC-ENSLUG-04b: GET /en/privacy returns 200 on EN locale with English content", async ({ page }) => {
    await expectLocalePage(
      page,
      "/en/privacy",
      "en",
      page.locator('footer a[aria-current="page"]', { hasText: /^Privacy$/ }),
    );
  });

  // ── Old Danish slugs: 404, no redirect ────────────────────────────────────

  test("AC-ENSLUG-02: GET /kontakt returns 404 with no redirect", async ({ request }) => {
    const response = await request.get("/kontakt", { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test("AC-ENSLUG-02b: GET /privatliv returns 404 with no redirect", async ({ request }) => {
    const response = await request.get("/privatliv", { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test("AC-ENSLUG-02c: GET /hjemmesider returns 404 with no redirect", async ({ request }) => {
    const response = await request.get("/hjemmesider", { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test("AC-ENSLUG-02d: GET /ydelser returns 404 with no redirect", async ({ request }) => {
    const response = await request.get("/ydelser", { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test("AC-ENSLUG-02e: GET /3d-modeller returns 404 with no redirect", async ({ request }) => {
    const response = await request.get("/3d-modeller", { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test("AC-ENSLUG-02f/04e: GET /en/hjemmesider returns 404 with no redirect", async ({ request }) => {
    const response = await request.get("/en/hjemmesider", { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  // ── Home and system pages: sitemap, canonical and hreflang ────────────────

  test("AC-ENSLUG-06: sitemap.xml lists /contact (not /kontakt)", async ({ request }) => {
    const paths = await sitemapPaths(request);
    expect(paths).toContain("/contact");
    expect(paths).toContain("/en/contact");
    expect(paths).not.toContain("/kontakt");
  });

  test("AC-ENSLUG-06: sitemap.xml lists /privacy (not /privatliv)", async ({ request }) => {
    const paths = await sitemapPaths(request);
    expect(paths).toContain("/privacy");
    expect(paths).toContain("/en/privacy");
    expect(paths).not.toContain("/privatliv");
  });

  // The DA home page and system pages, each with its EN path.
  for (const [name, path, enPath] of [
    ["the home page (/)", "/", "/en"],
    ["DA /contact page", "/contact", "/en/contact"],
    ["DA /privacy page", "/privacy", "/en/privacy"],
  ] as const) {
    test(`AC-ENSLUG-06e: canonical tag on ${name} is ${path}`, async ({ page }) => {
      await page.goto(path);
      expect(await canonicalPath(page)).toBe(path);
    });

    test(`AC-ENSLUG-06e: hreflang alternates on ${name} are da=${path}, en=${enPath}, x-default=${path}`, async ({
      page,
    }) => {
      await page.goto(path);
      expect(await headAlternates(page)).toEqual({ da: path, en: enPath, "x-default": path });
    });
  }

  // ── Language switcher on the contact page ─────────────────────────────────

  test("AC-ENSLUG-05d: language switcher on /contact links to /en/contact", async ({ page }) => {
    await page.goto("/contact");
    await expect(page.locator('a[hreflang="en"]').first()).toHaveAttribute("href", "/en/contact");
  });

  // ── Every section, with a published item in each, at its English slug ─────

  test.describe("Every section and its items at their English slugs", () => {
    /** Every section's status before this block published it. */
    let sectionStatuses: CategoryStatusSnapshot[] = [];

    test.beforeAll(async () => {
      // Rows of an aborted earlier run of this spec only.
      await removeCatalogTestItems(ITEM_SLUG_PREFIX);
      sectionStatuses = [];
      for (const { kind } of SECTIONS) sectionStatuses.push(...(await snapshotCategoryStatuses(kind)));
      for (const { kind, item } of SECTIONS) {
        // A section page answers 404 unless the section is published and holds a published item.
        await setCategoryStatus(kind, "published");
        await addCatalogTestItem(kind, "published", item);
      }
      await revalidateSite();
    });

    test.afterAll(async () => {
      try {
        // Deletes this block's items (the only rows with this spec's prefix).
        await removeCatalogTestItems(ITEM_SLUG_PREFIX);
      } finally {
        // Every section back to its earlier status, even when the item cleanup failed.
        await restoreCategoryStatuses(sectionStatuses);
        await revalidateSite();
      }
    });

    // ── Section pages on both locales ───────────────────────────────────────

    for (const { path, daTitle, enTitle, daPageAc, item } of SECTIONS) {
      test(`${daPageAc}: GET ${path} returns 200 on DA locale with Danish content`, async ({ page }) => {
        await expectLocalePage(page, path, "da", page.getByRole("heading", { level: 1, name: daTitle, exact: true }));
        await expectItemCard(page, item.daTitle, item.enTitle);
      });

      // The journey names /en/websites; every section's EN page gets the same check.
      test(`AC-ENSLUG-04c: GET /en${path} returns 200 on EN locale with English content`, async ({ page }) => {
        await expectLocalePage(
          page,
          `/en${path}`,
          "en",
          page.getByRole("heading", { level: 1, name: enTitle, exact: true }),
        );
        await expectItemCard(page, item.enTitle, item.daTitle);
      });
    }

    // ── Item pages at the EN item slug ──────────────────────────────────────

    for (const { path, item } of ITEM_PAGE_SECTIONS) {
      const itemPath = `${path}/${item.enSlug}`;

      test(`AC-ENSLUG-01g: GET ${path}/<en-item-slug> returns 200 on DA locale with the Danish item title`, async ({
        page,
      }) => {
        await expectLocalePage(
          page,
          itemPath,
          "da",
          page.getByRole("heading", { level: 1, name: item.daTitle, exact: true }),
        );
      });

      test(`AC-ENSLUG-04d: GET /en${path}/<en-item-slug> returns 200 on EN locale with the English item title`, async ({
        page,
      }) => {
        await expectLocalePage(
          page,
          `/en${itemPath}`,
          "en",
          page.getByRole("heading", { level: 1, name: item.enTitle, exact: true }),
        );
      });

      test(`AC-ENSLUG-02g: GET ${path}/<da-item-slug> returns 404 with no redirect`, async ({ request }) => {
        const response = await request.get(`${path}/${item.daSlug}`, { maxRedirects: 0 });
        expect(response.status()).toBe(404);
      });

      test(`AC-ENSLUG-05c: language switcher on ${path}/<en-item-slug> navigates to /en${path}/<en-item-slug>`, async ({
        page,
      }) => {
        await page.goto(itemPath);
        await page.locator('a[hreflang="en"]').first().click();
        await expect(page).toHaveURL((url) => url.pathname === `/en${itemPath}`);
        await expect(page.getByRole("heading", { level: 1, name: item.enTitle, exact: true })).toBeVisible();
      });

      test(`AC-ENSLUG-05c: language switcher on /en${path}/<en-item-slug> navigates to ${path}/<en-item-slug>`, async ({
        page,
      }) => {
        await page.goto(`/en${itemPath}`);
        await page.locator('a[hreflang="da"]').first().click();
        await expect(page).toHaveURL((url) => url.pathname === itemPath);
        await expect(page.getByRole("heading", { level: 1, name: item.daTitle, exact: true })).toBeVisible();
      });

      test(`AC-ENSLUG-06c: sitemap.xml DA item URL under ${path} uses the EN item slug (not the DA item slug)`, async ({
        request,
      }) => {
        const paths = await sitemapPaths(request);
        expect(paths).toContain(itemPath);
        expect(paths).toContain(`/en${itemPath}`);
        expect(paths.filter((sitemapPath) => sitemapPath.includes(item.daSlug))).toEqual([]);
      });

      test(`AC-ENSLUG-06e: hreflang alternates on DA ${path}/<en-item-slug> item page use the same English slug for da, en, and x-default`, async ({
        page,
      }) => {
        await page.goto(itemPath);
        expect(await headAlternates(page)).toEqual({
          da: itemPath,
          en: `/en${itemPath}`,
          "x-default": itemPath,
        });
      });
    }

    // ── Language switcher on a section page ─────────────────────────────────

    test("AC-ENSLUG-05: language switcher on /services navigates to /en/services", async ({ page }) => {
      await page.goto("/services");
      await page.locator('a[hreflang="en"]').first().click();
      await expect(page).toHaveURL((url) => url.pathname === "/en/services");
    });

    test("AC-ENSLUG-05b: language switcher on /en/services navigates to /services", async ({ page }) => {
      await page.goto("/en/services");
      await page.locator('a[hreflang="da"]').first().click();
      await expect(page).toHaveURL((url) => url.pathname === "/services");
    });

    // ── Sitemap: English section paths only ─────────────────────────────────

    test("AC-ENSLUG-06b: sitemap.xml lists DA section URLs with English slugs (/websites, /services, /apps, /3d-models)", async ({
      request,
    }) => {
      const paths = await sitemapPaths(request);
      for (const { path } of SECTIONS) {
        expect(paths).toContain(path);
        expect(paths).toContain(`/en${path}`);
      }
      expect(paths.filter((path) => OLD_SECTION_PATH.test(path))).toEqual([]);
    });

    // ── <head> of every section page: canonical and hreflang ────────────────

    for (const { path } of SECTIONS) {
      test(`AC-ENSLUG-06e: canonical tag on DA ${path} page is ${path}`, async ({ page }) => {
        await page.goto(path);
        expect(await canonicalPath(page)).toBe(path);
      });

      test(`AC-ENSLUG-06e: hreflang alternates on DA ${path} page are da=${path}, en=/en${path}, x-default=${path}`, async ({
        page,
      }) => {
        await page.goto(path);
        expect(await headAlternates(page)).toEqual({ da: path, en: `/en${path}`, "x-default": path });
      });

      test(`AC-ENSLUG-06e: canonical tag on EN /en${path} page is /en${path}`, async ({ page }) => {
        await page.goto(`/en${path}`);
        expect(await canonicalPath(page)).toBe(`/en${path}`);
      });
    }

    // ── Internal links: header navigation and footer on both locales ────────
    //
    // Inside the seeded block, so the navigation holds the published
    // sections' links when the crawl runs.

    test("AC-ENSLUG-08: no broken internal links in the DA header navigation", async ({ page, request }) => {
      await expectInternalLinksOk(page, request, "/", "header nav a[href]");
    });

    test("AC-ENSLUG-08: no broken internal links in the EN header navigation", async ({ page, request }) => {
      await expectInternalLinksOk(page, request, "/en", "header nav a[href]");
    });

    test("AC-ENSLUG-08: no broken internal links in the DA footer", async ({ page, request }) => {
      await expectInternalLinksOk(page, request, "/", "footer a[href]");
    });

    test("AC-ENSLUG-08: no broken internal links in the EN footer", async ({ page, request }) => {
      await expectInternalLinksOk(page, request, "/en", "footer a[href]");
    });
  });

  // ── Admin item editor: URL-slug hints ─────────────────────────────────────

  test.describe("Admin item editor URL-slug hints", () => {
    let pgClient: PoolClient;
    let password: string;
    let newServicesItemPath: string;

    test.beforeAll(async () => {
      pgClient = await getClient();
      password = randomE2ePassword();
      await cleanupCatalogAdmin(pgClient, E2E_ENSLUG_ADMIN);
      await seedCatalogAdmin(pgClient, password, E2E_ENSLUG_ADMIN);
      const { rows } = await pgClient.query<{ id: string }>(
        "SELECT id FROM public.categories WHERE kind = 'services' ORDER BY nav_order LIMIT 1",
      );
      if (!rows[0]) throw new Error("No services category in the e2e project");
      newServicesItemPath = `/admin/catalog/items/new?category=${rows[0].id}`;
    });

    test.afterAll(async () => {
      if (pgClient) {
        await cleanupCatalogAdmin(pgClient, E2E_ENSLUG_ADMIN);
        pgClient.release();
      }
    });

    test("AC-ENSLUG-07: admin item editor DA URL-slug field hint says the Danish slug is not part of the public address", async ({
      page,
    }) => {
      await loginAs(page, E2E_ENSLUG_ADMIN.email, password, newServicesItemPath);
      await expect(page.getByLabel("URL-slug (DA)", { exact: true })).toHaveAccessibleDescription(
        /engelske URL-slug på begge sprog, så den danske er ikke en del af adressen/,
      );
    });

    test("AC-ENSLUG-07b: admin item editor EN URL-slug field hint says it forms the address on both languages, with no em-dash", async ({
      page,
    }) => {
      await loginAs(page, E2E_ENSLUG_ADMIN.email, password, newServicesItemPath);
      await page.getByRole("tab", { name: "Engelsk", exact: true }).click();
      const enSlug = page.getByLabel("URL-slug (EN)", { exact: true });
      await expect(enSlug).toBeVisible();
      await expect(enSlug).toHaveAccessibleDescription(/Danner den offentlige adresse på begge sprog/);
      await expect(enSlug).not.toHaveAccessibleDescription(/\u2014/);
    });
  });
});
