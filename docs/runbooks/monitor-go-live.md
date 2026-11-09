# Runbook: Monitor go-live (monitor.alnyron.dk + public signup)

Puts Monitor on its own host, `monitor.alnyron.dk`, and switches public signup on in production. Do the steps **in order**: each row's gate must hold before the next row starts. Nothing here runs automatically. The build never changes the production Supabase project or the Cloudflare zone; every SUPABASE, CLOUDFLARE and USER step is done by the owner.

| Tag | Meaning |
|---|---|
| VERIFY | Read-only check; changes nothing |
| CODE | This repo: feature-orchestrator TDD loop, the main session commits |
| SUPABASE | Production auth config through the Management API |
| CLOUDFLARE | The zone and the Workers in the Cloudflare account |
| USER | Owner tasks outside both |

## What the code already does (Run A)

- `monitor.alnyron.dk` serves the `/monitor` area: `/` is the landing page, `/login` the login page, `/monitor/*` is served as it is, `/auth/*` passes through. `/admin` and `/mylife` are not served there: they become `/monitor/admin` and `/monitor/mylife`, which redirect (307) to the Monitor login without a session and are 404 with one (`src/middleware.ts`). Every page there sends `X-Robots-Tag: noindex, nofollow` (`next.config.mjs`).
- `alnyron.dk/monitor` and `alnyron.dk/monitor/*` answer `308` to the Monitor host (`/monitor` -> `/`, query kept, `Cache-Control: public, max-age=86400`). The Monitor host is derived from the build variable `NEXT_PUBLIC_SITE_URL` (`https://alnyron.dk` -> `https://monitor.alnyron.dk`); a site URL that does not map to a Monitor host fails loudly.
- Signup confirmation emails keep the Site URL link (`https://alnyron.dk/auth/confirm?...&type=signup&next=/monitor/dashboard`). `/auth/confirm` on the main host forwards a Monitor link (`type=signup`, or a `next` under `/monitor/`) **before verifying it** to `https://monitor.alnyron.dk/auth/confirm` with the same query (no-store 307, fixed origin), so the one-time token is spent and the session cookie set on the Monitor host.
- Password resets asked on the Monitor host send `redirectTo = https://monitor.alnyron.dk`; the recovery template's Monitor branch then links `https://monitor.alnyron.dk/auth/confirm?...&type=recovery&next=/monitor/reset`. GoTrue only keeps that `redirectTo` when the **exact** origin is on the redirect allow-list (`https://x/**` does not match a bare `https://x`); otherwise it falls back to the Site URL link and the session lands on the main host, where `/monitor/reset` redirects away from it (step 3).
- The lockup, the footer's privacy link and the signup page's privacy link on the Monitor host are absolute main-site URLs; the site nav's Monitor item links `https://monitor.alnyron.dk/`.
- The cron Worker's `MONITOR_SITE_URL` is `https://monitor.alnyron.dk` (`workers/monitor-cron/wrangler.jsonc`): change emails link `https://monitor.alnyron.dk/monitor/monitors/<id>`.
- `site_url` stays `https://alnyron.dk`: admin invites and resets, and every template's fallback branch, depend on it.

## What Run B adds

Run B (a later commit) adds migration `20261110000100_monitor_signup_notice.sql` and two last steps to every cron run (`workers/monitor-cron/README.md`, "New signups and unconfirmed accounts"): the owner's "new signup" email and the purge of unconfirmed `monitor_user` accounts older than 24 hours. The same migration adds a trigger on `auth.users` that empties a pre-registered password. Rows marked **[Run B]** depend on it.

- `public.profiles.signup_notified_at`: when the owner was told about a new confirmed `monitor_user` account. Adding the column stamps every existing `monitor_user` row with its own `created_at`, so no account that exists before step 2 is notified.
- Three functions, callable only with the cron's service-role key (EXECUTE revoked from `public`, `anon` and `authenticated`, granted to `service_role`; empty `search_path`):
  - `monitor_engine_pending_signups(integer, integer)`: the next confirmed `monitor_user` accounts to notify, with the owner's address. **SECURITY DEFINER**, owned by `postgres`: it reads `auth.users.email_confirmed_at`, and `service_role` has no privilege at all on `auth.users` (checked on the e2e project; the table belongs to `supabase_auth_admin` and has RLS on). A grant on that table would open all of it to every holder of the secret key; the function returns only the pending notices.
  - `monitor_engine_mark_signup_notified(uuid)`: stamps `signup_notified_at` once the notice was sent (or rejected for good). SECURITY INVOKER: it writes only `public.profiles`, which `service_role` may update.
  - `monitor_engine_purge_unconfirmed(integer)`: deletes `monitor_user` accounts still unconfirmed 24 hours after signup (profile, monitors and the other account rows go by cascade). **SECURITY DEFINER**, owned by `postgres`, for the same reason: it deletes from `auth.users`, but only the rows its own condition selects. Other roles (owner, admin, MyLife accounts waiting for their invite) are never deleted.
