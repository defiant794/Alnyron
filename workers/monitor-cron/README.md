# alnyron-monitor-cron

The Monitor engine: a Cloudflare Worker with only a `scheduled()` handler. Each cron run
(`run.ts`) emails pending change events, leases a batch of due monitors, fetches each page
(SSRF-checked on every hop, DNS answers included), records unchanged / baseline / changed /
error through the service-role-only `monitor_engine_*` functions (migration
`supabase/migrations/20261108000100_monitor_engine.sql`), and emails new changes and the first
"Vi kan ikke hente" of an error streak through Resend. It logs one JSON line per run
(`msg: "monitor-cron run"` plus counters; never a URL, address, page text or key).

Separate from the OpenNext web Worker so the Supabase secret key never ships in the public app.
Always pass `--config workers/monitor-cron/wrangler.jsonc`: without it, `wrangler deploy` hands
the root project to OpenNext.

| file | role |
|---|---|
| `wrangler.jsonc` | Worker config: cron trigger, vars, `alias` of `react` to `react-shim.ts` |
| `index.ts` | `scheduled()` entry: validates env, runs once |
| `env.ts` | zod schema of the Worker env (names failing keys, never values) |
| `rpc.ts` | typed wrappers of the five `monitor_engine_*` functions |
| `run.ts` | one engine run (email sweep, claim, checks, second sweep; subrequest budget) |

The pure parts live in `src/lib/monitor/` (`page-fetch`, `page-text`, `change-summary`,
`change-email`, `url-guard`) and `src/lib/email/resend.ts`; constants in `src/config/monitor.ts`.

## Build

```sh
npm run build:monitor-cron
```

Bundles without deploying (`wrangler deploy --dry-run`). Wrangler resolves the bundle path from
the config's directory, so the bundle lands in `workers/monitor-cron/.wrangler/monitor-cron/`
(git-ignored; only its README goes to the root `.wrangler/monitor-cron/`). CI runs it after
`cf:build`.

## Local run (e2e Supabase project only)

1. Copy `.dev.vars.example` to `workers/monitor-cron/.dev.vars` (git-ignored) and fill in the
   **isolated e2e project's** URL and secret key, and a Resend key. Never point a local run at
   production.
2. Start it and fire the cron by hand:

   ```sh
   npx wrangler dev --config workers/monitor-cron/wrangler.jsonc --test-scheduled
   curl "http://localhost:8787/cdn-cgi/local/scheduled"
   ```

The run log line shows in the wrangler output. `tests/integration/monitor-engine/engine-live.test.ts`
covers the same path against the e2e project with a capturing mailer:
`npm run test:integration:e2e-project -- tests/integration/monitor-engine/engine-live.test.ts`.

## Go-live (production)

In this order. `npm run deploy` deploys this Worker too (`deploy:monitor-cron` is chained at its
end), so steps 1–4 must be done **before the next `npm run deploy`**, even a routine web-only
one: from then on the cron runs every minute against production, and without the migration and
both secrets every run fails, and without the Monitor domain every email link is dead.

1. Apply the migration to production: `npm run db:push`, then regenerate types with
   `npm run db:types`.
2. Create a dedicated, revocable Supabase secret key named `monitor-cron` and store it:
   `npx wrangler secret put SUPABASE_SECRET_KEY --config workers/monitor-cron/wrangler.jsonc`
3. Create a Resend sending key restricted to `send.alnyron.dk` (already verified) and store it:
   `npx wrangler secret put RESEND_API_KEY --config workers/monitor-cron/wrangler.jsonc`
4. `MONITOR_SITE_URL` is `https://monitor.alnyron.dk` (`wrangler.jsonc`): every change email
   links `https://monitor.alnyron.dk/monitor/monitors/<id>`. Attach that custom domain to the web
   Worker first (`docs/runbooks/monitor-go-live.md` step 4), or the links lead to a dead host.
   Never add a `routes` key to either `wrangler.jsonc`: wrangler would then manage the zone's
   routes and drop the domains attached in the dashboard.
