-- Company CVR number (site_settings.cvr) for the footer, the privacy policy and the contact page.
--
-- The footer reads site_settings.cvr directly. Page copy names it with the `{cvr}` token, which
-- services/content/pages.ts replaces with site_settings.cvr as plain text, so the number lives in
-- this one row only.
--
-- Copy updates only add text and never overwrite an admin's own wording: a row that already
-- contains `{cvr}` (or a `company` key) is left alone, so a re-run changes nothing. Only the
-- Danish rows change: the English rows are blank and show the Danish text (page fallback), so
-- English gets the CVR from Danish.

update public.site_settings set cvr = '46887433';

-- Privacy: a data-controller section right after the intro, before the seeded first heading.
-- Skipped (with a warning) when the heading was edited away, so nothing is guessed.
do $$
declare
  v_heading constant text := E'\n\n## Hvilke oplysninger vi behandler';
  v_rows    integer;
begin
  update public.page_translations t
     set body_md = replace(t.body_md, v_heading,
           E'\n\n## Dataansvarlig\n\nAlnyron, CVR {cvr}, er dataansvarlig for behandlingen af dine personoplysninger.'
           || v_heading)
    from public.pages p
   where p.id = t.page_id
     and p.system_key = 'privacy'
     and t.locale = 'da'
     and strpos(t.body_md, v_heading) > 0
     and strpos(t.body_md, '{cvr}') = 0;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise warning 'site_cvr: Danish privacy policy not updated (it already contains {cvr} or lacks the seeded heading); add "Alnyron, CVR {cvr}" under Admin > Sider if it is missing';
  end if;
end $$;

-- Contact: the company details row (content.company, "Virksomhed" under Admin > Sider > Kontakt).
update public.page_translations t
   set content = t.content || jsonb_build_object('company', 'Alnyron · CVR {cvr}')
  from public.pages p
 where p.id = t.page_id
   and p.system_key = 'contact'
   and t.locale = 'da'
   and not (t.content ? 'company');
