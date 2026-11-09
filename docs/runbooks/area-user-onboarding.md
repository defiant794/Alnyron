# Runbook: give someone admin or MyLife access

Admin and MyLife are invite-only. Since migration `supabase/migrations/20261106000400_monitor_public_signup.sql`, the Supabase before-user-created hook (`public.hook_before_user_created`) **refuses every allowlisted email** on every path that runs it, so a stranger cannot sign up first with an admin or MyLife address (public Monitor signups get the `monitor_user` role instead). Invites therefore no longer create the account; the account is created first, without the hook.

> **When this applies:** the steps below need migration 0400 on the project. Before production's public signup is switched on, `docs/runbooks/monitor-go-live.md` step 0b proves it is applied there (migration list, hook body, grants); the steps below also work on a project that still runs the old hook (only allowlisted emails admitted).

GoTrue facts this relies on: the hook runs on `/signup`, `/invite` and `/admin/generate_link` when they create a **new** user; it does **not** run on `POST /auth/v1/admin/users` (`admin.createUser`), and `generate_link({ type: "invite" })` for an **existing** unconfirmed user creates nobody, so the hook does not run either. The Supabase dashboard's "Invite user" button calls `/invite` for a new user and is therefore refused for an allowlisted address.

## Steps (owner, secret key)

All calls use the project's secret key (`SUPABASE_SECRET_KEY`) from a trusted machine; never put it in the app or a root `.env*` file.

1. **Check for a public Monitor account with that address.** In the SQL editor:

   ```sql
   select user_id, email, role from public.profiles where email = lower(btrim('person@example.dk'));
   ```

   If a row with `role = 'monitor_user'` exists, someone (maybe the person, maybe not) signed up for Monitor with that address. The allowlist sync refuses to elevate it: step 2 fails with `allowlist email belongs to a public monitor_user account; delete that account first`. Confirm with the person, then delete that account (Authentication > Users > delete, or `supabase.auth.admin.deleteUser(userId)`). Its monitors and change history are deleted with it.

2. **Allowlist the address** with the area's role (`admin` or `mylife_user`; `owner` only for a co-owner):

   ```sql
   insert into public.user_allowlist (email, role) values (lower(btrim('person@example.dk')), 'admin');
   ```

3. **Create the account** with the admin API (no hook; `private.handle_new_user` copies the allowlist role into `profiles`):

   ```ts
   const { data, error } = await supabase.auth.admin.createUser({ email: "person@example.dk" });
   ```

   or `POST {SUPABASE_URL}/auth/v1/admin/users` with body `{ "email": "person@example.dk" }`. Do not set a password or `email_confirm`: the invite link confirms the address and lets the person choose a password.

4. **Send the invite right away** for the existing, unconfirmed account (see "The gap between steps 3 and 4" below):

   ```ts
   const { data, error } = await supabase.auth.admin.generateLink({ type: "invite", email: "person@example.dk" });
   ```

   `generateLink` returns the link instead of emailing it. Build the link the DA invite template would send from `data.properties.hashed_token` (not `action_link`, which signs in through the URL fragment and never reaches `/auth/confirm`):
   - admin: `https://alnyron.dk/auth/confirm?token_hash=<hashed_token>&type=invite&next=/admin/set-password`
   - MyLife: `https://mylife.alnyron.dk/auth/confirm?token_hash=<hashed_token>&type=invite&next=/mylife/set-password`

   Send it to the person yourself. It works once and expires like the emailed invites. `/auth/confirm` lands the person on their area's set-password page by role.

5. **Check** that `public.profiles` shows the expected role for the new `user_id`.

## The gap between steps 3 and 4

From `admin.createUser` until the person accepts the invite, the account exists but is unconfirmed. With public signup on, someone may sign up for Monitor with that address in this gap. In the supabase/auth source at v2.197.0, the version the e2e project reports (not verified by a test; production's version is not verified), GoTrue then takes its existing-unconfirmed-user path, which skips the hook, but the stranger gains nothing: GoTrue leaves the account's password unchanged (an unknown random password: `admin.createUser` without a password stores a random hash, seen on the e2e project), the role stays the allowlist role, and the confirmation email goes to the real person. supabase/auth master (#2868 of 2026-11-03, reverted by #2912, re-landed by #2918 on 2026-11-09; read in the source, which version the hosted project runs is not verified) runs the before-user-created hook on such a signup too, so the hook refuses the allowlisted address (`403`) and the account stays unchanged.

If the real person clicks that confirmation, the link is pinned to Monitor: it lands them on `/monitor/no-access` on the Monitor host, with their own session. Their address is now confirmed, so the pending invite link may then fail. In that case send a **recovery** link instead:

```ts
const { data, error } = await supabase.auth.admin.generateLink({ type: "recovery", email: "person@example.dk" });
```

and build it from `data.properties.hashed_token` as in step 4, with `type=recovery`:
- admin: `https://alnyron.dk/auth/confirm?token_hash=<hashed_token>&type=recovery&next=/admin/set-password`
- MyLife: `https://mylife.alnyron.dk/auth/confirm?token_hash=<hashed_token>&type=recovery&next=/mylife/set-password`

Sending the invite (step 4) right after creating the account (step 3) keeps the gap short.

> **GoTrue upgrade:** the path that skips the hook, described above, is what the supabase/auth source does at v2.197.0, the version the e2e project reports (not verified by a test). supabase/auth master (#2868 of 2026-11-03, reverted by #2912, re-landed by #2918 on 2026-11-09; read in the source, which version the hosted project runs is not verified) runs the hook first on such a signup instead, so the allowlisted address is refused (`403`) and the account stays unchanged. When the project's GoTrue is upgraded, re-verify the facts in this section and SHIP-AC6g's expected `429` in `tests/e2e/monitor-ship-routing.spec.ts` (it may become the hook's `403`); see `docs/runbooks/monitor-go-live.md` step 7.

## Removing access

Delete the allowlist row (`delete from public.user_allowlist where email = ...`): the sync clears the account's role (the last owner cannot be removed). A `monitor_user` account is never changed by allowlist edits.

## Tests

`tests/e2e/fixtures/admin-auth-seed.ts` (`generateAuthLink`) and the MyLife invite seeds follow this runbook (allowlist row, `POST /auth/v1/admin/users`, then `generate_link` type `invite`).