5. Deploy: `npm run deploy:monitor-cron`, or `npm run deploy` (web Worker, then this one).

## Plan profiles

The config is the Workers **Free** profile: cron every minute (`* * * * *`), 2 monitors per run
(`MONITOR_BATCH_SIZE`), 50 subrequests (`MONITOR_SUBREQUEST_LIMIT`), no `limits`. A large page can
exceed Free's 10 ms CPU per run (error 1102 in the Workers logs); results are saved per monitor
and the batch is checked in the claim's order, so only the monitor after that page (if any) loses
this run's check and waits for its next turn. The page's owner, and the owner of a monitor it left
unchecked, then have a strike, and every batch takes at most one monitor of all owners with
strikes, checked last: while its owner has strikes, the page's kills cost no other monitor its
check, and the monitor it left unchecked is never leased with it again while that monitor's owner
has strikes too; due with the page, it is checked no later than the page's second lease after the
kill (see "One slot for strikes per batch"). The slot drains one monitor of owners with strikes
per run (at most 1440 a day) when the owners without strikes leave room in the batch. An owner's
strike goes with a good check of theirs from a later run, unless one in an overlapping run
already repaid it (see "Behaviour worth knowing").

`MONITOR_SUBREQUEST_LIMIT` must be at least 17 (`MONITOR_MIN_RUN_SUBREQUESTS`): the pending-email
lookup and the claim, plus one check at its worst case of 15 subrequests (4 page requests with
2 DNS lookups each, snapshot, record, one email); a lower value fails every run's env check.

Cloudflare stops a cron run after 15 minutes. A run plans for at most 870 seconds of it
(`MONITOR_RUN_WALL_LIMIT_MS`, a 30-second margin) and counts every call at its whole timeout: a
page check 15 seconds (`MONITOR_FETCH_TIMEOUT_MS`), an email send 10 seconds
(`MONITOR_EMAIL_SEND_TIMEOUT_MS`), a database call 5 seconds (`MONITOR_RPC_TIMEOUT_MS`: every
Supabase request is aborted then and counts as a failed call). Run time is read from
`Date.now()`, which on Workers moves on only at I/O; the margin also covers the run's own CPU
time, at most 30 seconds on Paid (`cpu_ms`).

The claim asks for at most `MONITOR_BATCH_SIZE` monitors, no more than the subrequests left after
it can check at 15 each, and no more than can be checked by 870 seconds at 35 seconds each
(`MONITOR_CHECK_WALL_MS`: the page fetch, the error email sent during the check, the snapshot read
and the record) once the claim call itself has taken its 5 seconds: at most 24 per run, fewer
after a slow first email sweep. So a run never leases a monitor it cannot afford to check, its
error email included. A budget too small for the batch shrinks the claim (the run log then shows
`budgetStop: true` when that smaller claim came back full). The Free numbers never shrink it: 50
subrequests, minus the first email sweep's worst case of 5 (lookup + 2 emails × 2) and the claim,
leave 44, room for 2 checks; that sweep takes at most 35 seconds (lookup 5 + 2 × (send 10 + mark
5)), after which time would still allow 23.

An email send (either sweep) starts only while it and the call marking it emailed can both end by
870 seconds (15 seconds left), and the second sweep's lookup only while it and one email can
(20 seconds left). Like a send skipped for subrequests, that leaves the change event pending for
the next run and shows as `budgetStop: true`. An error notification is checked the same way before
its send, but the claim already reserved that time, so only a call that ran past its timeout can
make it skip one (the notification is then lost: it was claimed with the record).

Workers **Paid** profile, config only (no code change), at most 288 checks per hour:

