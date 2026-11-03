/**
 * E2E DB fixture for category visibility (home-page journey, "Fixture needs").
 *
 * A category is public once it is published and holds a published item
 * (`private.category_is_public`). These helpers make categories public or
 * keep them hidden by adding and removing marked test items in the linked
 * Supabase project. They write COMMITTED rows (the dev server reads through
 * its own connection), so:
 *   - every test row is marked by an item slug starting with `e2e-home-` and
 *     removed again by `removeTestItems()` (also run before a block, which
 *     cleans up after an aborted run);
 *   - real content is never changed: a scenario that needs "no public
 *     category" is skipped when real published content exists;
 *   - run them against the dev server, or a local production build with
 *     `revalidateSite()` (./revalidate.ts) after every change, and never
 *     while a production site is served from the same project.
 *
 * Connection: the integration-test pool (tests/integration/rls/helpers/db.ts,
 * verify-full TLS; close it with its `endPool()`). playwright.config.ts loads
 * `SUPABASE_DB_PASSWORD` from tests/.env.e2e, or, with tests/.env.e2e-project
 * present, only the e2e project's `SUPABASE_E2E_DB_*` keys.
 */
import type { QueryResultRow } from "pg";
import { getClient } from "../../integration/rls/helpers/db";
import type { Database } from "../../../src/types/database";

type CatalogKind = Database["public"]["Enums"]["catalog_kind"];
type ContentStatus = Database["public"]["Enums"]["content_status"];

const SLUG_PREFIX = "e2e-home-";

async function query<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const client = await getClient();
  try {
    return (await client.query<Row>(sql, params)).rows;
  } finally {
    client.release();
  }
}

/**
 * Adds one test item with a Danish translation to the category of `kind`.
 * A `published` item makes that category public; a `draft` one does not.
 */
export async function addTestItem(kind: CatalogKind, status: ContentStatus): Promise<void> {
  const rows = await query(
    `with c as (
       select id from public.categories where kind = $1::public.catalog_kind order by nav_order limit 1),
     i as (
       insert into public.items (category_id, status, sort_order, published_at)
       select id, $2::public.content_status, 9999,
              case when $2::public.content_status = 'published' then now() end
       from c
       returning id)
     insert into public.item_translations (item_id, locale, slug, title)
     select id, 'da', $3, $4 from i
     returning item_id`,
    [kind, status, `${SLUG_PREFIX}${kind}-${status}`, `E2E test item (${kind}, ${status})`],
  );
  if (rows.length !== 1) throw new Error(`addTestItem: no "${kind}" category to add a test item to`);
}

/** Removes every test item added by {@link addTestItem} (translations cascade). */
export async function removeTestItems(): Promise<void> {
  await query(
    `delete from public.items
     where id in (select item_id from public.item_translations where slug like $1)`,
    [`${SLUG_PREFIX}%`],
  );
}

