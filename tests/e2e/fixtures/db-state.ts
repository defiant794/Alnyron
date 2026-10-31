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
 *   - run them against the dev server (no ISR cache) and never while a
 *     production site is served from the same project.
 *
 * Connection: the integration-test pool (tests/integration/rls/helpers/db.ts,
 * `SUPABASE_DB_PASSWORD`, verify-full TLS; close it with its `endPool()`);
 * playwright.config.ts loads the SUPABASE_DB_* keys from tests/.env.e2e.
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
    [kind ?? null, `${SLUG_PREFIX}%`],
  );
  return row?.exists ?? false;
}
