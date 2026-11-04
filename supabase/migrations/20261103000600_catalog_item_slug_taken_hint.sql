-- F2.3 catalog-admin (code review 2): a taken item slug names its language.
--
-- admin_save_item runs as the caller (security invoker), and item_translations has RLS enabled.
-- For a caller RLS applies to (every API role, the admin included) Postgres leaves the
-- "Key (locale, slug)=(en, ...)" DETAIL out of a unique violation, since key values may belong
-- to rows the caller cannot read. That DETAIL was the service's only source for the locale, so a
-- real clash reached the item editor without one and fell back to a form-level alert instead of
-- the error under that language's URL-slug. The translation upsert now catches a violation of
-- item_translations_locale_slug_key and raises it again as 23505 `slug_taken` with the locale as
-- HINT. The locale is the loop's (the caller's own payload key), so it discloses no stored row.
-- Any other unique violation is re-raised unchanged; the media loop is not touched.
--
-- Same signature as 20261103000500: `create or replace` keeps the owner and the grants, which are
-- restated below anyway so this file alone shows who may call the function.

-- payload: {id?, category_id (insert only), featured?, price_type?, price_amount?, price_currency?,
--           external_links?, translations: {da: {slug, title, summary, body_md, seo_title,
--           seo_description}, en: {...}}, media?: [{id, alt_da, alt_en, sort_order}]}
create or replace function public.admin_save_item(payload jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id         uuid;
  v_category   uuid;
  v_locale     public.locale_code;
  v_tr         jsonb;
  v_media      jsonb;
  v_constraint text;
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- An item holds at most 8 images, so a longer media list cannot name only its own.
  if jsonb_array_length(coalesce(payload -> 'media', '[]'::jsonb)) > 8 then
    raise exception 'too_many_media' using errcode = 'P0001';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  if v_id is null then
    v_category := nullif(payload ->> 'category_id', '')::uuid;
    if v_category is null then
      raise exception 'category_required' using errcode = '22023';
    end if;
    insert into public.items
      (category_id, status, sort_order, featured, price_type, price_amount, price_currency, external_links)
    values (v_category, 'draft',
            coalesce((select max(i.sort_order) from public.items i where i.category_id = v_category), 0) + 10,
            coalesce((payload ->> 'featured')::boolean, false),
            (payload ->> 'price_type')::public.price_type,
            (payload ->> 'price_amount')::numeric,
            coalesce(payload ->> 'price_currency', 'DKK'),
            coalesce(nullif(payload -> 'external_links', 'null'::jsonb), '{}'::jsonb))
    returning id into v_id;   -- 23503 when category_id names no category
  else
    -- A price/link key present in the payload replaces the column (JSON null clears it:
    -- SQL null for the price, the column default for currency and links); absent keeps it.
    -- category_id is fixed after insert.
    update public.items i
       set featured       = coalesce((payload ->> 'featured')::boolean, i.featured),
           price_type     = case when payload ? 'price_type'
                                 then (payload ->> 'price_type')::public.price_type else i.price_type end,
           price_amount   = case when payload ? 'price_amount'
                                 then (payload ->> 'price_amount')::numeric else i.price_amount end,
           price_currency = case when payload ? 'price_currency'
                                 then coalesce(payload ->> 'price_currency', 'DKK') else i.price_currency end,
           external_links = case when payload ? 'external_links'
                                 then coalesce(nullif(payload -> 'external_links', 'null'::jsonb), '{}'::jsonb)
                                 else i.external_links end
     where i.id = v_id;
    if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  end if;

  for v_locale, v_tr in
    select key::public.locale_code, value from jsonb_each(coalesce(payload -> 'translations', '{}'::jsonb))
  loop
    begin
      insert into public.item_translations
        (item_id, locale, slug, title, summary, body_md, seo_title, seo_description)
      values (v_id, v_locale, v_tr ->> 'slug',
              coalesce(v_tr ->> 'title', ''), coalesce(v_tr ->> 'summary', ''), coalesce(v_tr ->> 'body_md', ''),
              coalesce(v_tr ->> 'seo_title', ''), coalesce(v_tr ->> 'seo_description', ''))
      on conflict (item_id, locale) do update
        set slug = excluded.slug, title = excluded.title, summary = excluded.summary,
            body_md = excluded.body_md, seo_title = excluded.seo_title,
            seo_description = excluded.seo_description;
    exception when unique_violation then
      -- The constraint name survives RLS (only the key DETAIL is dropped).
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'item_translations_locale_slug_key' then
        raise exception 'slug_taken'
          using errcode = '23505', constraint = v_constraint, hint = v_locale::text;
      end if;
      raise;
    end;
  end loop;

  for v_media in select value from jsonb_array_elements(coalesce(payload -> 'media', '[]'::jsonb))
  loop
    update public.media m
       set alt_da     = coalesce(v_media ->> 'alt_da', m.alt_da),
           alt_en     = coalesce(v_media ->> 'alt_en', m.alt_en),
           sort_order = coalesce((v_media ->> 'sort_order')::integer, m.sort_order)
     where m.id = (v_media ->> 'id')::uuid and m.item_id = v_id;
    if not found then raise exception 'media_not_found' using errcode = 'P0002'; end if;
  end loop;

  return v_id;
end;
$$;

revoke execute on function public.admin_save_item(jsonb) from public, anon;
grant  execute on function public.admin_save_item(jsonb) to authenticated;

comment on function public.admin_save_item(jsonb) is
  'Creates (no id: draft, sort_order = category max + 10, category_id required -> 22023 category_required, unknown -> 23503) or updates an item: price/link keys present in the payload replace the column, absent keys keep it; category_id is fixed. Upserts each given locale''s translation and updates alt/sort_order of the listed media of this item (at most 8 entries -> P0001 too_many_media; P0002 media_not_found otherwise). P0002 item_not_found; 23505 slug_taken (constraint item_translations_locale_slug_key) with the clashing translation''s locale as HINT, since RLS drops the key DETAIL; 23514 by constraint name. updated_by is set by the items_updated_by trigger.';