- `private.monitor_wipe_password_on_resignup()` and its trigger `monitor_wipe_password_on_resignup` (`BEFORE UPDATE OF confirmation_sent_at, recovery_sent_at ON auth.users`): empties `encrypted_password` of an unconfirmed `monitor_user` account whenever `confirmation_sent_at` changes from a non-NULL value or `recovery_sent_at` changes to a new non-NULL value. Per the supabase/auth source (v2.197.0 and master, see the next point; production's version is not verified), GoTrue does that notably in these cases (the list is not exhaustive): it records a confirmation again (a re-signup that keeps the first password and a resend, both emailing it; an admin `generate_link` of type `signup` for the existing account, which ignores the submitted password and emails nothing); its `UpdatePassword` writes a new password together with `confirmation_sent_at = NULL` in one UPDATE (a re-signup that overwrites the password, whose confirmation then goes from NULL to now, wipes nothing and leaves the password empty; also an admin password change); its `ClearAllPendingTokens` sets `confirmation_sent_at = NULL` with the other pending tokens (an admin email or phone change without `email_confirm`, and `UpdateUserEmailFromIdentities`); and it records a password reset (a reset asked with the address, which emails the link; an admin `generate_link` of type `recovery` or `magiclink` for the existing account, which emails nothing), so the password is emptied before the reset link can confirm the account. `UpdatePassword` and `ClearAllPendingTokens` also set `recovery_sent_at = NULL`, which wipes nothing; their `confirmation_sent_at` change decides. **SECURITY DEFINER**, owned by `postgres` (GoTrue updates `auth.users` as `supabase_auth_admin`, and the function reads `public.profiles`); EXECUTE revoked from `public`, `anon` and `authenticated` and granted to no role; `service_role` holds none either (checked on the e2e project; step 2 checks it again). The first confirmation, the confirmation itself, confirmed accounts and other roles are untouched.
- Pre-registration, and why the trigger: a stranger may sign up with someone else's address and a password of their own, hoping the owner of the address confirms that account. What GoTrue does when an unconfirmed address signs up again depends on its version (read in the supabase/auth source at v2.197.0, the version the e2e project reports, and on master; production's version is not verified): v2.197.0 keeps the first signup's password and only sends the confirmation again; supabase/auth master (#2868 of 2026-11-03, reverted by #2912, re-landed by #2918 on 2026-11-09) runs the before-user-created hook, then overwrites the password with the latest signup's and sends the confirmation again. A password reset depends on the version too: at v2.197.0 the reset link confirms an unconfirmed account and keeps its password, so the person's own "Glemt adgangskode?" would confirm the account with the stranger's password still on it; master clears an unconfirmed account's password before confirming it. The purge alone closes neither signup case. Under the first behaviour a stranger can register again right after each purge (one call a day per address), so a stranger's password sits on the account almost all the time; under the second the stranger signs up again between the person's own signup and confirmation. The trigger handles all of these: under the first behaviour the person's own signup sends the confirmation again; under the second the stranger's signup overwrites the password through `UpdatePassword`, which clears the earlier `confirmation_sent_at` in the same UPDATE; and the person's reset records a new `recovery_sent_at` before its link can confirm the account. Each of these UPDATEs empties the password (the one exception, master only, is an account never sent a confirmation: see the next point), and only the mailbox owner can then set one, through "Glemt adgangskode?" (GoTrue refuses a password sign-in against an empty hash: `400 invalid_credentials`, seen on the e2e project). The purge additionally frees addresses stuck on an unconfirmed account and bounds a stale pre-registration to 24 hours plus the wait for a run with room: at most 5 accounts per run (`MONITOR_UNCONFIRMED_PURGE_BATCH`), oldest first.
- Accepted costs and residuals of the trigger (`workers/monitor-cron/README.md`, "Accepted residuals"): a real person who signs up twice, or asks for the confirmation again, before confirming loses the password they chose. The confirmation link still signs them in on the Monitor host, but for later sign-ins they must set a password with "Glemt adgangskode?". A stranger can do the same to a pending account by signing up, asking for the confirmation, or asking for a password reset with its address. Recovery is unchanged (the newest link signs in, then "Glemt adgangskode?"); those sends count against the project's email rate limit. An admin password, email or phone change on an unconfirmed `monitor_user` account that already had a confirmation sent empties the password in that UPDATE, a password it sets included: set a password once the address is confirmed (an update that also sets `email_confirm` confirms the address first). Someone who, without signing up, clicks an unsolicited confirmation email for a stranger's pre-registration confirms an account with the stranger's password: the stranger can sign in to it (empty at first) until the password is reset. Under master's behaviour only, an unconfirmed `monitor_user` account that never had a confirmation sent (`confirmation_sent_at` NULL, e.g. an `admin.createUser` without a send) keeps a stranger's signup password (the overwrite goes from NULL to NULL, the send from NULL to now), and the mailbox owner's click on that confirmation confirms it. A password reset sent for such an account while it is still unconfirmed empties that password too, and the purge limits both to links clicked before it deletes the unconfirmed account (24 hours plus the wait for a run); bounded and of low value.
- Owner notice: at most 1 per run (`MONITOR_SIGNUP_NOTICE_PER_RUN`) and 10 per rolling 24 hours (`MONITOR_SIGNUP_NOTICE_DAILY_CAP`), oldest confirmation first, to the oldest `owner` profile's address, without any link (the new address is defanged in full). Only addresses confirmed under 23 hours ago qualify, so a retry with the same idempotency key stays inside Resend's documented 24-hour idempotency window (not verified by a test) and cannot send twice. Signups past the cap or the 23-hour window are **not emailed**: they stay visible in `public.profiles` with `signup_notified_at is null` (see "Signups without an owner notice").