- `"triggers": { "crons": ["*/5 * * * *"] }`
- `"limits": { "cpu_ms": 30000 }`
- vars `MONITOR_BATCH_SIZE` `"24"`, `MONITOR_SUBREQUEST_LIMIT` `"10000"` (Paid's per-invocation
  limit). 24 is the most checks the time limit lets one run lease ((870 − 5) / 35 seconds = 24.7):
  a run whose first sweep took at most 25 seconds claims 24, a larger batch is cut to 24, and a
  slower first sweep can shrink the claim further. The least subrequest limit that never shrinks
  a batch of 24 is 410: the first sweep's worst case of 49 (lookup + 24 emails × 2), the claim,
  and 24 checks × 15; a lower one can shrink it.

A Paid batch, too, takes at most one monitor of all owners with strikes: the slot drains one per
run (at most 288 a day) when the owners without strikes leave room, so the monitors one kill
leaves unchecked (at most the batch's 24) all get it within 24 runs, 2 hours, once due again,
unless older monitors of owners with strikes are waiting (see "Accepted residuals").

## Behaviour worth knowing

- A monitor is leased when claimed (`last_checked_at = now()`), and the run checks the batch
  strictly in the order the claim returned it: users without strikes first, then oldest
  `coalesce(last_checked_at, created_at)`, so a deleted and re-created monitor queues behind
  every overdue one; at most one monitor of all users with strikes comes last (see "One slot for
  strikes per batch"). A run claims only as many monitors as its remaining subrequests and run
  time can check at their worst case; if it dies early (CPU limit, crash), the monitors after
  the one it died on wait until they are due again.
- Provisional failure (per monitor): the claim also adds 1 to `consecutive_errors`; a successful
  check (unchanged, baseline, changed) resets it to 0, and a failed check leaves it (the error
  record adds nothing). A monitor the run never recorded (killed run, or a failed or timed-out
  RPC: a claim whose answer is lost may still have leased its monitors), or whose change the
  record refused (paused mid-check, or its stored hash moved), therefore keeps one failed check,
  which can start the backoff and, at the threshold, the panel's "Kunne ikke hentes". Neither
  budget ever leaves one: the claim reserves a worst-case check (15 subrequests, 35 seconds) for
  every monitor it leases, and no check is skipped for time. This backoff belongs to the monitor
  row, so a new URL or a deleted and re-created monitor starts it over.
- Strikes (per account, `public.monitor_engine_strikes`): the claim adds one to the owner of
  every monitor it leases and returns, per monitor, the owner's strikes from before the claim
  (`prior_strikes`): every strike present then, including those of an overlapping run's checks
  not recorded yet (Paid runs can overlap). Every record of a check takes that check's strike off
  again; a good one (applied `unchanged`, `baseline` or `changed`) takes off one more only when
  `prior_strikes` was above 0 (`p_repay`), repaying a strike left by a check that died before its
  record, or one of an overlapping run's unfinished checks. An error or a stale result takes off
  only its own (never below 0). Per check that is +1 when it dies, 0 for an error, a stale result
  or a good check of an owner without strikes, and −1 for a good check of an owner with strikes.
  A claim leases at most one monitor of all users with strikes, so a good check never repays a
  strike of its own claim: once a page has killed a run its owner keeps at least that check's
  strike, even when a good check of theirs was recorded earlier in the same run, unless a good
  check in an overlapping run, claimed while that page was being checked, already repaid it
  (which can leave the owner at 0). Users can neither read nor change the table; URL edits and
  deleting or re-creating monitors leave it. A record for a monitor deleted mid-check finds no
  owner, so that strike stays until a good check from a later claim repays it.
- One slot for strikes per batch: a claim takes at most one monitor of all users with strikes
  together, the oldest due one (`coalesce(last_checked_at, created_at)`, then id), and checks it
  after every monitor of the users without strikes, who get their normal share: it is the
  batch's last check. The slot is used only when the users without strikes leave room in the
  batch; when another run's claim holds that monitor, the batch takes none. A page whose owner
  has strikes is therefore checked last, and its further kills cost no other monitor its check.
  A kill while its owner had no strikes (the first, or one after a residual below) leaves the
  monitors after it in that batch unchecked: each keeps the claim's provisional failure and
  gives its owner a strike. Those monitors are never leased in one batch with the page while both
  owners have strikes, so its further kills cost them nothing; they are only delayed, at most one
  per batch. Each of them due with the page is checked no later than the page's second lease
  after the kill (each lease moves the page behind them in the queue) while the page's owner
  keeps strikes, unless another kill leaves it unchecked again. Hit once (its own page, or a
  monitor another page left unchecked), an account has no strike left after its next good check;
  an account whose checks keep dying gains a strike with each. While runs overlap, an account
  with a check the other run has not recorded yet counts as having strikes, so its other due
  monitors wait for the slot too (delayed only: no provisional failure, no strike).
- Accepted residuals, apart from the guarantees above:
  - Overlapping runs: once repaid, by a later or an overlapping run, the account's monitors are
    claimed in plain age order again, a page that killed a run included, until it kills again;
    that page then slows down only by its own backoff (`consecutive_errors`: +1 for every claim
    its run never records, reset by a good check, a URL edit or a re-created monitor). Each such
    kill costs every monitor checked after it in that batch its check (it waits until due again,
    its provisional failure kept until its next good check), the batch's monitor of an account
    with strikes included: at most one monitor per kill with Free's batch of 2. Nothing caps how
    often that repeats while overlapping runs keep repaying the page's strikes.
  - Drain rate: the one slot drains one monitor of users with strikes per run, at most 1440 a
    day on Free (a run a minute) and 288 a day on Paid (a run every 5 minutes). One kill on Paid
    leaves at most the 24 monitors of its batch unchecked (at most 24 accounts struck, the
    page's included); once due again they take the slot one per run, oldest first, so all of
    them within 24 runs (2 hours) when no older monitor of a user with strikes waits.
    That needs room, though: while the users without strikes fill every batch, monitors of users
    with strikes wait with no bound.
- A new URL starts over: editing it clears the stored hash and snapshot, `consecutive_errors`
  (a pending provisional failure included) and `error_notified_at`, so the next check takes a
  new baseline, a new error streak can notify, and a check of the old URL still in flight is
  dropped (its record no longer matches the URL; it still takes off its strike).
- Daily email cap: at most 10 monitor emails per user per rolling 24 hours
  (`MONITOR_DAILY_EMAIL_CAP`), change and error emails together, counted in
  `public.monitor_email_log`. Only the engine writes that log (a change email when its event is
  marked emailed, an error email when its notification is claimed, sent or not); users can
  neither read nor delete it, so deleting events or re-creating monitors does not reset the cap.
  Rows older than 48 hours are pruned by the engine.
- Change emails use the idempotency key `monitor-event/<event id>` and are only retried within
  23 hours of detection (inside Resend's 24-hour window); those over the cap show in the panel
  only.
- The error email is claimed in the database before it is sent: at most one per error streak,
  and a failed send is not retried. At the cap it is not claimed (`error_notified_at` stays
  empty), so a later failure of the same streak notifies once the window frees.
- Page text and URLs in emails are defanged (`hxxps://`, `example[.]com`, `user[at]host`), so no
  mail client turns them into links; the only link is the monitor's page on monitor.alnyron.dk. A dot
  between two digits (`1.299 kr.`, `08.11.2026`, `10.30`) stays, as no top-level domain is
  numeric. The defang runs in linear time, also on a 2048-character URL.
- DNS is checked right before each request, but the answer can change between the check and
  the fetch (DNS rebinding window): an accepted risk. IPv6 answers must be global unicast
  (`2000::/3`) outside its special-purpose blocks; IPv4-mapped, IPv4-translated and NAT64
  addresses are judged by their IPv4 address.
