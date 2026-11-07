# Runbook: give someone admin or MyLife access

Admin and MyLife are invite-only. Since migration `supabase/migrations/20261106000400_monitor_public_signup.sql`, the Supabase before-user-created hook (`public.hook_before_user_created`) **refuses every allowlisted email** on every path that runs it, so a stranger cannot sign up first with an admin or MyLife address (public Monitor signups get the `monitor_user` role instead). Invites therefore no longer create the account; the account is created first, without the hook.

> **When this applies:** the steps below work once migration 0400 is applied to the project. Production gets it in slice C (together with switching public signup on). Until then production still runs the old hook (only allowlisted emails admitted), where the old "allowlist row, then invite" flow works; the steps below also work there.

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

4. **Send the invite** for the existing, unconfirmed account:

   ```ts
   const { data, error } = await supabase.auth.admin.generateLink({ type: "invite", email: "person@example.dk" });
   ```

   `generateLink` returns the link instead of emailing it. Build the link the DA invite template would send from `data.properties.hashed_token` (not `action_link`, which signs in through the URL fragment and never reaches `/auth/confirm`):
   - admin: `https://alnyron.dk/auth/confirm?token_hash=<hashed_token>&type=invite&next=/admin/set-password`
   - MyLife: `https://mylife.alnyron.dk/auth/confirm?token_hash=<hashed_token>&type=invite&next=/mylife/set-password`

   Send it to the person yourself. It works once and expires like the emailed invites. `/auth/confirm` lands the person on their area's set-password page by role.

5. **Check** that `public.profiles` shows the expected role for the new `user_id`.

## Removing access

Delete the allowlist row (`delete from public.user_allowlist where email = ...`): the sync clears the account's role (the last owner cannot be removed). A `monitor_user` account is never changed by allowlist edits.

## Tests

`tests/e2e/fixtures/admin-auth-seed.ts` (`generateAuthLink`) and the MyLife invite seeds follow this runbook (allowlist row, `POST /auth/v1/admin/users`, then `generate_link` type `invite`).