## Before you start

Keep every secret in the shell, never in a file of the repo or in chat. `read -rs` keeps it out of the shell history:

```sh
export PROD_REF=xmgpixhxecamtryohgmk
export SUPABASE_URL="https://$PROD_REF.supabase.co"
read -rs SUPABASE_ACCESS_TOKEN && export SUPABASE_ACCESS_TOKEN   # Management API personal access token
read -rs SUPABASE_SECRET_KEY && export SUPABASE_SECRET_KEY       # the project's secret key (admin API, step 7)
```

Run the commands from the repo root (step 3 reads the templates from `supabase/templates/`). `jq` is needed.

## Ordered steps

| # | Owner | Step | Gate |
|---|---|---|---|
| 0a | VERIFY (Supabase) | Read the production auth config (commands below) | `hook_before_user_created_enabled=true` with uri `pg-functions://postgres/public/hook_before_user_created`; `disable_signup=true`; `mailer_autoconfirm=false`; `external_anonymous_users_enabled=false`; `external_phone_enabled=false`; every OAuth `external_*_enabled=false`; `smtp_host=smtp.resend.com`; `site_url=https://alnyron.dk`. Note `rate_limit_email_sent` and `uri_allow_list` |
| 0b | VERIFY (SQL) | Migrations 20261106000400, 20261107000300, 20261108000100 applied (**[Run B]** and 20261110000100 once Run B is deployed: step 2 applies it, with the wipe trigger on `auth.users`, enabled, on `confirmation_sent_at` and `recovery_sent_at`); the hook's body refuses allowlisted emails; grants | all true |
| 0c | VERIFY (SQL) | Squattable set: allowlisted emails without an account | empty, or known and cleaned up |
| 0d | VERIFY (Cloudflare) | `https://alnyron.dk/sitemap.xml` lists `https://alnyron.dk/...` URLs (proves the build's `NEXT_PUBLIC_SITE_URL`; were it `localhost`, the derived Monitor host would be `monitor.localhost`). No DNS record named `monitor` in the zone (a CNAME blocks Custom Domains). Resend domain `send.alnyron.dk` verified | ok |
| 1 | CODE | Feature-orchestrator TDD loop. **Run A** (this change: host routing, 308, confirm forward, recovery branch, absolute links, cron var, this runbook) and **Run B** (signup notice, unconfirmed purge, wipe trigger), each committed by the main session. **No push and no `npm run deploy` (not even a web-only one) from the first commit until steps 3 and 4 hold** | gates pass |
| 2 | CODE -> DB **[Run B]** | `npm run db:push` (Run B's additive migration 20261110000100; inert until the cron calls it, apart from the wipe trigger), then `npm run db:types`. Run A has no migration: with Run A alone this row is empty | the three signup functions exist; EXECUTE denied to `anon` and `authenticated`, granted to `service_role`; the wipe trigger exists on `auth.users`, is enabled (`tgenabled = 'O'`) and fires on `confirmation_sent_at` and `recovery_sent_at`, its function executable by none of `anon`, `authenticated` and `service_role` |
| 3 | SUPABASE (signup still OFF) | PATCH: `uri_allow_list` += exact `https://monitor.alnyron.dk` and exact `https://mylife.alnyron.dk`; `mailer_subjects_confirmation`; confirmation and recovery templates from the repo; `rate_limit_email_sent=10`. Must come **before** step 5, or Monitor resets lose their session on the main host | GET shows the values |
| 4 | CLOUDFLARE | Attach the custom domain `monitor.alnyron.dk` to the Worker `alnyron-web`. No `routes` key in either `wrangler.jsonc`. For a few minutes the subdomain serves the main site (old build); harmless | `curl -I https://monitor.alnyron.dk` -> 200 from the Worker, valid certificate |
| 5 | USER | Push. Workers Builds deploys the web Worker. Deploy the cron with `npm run deploy:monitor-cron` unless the build chains `npm run deploy` | new build live; the cron's `MONITOR_SITE_URL` shows the subdomain |
| 6 | VERIFY | Subdomain routing, 308s, links, owner sign-in and reset on the subdomain, cron log (checklist below) | all pass |
| 7 | VERIFY canary (signup OFF) | `generate_link` canaries: an allowlisted address is refused and creates no user; a non-allowlisted one becomes `monitor_user` and its main-host confirm link lands on the subdomain dashboard (**[Run B]** then the owner notice, `signupNotices: 1` in the cron log) | all pass |
| U1 | USER (before 8) | Cloudflare WAF rate-limit rule on `/signup` and `/monitor/signup`, after confirming the plan's one free rule slot is unused | rule active |
| U2 | USER (before 8) | Update the privacy page (Admin > Sider > Privatliv) for public Monitor accounts and that the owner is notified of each signup | page published |
| 8 | SUPABASE: **THE FLIP** | `PATCH {"disable_signup": false, "mailer_autoconfirm": false, "external_email_enabled": true, "external_anonymous_users_enabled": false, "external_phone_enabled": false}`, then GET | values confirmed |
| 9 | VERIFY | Real signup with a plus-address on the subdomain -> Resend log shows delivery -> link -> dashboard (-> owner notice **[Run B]**). One allowlist row for a new canary, kept until both checks ran: UI signup -> generic confirmation, no email; direct `POST /auth/v1/signup` with the publishable key -> `403` with the hook's `msg` "Kontoen kan ikke oprettes."; SQL: no `auth.users` or `profiles` row; then delete the row | all pass |
| R | Rollback | `PATCH {"disable_signup": true}` stops new signups at once; existing accounts keep working. The web rollback is the previous build (the 308 is cached at most one day) | — |

## Why the order matters

- **Signup on before the hook works = admin/MyLife account squatting.**
  1. A stranger calls `POST /auth/v1/signup` directly (the publishable key is public; the app is not needed) with an allowlisted address that has no account yet: between the onboarding runbook's allowlist insert and `admin.createUser`, or a stale allowlist row. The stranger picks the password.
  2. `private.handle_new_user` copies the allowlist role (owner, admin, mylife_user) onto that unconfirmed account.
  3. The real person later clicks a confirmation, invite or recovery link, which confirms the address.
  4. The stranger now signs in to `/admin` or MyLife with their own password.

  The allowlist sync guard (migration 0400) only covers the reverse order (an allowlist row added after the signup). Steps 0a-0c and 7 prove the hook is registered, refuses allowlisted addresses and that nothing is squattable, all **before** step 8.
- **`mailer_autoconfirm=true`** gives unverified accounts a session at once: bots, and anyone can open an account under someone else's address. Step 8 sets it to `false` explicitly.
- **Flipping before the confirmation template is set** (step 3) sends GoTrue's default `{{ .ConfirmationURL }}` link: users end up confirmed but not signed in, on GoTrue's own verify page.
- **Deploying (step 5) before the allow-list entry (step 3)**: a Monitor reset's `redirectTo` is dropped, the Site URL link lands the session on the main host, and `/monitor/reset` there redirects to the subdomain, where that session does not exist.
- **Deploying the 308 or the cron variable before the custom domain (step 4)** sends visitors and every email link to a host that does not answer.

## Known limitation: a Monitor account's reset asked on the main site

A `monitor_user` who asks for a password reset on the main site, on either of its forms (`https://alnyron.dk/admin/forgot-password` or `https://alnyron.dk/mylife/forgot-password`), gets the recovery template's Site URL link (`https://alnyron.dk/auth/confirm?...&type=recovery&next=/admin/set-password`; neither form sends a `redirectTo` on the main host). `/auth/confirm` verifies it on `alnyron.dk`, so the one-time token is spent and the session is set there, and lands the user on `/monitor/reset` by role. `alnyron.dk/monitor/reset` redirects (308) to `monitor.alnyron.dk/monitor/reset`, where that session does not exist: the user ends on the Monitor login with the old password still in force (and an unused session on `alnyron.dk`). A Monitor reset whose `redirectTo` GoTrue dropped ends the same way; step 3 prevents that one.

Workaround for the user: ask for the reset on `https://monitor.alnyron.dk/forgot-password` (the Monitor login's "Glemt adgangskode?" link), whose email links back to the Monitor host. Not changed in Run A.

## Step details

### 0a. Production auth config (VERIFY)

```sh
curl -sS "https://api.supabase.com/v1/projects/$PROD_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
| jq '{hook_before_user_created_enabled, hook_before_user_created_uri, disable_signup, mailer_autoconfirm,
       external_email_enabled, external_anonymous_users_enabled, external_phone_enabled,
       smtp_host, site_url, uri_allow_list, rate_limit_email_sent, mailer_subjects_confirmation}'

# Every provider switch: only external_email_enabled may be true.
curl -sS "https://api.supabase.com/v1/projects/$PROD_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
| jq 'with_entries(select(.key | test("^external_.*_enabled$"))) | with_entries(select(.value == true))'
```

The last command must print `{"external_email_enabled": true}` and nothing else.

### 0b. Migrations, hook body and grants (VERIFY, SQL editor)

```sql
select version from supabase_migrations.schema_migrations
 where version in ('20261106000400', '20261107000300', '20261108000100', '20261110000100')
 order by version;
-- 3 rows; 4 rows (20261110000100 too) once Run B's migration is applied (step 2) [Run B]

select t.tgenabled,
       array(select a.attname::text
               from unnest(t.tgattr) as k(attnum)
               join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k.attnum
              order by a.attname) as columns
  from pg_trigger t
 where t.tgrelid = 'auth.users'::regclass and t.tgname = 'monitor_wipe_password_on_resignup';
-- [Run B] 1 row: O (enabled), {confirmation_sent_at,recovery_sent_at}, once 20261110000100 is
--   applied; 0 rows before step 2

select pg_get_functiondef('public.hook_before_user_created(jsonb)'::regprocedure);
-- returns {"error": {"http_code": 403, ...}} when the email is in public.user_allowlist

select has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'execute') as auth_admin,
       has_function_privilege('anon', 'public.hook_before_user_created(jsonb)', 'execute') as anon,
       has_function_privilege('authenticated', 'public.hook_before_user_created(jsonb)', 'execute') as authenticated,
       has_table_privilege('supabase_auth_admin', 'public.user_allowlist', 'select') as reads_allowlist;
-- true, false, false, true
```

This also settles the onboarding runbook's prerequisite (`docs/runbooks/area-user-onboarding.md`): its steps need migration 0400 on the project.

If 20261107000300 (free cap 2) or 20261108000100 (the engine) is missing, Slice B's go-live is not done yet: finish it first (`workers/monitor-cron/README.md`, "Go-live"), then repeat this step.

**[Run B]** 20261110000100 (signup notice, purge and the wipe trigger) is needed only once Run B is deployed: before step 2 the queries return 3 rows and no trigger row, which is expected. Step 2 applies it, and it must be there before step 5 deploys a build with Run B: from then on every cron run calls its functions, and without them each run logs `rpcErrors`. From step 2 on, the trigger row must show `O` and both columns: no row, `D` (disabled), or a missing column leaves a pre-registered password in place (see "What Run B adds"), so stop and re-apply the migration before step 8.

### 0c. Squattable set (VERIFY, SQL editor)

```sql
select a.email
  from public.user_allowlist a
  left join auth.users u on lower(btrim(u.email)) = a.email
 where u.id is null;
```

Every row is an allowlisted address a stranger could sign up with if the hook failed. Empty, or each row known (an onboarding in progress) and finished or deleted before step 8.

### 0d. Site URL, DNS, Resend (VERIFY)

```sh
curl -sS https://alnyron.dk/sitemap.xml | grep -o '<loc>[^<]*</loc>' | head -3   # https://alnyron.dk/...
```

In the Cloudflare dashboard (zone alnyron.dk > DNS > Records): no record named `monitor`. In Resend: `send.alnyron.dk` verified.

### 1. Code (CODE)

Run A and Run B go through the normal loop (journey, red tests, implementation, review, security, e2e) and are committed separately by the main session. Nothing in either run touches production.

**From the moment Run A is committed, do not push or run `npm run deploy` until steps 3 and 4 hold.** Any deploy of that commit, even a routine web-only one, ships the main-host 308 (`alnyron.dk/monitor*` -> `monitor.alnyron.dk`, cached by browsers for a day), the absolute nav link and, through the chained `deploy:monitor-cron`, `MONITOR_SITE_URL=https://monitor.alnyron.dk`. Without the custom domain (step 4) all of them lead to a host that does not answer; without the allow-list entry (step 3) Monitor resets lose their session.

### 2. Run B's migration (CODE -> DB) [Run B]

```sh
npm run db:push
npm run db:types
```

`db push` needs the current database password (refresh it from the dashboard first). Without it, apply the migration file's SQL through the Management API (`POST https://api.supabase.com/v1/projects/$PROD_REF/database/query` with `Authorization: Bearer $SUPABASE_ACCESS_TOKEN`) and record it with `insert into supabase_migrations.schema_migrations (version, name) values ('<version>', '<name>')`, so the next `db push` sees no drift.

Then, in the SQL editor, check that the three functions exist and only `service_role` may execute them:

```sql
select p.oid::regprocedure as function,
       p.prosecdef as security_definer,
       pg_get_userbyid(p.proowner) as owner,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('monitor_engine_pending_signups', 'monitor_engine_mark_signup_notified',
                     'monitor_engine_purge_unconfirmed')
 order by p.proname;
-- 3 rows; anon false, authenticated false, service_role true on each;
-- security_definer true with owner postgres for pending_signups and purge_unconfirmed, false for mark_signup_notified
```

Then check that the wipe trigger is on `auth.users`, enabled, fires on `confirmation_sent_at` and `recovery_sent_at`, and that its function is a definer that neither `anon`, `authenticated` nor `service_role` may execute (EXECUTE is granted to no role):

```sql
select t.tgenabled,
       pg_get_triggerdef(t.oid) as definition,
       p.prosecdef as security_definer,
       pg_get_userbyid(p.proowner) as owner,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'auth.users'::regclass
   and t.tgname = 'monitor_wipe_password_on_resignup';
-- 1 row: O; CREATE TRIGGER monitor_wipe_password_on_resignup BEFORE UPDATE OF confirmation_sent_at, recovery_sent_at
--   ON auth.users FOR EACH ROW EXECUTE FUNCTION private.monitor_wipe_password_on_resignup(); true; postgres; false; false;
--   false
```

Fewer than 3 function rows, `anon` or `authenticated` true on any function, `service_role` false on any of the three functions or true on the trigger's function, or the trigger missing, not `O`, or not on both `confirmation_sent_at` and `recovery_sent_at`: stop, and do not deploy Run B (step 5) until it is fixed.

### 3. Allow-list, templates, email rate limit (SUPABASE, signup still off)

Build the body from the current allow-list and the repo's templates (keeps every existing entry, adds the two exact origins):

```sh
CURRENT_ALLOW_LIST=$(curl -sS "https://api.supabase.com/v1/projects/$PROD_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | jq -r '.uri_allow_list // ""')

jq -n \
  --arg current "$CURRENT_ALLOW_LIST" \
  --rawfile confirmation supabase/templates/confirmation.html \
  --rawfile recovery supabase/templates/recovery.html \
  '{
     uri_allow_list: ([$current | split(",")[] | gsub("^\\s+|\\s+$"; "") | select(length > 0)]
                      + ["https://mylife.alnyron.dk", "https://monitor.alnyron.dk"] | unique | join(",")),
     mailer_subjects_confirmation: "Bekræft din e-mail til Alnyron Monitor",
     mailer_templates_confirmation_content: $confirmation,
     mailer_templates_recovery_content: $recovery,
     rate_limit_email_sent: 10
   }' > monitor-go-live-patch.json
```

The body (`monitor-go-live-patch.json`, delete it afterwards):

```json
{
  "uri_allow_list": "<existing entries>,https://monitor.alnyron.dk,https://mylife.alnyron.dk",
  "mailer_subjects_confirmation": "Bekræft din e-mail til Alnyron Monitor",
  "mailer_templates_confirmation_content": "<supabase/templates/confirmation.html, verbatim>",
  "mailer_templates_recovery_content": "<supabase/templates/recovery.html, verbatim>",
  "rate_limit_email_sent": 10
}
```

- `https://monitor.alnyron.dk`: Monitor resets (`redirectTo`) keep their origin only with this exact entry.
- `https://mylife.alnyron.dk`: production has only `https://mylife.alnyron.dk/**`, which does not match the bare origin, so MyLife resets fall back to the Site URL link today. The exact entry fixes that latent bug in the same PATCH.
- `rate_limit_email_sent: 10`: auth emails per hour, project-wide (the default with custom SMTP is 30). It slows the burn of the shared Resend quota; it cannot guarantee the daily quota (see "Email quota").

```sh
curl -sS -X PATCH "https://api.supabase.com/v1/projects/$PROD_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data @monitor-go-live-patch.json > /dev/null
rm monitor-go-live-patch.json

curl -sS "https://api.supabase.com/v1/projects/$PROD_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
| jq '{uri_allow_list, mailer_subjects_confirmation, rate_limit_email_sent, disable_signup}'
```

`disable_signup` must still be `true`.

### 4. Custom domain (CLOUDFLARE)

Dashboard: Workers & Pages > `alnyron-web` > Settings > Domains & Routes > Add > Custom domain > `monitor.alnyron.dk` (as for `mylife.alnyron.dk`). Or the API: `PUT https://api.cloudflare.com/client/v4/accounts/<account id>/workers/domains` with `{"hostname": "monitor.alnyron.dk", "service": "alnyron-web", "environment": "production", "zone_id": "<alnyron.dk zone id>"}`. Cloudflare creates the DNS record and the certificate.

**Do not add a `routes` (or `route`) key to `wrangler.jsonc` or `workers/monitor-cron/wrangler.jsonc`.** Once a config has one, wrangler manages the Worker's routes and domains on every deploy and drops the ones attached in the dashboard (apex, www, mylife, monitor).

```sh
curl -sSI https://monitor.alnyron.dk | head -1   # HTTP/2 200, served by the Worker
```

### 5. Deploy (USER)

Push to the deploy branch: Workers Builds deploys `alnyron-web`. Deploy the cron with `npm run deploy:monitor-cron` unless the build already chains `npm run deploy` (which ends with it). In the cron's Settings > Variables, `MONITOR_SITE_URL` reads `https://monitor.alnyron.dk`.

### 6. Checklist on the live build (VERIFY)

- `https://monitor.alnyron.dk/` landing page; `/login`, `/signup`, `/forgot-password` load; `/dashboard` without a session -> `/monitor/login?next=/monitor/dashboard`; `/admin` and `/mylife` -> the Monitor login without a session, 404 once signed in.
- `curl -sSI https://monitor.alnyron.dk/login | grep -i x-robots-tag` -> `noindex, nofollow`.
- `curl -sSI https://alnyron.dk/monitor` -> `308`, `location: https://monitor.alnyron.dk/`, `cache-control: public, max-age=86400`; `https://alnyron.dk/monitor/login?next=/monitor/dashboard` -> 308 with the query kept.
- The ALNYRON lockup and the footer's "Privatliv" on the subdomain lead to `https://alnyron.dk` and `https://alnyron.dk/privacy`.
- The owner signs in on the subdomain. Owner reset from `https://monitor.alnyron.dk/forgot-password`: the real email's link points at `https://monitor.alnyron.dk/auth/confirm?...&next=/monitor/reset` and lands on `/monitor/reset` signed in.
- Cron log (Workers > `alnyron-monitor-cron` > Logs): no `rpcErrors`. **[Run B]** Each line also has the counters `purged`, `signupNotices` and `signupNoticesDeferred`. `signupNotices` and `signupNoticesDeferred` are 0 (signup is still off, and step 2 stamped every existing `monitor_user`). `purged` is 0, or above 0 (at most 5 per run) for the few runs that delete `monitor_user` accounts left unconfirmed for over 24 hours, if there are any. A line without these counters comes from a cron build without Run B.

### 7. Pre-flip canary with `generate_link` (VERIFY, signup still off)

`POST /auth/v1/admin/generate_link` ignores `disable_signup` but still runs the before-user-created hook, so it tests the hook on production before anyone can sign up.

**Allowlisted case.** Insert an allowlist row (SQL editor) for a new canary address, then try to create the user:

```sql
insert into public.user_allowlist (email, role) values ('hook-canary-<rand>@alnyron-test.local', 'mylife_user');
```

```sh
CANARY=hook-canary-<rand>@alnyron-test.local
jq -n --arg email "$CANARY" --arg pw "$(openssl rand -base64 24)" '{type: "signup", email: $email, password: $pw}' \
| curl -sS -w '\n%{http_code}\n' -X POST "$SUPABASE_URL/auth/v1/admin/generate_link" \
    -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
    -H "Content-Type: application/json" --data @-
```

Expect the hook's refusal: the body's `msg` is exactly `Kontoen kan ikke oprettes.` and the last line `403` (any other status or `msg` fails the step, whatever its class). Then, in the SQL editor:

```sql
select count(*) from auth.users where lower(email) = lower('<canary>');        -- 0
delete from public.user_allowlist where email = '<canary>';
```

**If a user was created: delete it, stop, and fix the hook before anything else.**

**Non-allowlisted case.** Same call with `monitor-canary-<rand>@alnyron-test.local` (no allowlist row) and keep the response:

- The user exists, unconfirmed; `public.profiles` shows `role = 'monitor_user'` and `monitor_limit = 2`.
- Optional **[Run B]**, before opening the link: repeat the same call once more for the same address (per the supabase/auth source, GoTrue ignores the body's password for the existing account, records a new confirmation and sets `confirmation_sent_at` again; no email is sent), then in the SQL editor `select encrypted_password = '' as wiped from auth.users where lower(email) = lower('<canary>');` -> `true` (the wipe trigger emptied the password; after the first call alone it is `false`). Use the **second** response's `properties.hashed_token` in the next step: the second call replaced the first token.
- Open `https://alnyron.dk/auth/confirm?token_hash=<properties.hashed_token>&type=signup&next=/monitor/dashboard` (the link the confirmation template sends; use `hashed_token`, not `action_link`). It is forwarded to `https://monitor.alnyron.dk/auth/confirm?...` and lands on `/monitor/dashboard` signed in; the session cookie exists only on `monitor.alnyron.dk`.
- **[Run B]** The owner's signup notice arrives within about two cron runs; the run that sends it logs `signupNotices: 1`.
- Delete the canary: Authentication > Users, or `DELETE $SUPABASE_URL/auth/v1/admin/users/<id>` with the same two headers.

**GoTrue version.** The onboarding gap in `docs/runbooks/area-user-onboarding.md` ("The gap between steps 3 and 4"), where a signup on an existing unconfirmed address skips the hook and leaves the account unchanged, is what the supabase/auth source does at v2.197.0, the version the e2e project reports (read in the source, not verified by a test; production's version is not verified). supabase/auth master (#2868 of 2026-11-03, reverted by #2912, re-landed by #2918 on 2026-11-09; read in the source, not verified on hosted) runs the hook first on such a signup, so an allowlisted address is refused, and overwrites an admitted account's password with the latest signup's through `UpdatePassword`, which sets `confirmation_sent_at` to NULL in the same UPDATE; **[Run B]** on a `monitor_user` account that already had a confirmation sent, the wipe trigger empties that password in that UPDATE, while one never sent a confirmation keeps it until a password reset is sent for it (see "What Run B adds"). When the project's GoTrue is upgraded (`GET $SUPABASE_URL/auth/v1/health` with the publishable key shows `version`), re-verify those onboarding-gap facts and SHIP-AC6g's expected `429` in `tests/e2e/monitor-ship-routing.spec.ts` (it may become the hook's `403`).

### U1. WAF rate-limit rule (USER, before step 8)

Server-side signups reach Supabase from the Worker's egress IP (end-user IPs are only passed on with a secret key, which the web app must never hold), so Supabase's per-IP limits cannot tell visitors apart, and a signup flood through the app can also rate-limit admin sign-ins. A Cloudflare WAF rate-limit rule in front of the Worker can:

- Security > WAF > Rate limiting rules: first confirm the Free plan's **one** rule slot is unused.
- Rule: URI path equals `/signup` or `/monitor/signup` (the form posts to the page's own path), counted per IP over 10 seconds (the Free plan's period), action Block. Free rules match on the path only.

### U2. Privacy page (USER, before step 8)

Before anyone can sign up, the privacy page (Admin > Sider > Privatliv) must cover public Monitor accounts (what is stored: email, monitored URLs and labels, change history) and that the owner is notified of each new signup **[Run B]**.

### 8. The flip (SUPABASE)

```sh
curl -sS -X PATCH "https://api.supabase.com/v1/projects/$PROD_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"disable_signup": false, "mailer_autoconfirm": false, "external_email_enabled": true,
           "external_anonymous_users_enabled": false, "external_phone_enabled": false}' > /dev/null

curl -sS "https://api.supabase.com/v1/projects/$PROD_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
| jq '{disable_signup, mailer_autoconfirm, external_email_enabled, external_anonymous_users_enabled, external_phone_enabled}'
```

### 9. After the flip (VERIFY)

- Real signup on `https://monitor.alnyron.dk/signup` with a plus-address of your own: the Resend log shows the delivery; the link lands on the subdomain dashboard; **[Run B]** the owner notice follows.
- Allowlisted canary: both checks below use one allowlist row for a **new** canary address (step 7 deleted its row) and run while the row exists; delete it only after the last check. Insert it (SQL editor):

  ```sql
  insert into public.user_allowlist (email, role) values ('hook-canary-<rand2>@alnyron-test.local', 'mylife_user');
  ```

  1. UI signup on `https://monitor.alnyron.dk/signup` with that address: the same generic "Tjek din e-mail" answer, and no email is sent.
  2. The direct path, which skips the app:

     ```sh
     CANARY=hook-canary-<rand2>@alnyron-test.local
     jq -n --arg email "$CANARY" --arg pw "$(openssl rand -base64 24)" '{email: $email, password: $pw}' \
     | curl -sS -w '\n%{http_code}\n' -X POST "$SUPABASE_URL/auth/v1/signup" \
         -H "apikey: <publishable key>" -H "Content-Type: application/json" --data @-
     ```

     Expect the body's `msg` to be exactly `Kontoen kan ikke oprettes.` and the last line `403`.
  3. No account came of either (SQL editor), then the row goes:

     ```sql
     select count(*) from auth.users where lower(email) = lower('<canary>');        -- 0
     select count(*) from public.profiles where lower(email) = lower('<canary>');   -- 0
     delete from public.user_allowlist where email = '<canary>';
     ```

  If any of the three fails: roll back (`disable_signup: true`, below) at once, delete any account the canary got, and fix the hook.

## Rollback

```sh
curl -sS -X PATCH "https://api.supabase.com/v1/projects/$PROD_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"disable_signup": true}' > /dev/null
```

New signups stop at once; existing accounts keep working. The web rollback is redeploying the previous build; browsers keep the 308 at most one day (`max-age=86400`). The allow-list entries, templates and rate limit of step 3 are safe to keep.

## Auth-email exhaustion

`rate_limit_email_sent=10` counts auth emails per hour for the whole project, and the WAF rule (U1) only sees the app's own `/signup` and `/monitor/signup`. A direct `POST $SUPABASE_URL/auth/v1/signup` with the publishable key (public by design) skips the app and the WAF, so about ten such calls an hour use up the limit. While it lasts no auth email goes out: confirmations, resets and invites alike, the owner's and admins' included.

- **Signal:** the project's Auth logs show `over_email_send_rate_limit`, and real signups or resets get no email.
- **Response:** `PATCH {"disable_signup": true}` (the command under Rollback); existing accounts keep working. Meanwhile give owner and admin access with `POST $SUPABASE_URL/auth/v1/admin/generate_link` (secret key, `type: "recovery"`), which returns the link instead of sending an email; build it from `properties.hashed_token` as in `docs/runbooks/area-user-onboarding.md` step 4. When the logs show the burst has subsided, switch signup back on with step 8's PATCH and GET.
- If `over_email_send_rate_limit` keeps appearing with signup off, the emails come from another public auth endpoint, which `disable_signup` does not stop.

## Signups without an owner notice [Run B]

The owner notice is a courtesy, not a log. A confirmed `monitor_user` account the cron did not notify within 23 hours of its confirmation (held back by the cap of 10 per 24 hours, by a send that stopped, by a missing `owner` profile, or by a cron that did not run) is never emailed later, but keeps `signup_notified_at` null. List them in the SQL editor:

```sql
select p.email, u.email_confirmed_at, p.created_at,
       u.email_confirmed_at <= now() - interval '23 hours' as never_notified
  from public.profiles p
  join auth.users u on u.id = p.user_id
 where p.role = 'monitor_user'
   and p.signup_notified_at is null
   and u.email_confirmed_at is not null
 order by u.email_confirmed_at;
-- never_notified false: still pending, a later run may notify it; true: no notice will come
```

Unconfirmed accounts are left out: they get no notice, and the purge deletes them 24 hours after signup (5 per run).

## Email quota (Resend Free)

- Confirmations, resets, invites, Monitor change and error emails and **[Run B]** signup notices all go through Resend (custom SMTP; Supabase's built-in mailer only delivers to team members) and share one quota.
- Resend Free: 100 emails a day (UTC day), 3,000 a month, 10 requests a second. That SMTP sends count against it is inferred, not documented.
- At the quota auth emails fail too, admin resets included, and the cron stops with `mailStop=quota`. `rate_limit_email_sent=10` slows the burn but cannot guarantee the daily quota.
- Launch on Free; upgrade to Resend Pro on the first quota hit.