/** True when real (non-test) published content makes a category of `kind` (or any category) public. */
export async function hasRealPublicCategory(kind?: CatalogKind): Promise<boolean> {
  const [row] = await query<{ exists: boolean }>(
    `select exists (
       select 1 from public.categories c
       join public.items i on i.category_id = c.id and i.status = 'published'
       where c.status = 'published'
         and ($1::public.catalog_kind is null or c.kind = $1::public.catalog_kind)
         and not exists (
           select 1 from public.item_translations t where t.item_id = i.id and t.slug like $2))`,
    [kind ?? null, "e2e-%"],
  );
  return row?.exists ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog-public (F2.2) fixture helpers
//
// All test rows are marked by a DA item slug that starts with `e2e-cat-`.
// `removeCatalogTestItems()` sweeps them after every block (and in beforeAll
// to clean up aborted runs). Do not use these against the production project.
// ─────────────────────────────────────────────────────────────────────────────

const CATALOG_SLUG_PREFIX = "e2e-cat-";

/** Random 8-char suffix so repeated calls never collide on the unique slug constraint. */
function e2eSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export interface AddCatalogTestItemOptions {
  /** DA slug; defaults to `e2e-cat-<kind>-da`. */
  daSlug?: string;
  /** DA title; defaults to `E2E Test Item DA (<kind>)`. */
  daTitle?: string;
  /** Optional DA summary used in item_translations. */
  daSummary?: string;
  /** EN slug; defaults to `e2e-cat-<kind>-en`. */
  enSlug?: string;
  /** EN title; blank string is intentional (tests DA fallback). */
  enTitle?: string;
  /** EN summary; blank by default. */
  enSummary?: string;
  featured?: boolean;
  priceType?: "fixed" | "from" | "contact" | null;
  priceAmount?: number | null;
}

/**
 * Adds a catalog test item (DA + EN translations) to the first category of
 * `kind`. Publishing it makes that category publicly visible via
 * `private.category_is_public`. Returns the inserted `item_id`.
 *
 * Slugs use the `e2e-cat-` prefix so `removeCatalogTestItems()` can sweep.
 */
export async function addCatalogTestItem(
  kind: CatalogKind,
  status: ContentStatus,
  options: AddCatalogTestItemOptions = {},
): Promise<{ itemId: string }> {
  const suffix = options.daSlug === undefined ? e2eSuffix() : "";
  const daSlug = options.daSlug ?? `${CATALOG_SLUG_PREFIX}${kind}-${suffix}`;
  const daTitle = options.daTitle ?? `E2E Test Item DA (${kind})`;
  const daSummary = options.daSummary ?? "";
  const enSlug = options.enSlug ?? `${CATALOG_SLUG_PREFIX}${kind}-en-${suffix}`;
  const enTitle = options.enTitle ?? `E2E Test Item EN (${kind})`;
  const enSummary = options.enSummary ?? "";

  const rows = await query<{ item_id: string }>(
    `with c as (
       select id from public.categories
       where kind = $1::public.catalog_kind
       order by nav_order limit 1),
     i as (
       insert into public.items
         (category_id, status, sort_order, featured,
          price_type, price_amount, price_currency, published_at)
       select id,
              $2::public.content_status,
              9998,
              $3::boolean,
              $4::public.price_type,
              $5::numeric,
              'DKK',
              case when $2::public.content_status = 'published' then now() end
       from c
       returning id),
     _da as (
       insert into public.item_translations (item_id, locale, slug, title, summary)
       select id, 'da', $6, $7, $8 from i
       returning item_id)
     insert into public.item_translations (item_id, locale, slug, title, summary)
     select item_id, 'en', $9, $10, $11 from _da
     returning item_id`,
    [
      kind,
      status,
      options.featured ?? false,
      options.priceType ?? null,
      options.priceAmount ?? null,
      daSlug,
      daTitle,
      daSummary,
      enSlug,
      enTitle,
      enSummary,
    ],
  );

  if (rows.length !== 1) {
    throw new Error(`addCatalogTestItem: no "${kind}" category found, or insert failed`);
  }
  return { itemId: rows[0]!.item_id };
}

/** Removes every test item added by {@link addCatalogTestItem}. */
export async function removeCatalogTestItems(): Promise<void> {
  await query(
    `delete from public.items
     where id in (
       select item_id from public.item_translations
       where slug like $1 and locale = 'da')`,
    [`${CATALOG_SLUG_PREFIX}%`],
  );
}

/**
 * True when real (non-test) published content makes a category of `kind`
 * publicly visible. Use to skip tests that depend on "no public content"
 * when real items exist in the e2e project.
 */
export async function hasRealPublicCatalogItem(kind?: CatalogKind): Promise<boolean> {
  const [row] = await query<{ exists: boolean }>(
    `select exists (
       select 1
       from public.categories c
       join public.items i
         on i.category_id = c.id and i.status = 'published'
       join public.item_translations t
         on t.item_id = i.id and t.locale = 'da'
       where c.status = 'published'
         and ($1::public.catalog_kind is null or c.kind = $1::public.catalog_kind)
         and t.slug not like $2
     ) as exists`,
    [kind ?? null, "e2e-%"],
  );
  return row?.exists ?? false;
}

/** A saved row for snapshot/restore of category status. */
export interface CategoryStatusSnapshot {
  id: string;
  status: ContentStatus;
}

/**
 * Reads the id + status of every category of `kind` in the e2e project.
 * Save the return value in `beforeAll`; pass it to {@link restoreCategoryStatuses}
 * in `afterAll` to put every row back exactly as it was.
 */
export async function snapshotCategoryStatuses(
  kind: CatalogKind,
): Promise<CategoryStatusSnapshot[]> {
  return query<CategoryStatusSnapshot>(
    `select id, status::text as status from public.categories
     where kind = $1::public.catalog_kind`,
    [kind],
  );
}

/**
 * Restores each category to its snapshotted status (by id, not by kind).
 * Safe to call even when a category was already at the target status.
 */
export async function restoreCategoryStatuses(
  snapshots: CategoryStatusSnapshot[],
): Promise<void> {
  for (const { id, status } of snapshots) {
    await query(
      `update public.categories
       set status = $1::public.content_status
       where id = $2`,
      [status, id],
    );
  }
}

/**
 * Sets the status of the FIRST category of `kind` (by nav_order) in the
 * e2e project — the same row {@link addCatalogTestItem} targets.
 * Always call {@link snapshotCategoryStatuses} in beforeAll and
 * {@link restoreCategoryStatuses} in afterAll rather than hard-coding
 * "published" as the restore value.
 */
export async function setCategoryStatus(
  kind: CatalogKind,
  status: ContentStatus,
): Promise<void> {
  await query(
    `update public.categories
     set status = $1::public.content_status
     where id = (
       select id from public.categories
       where kind = $2::public.catalog_kind
       order by nav_order
       limit 1)`,
    [status, kind],
  );
}
