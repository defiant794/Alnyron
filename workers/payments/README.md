# alnyron-payments

Stripe's webhook endpoint for Monitor subscriptions (payments slice 1c): a Cloudflare Worker with
only a `fetch()` handler, served on the custom domain `pay.alnyron.dk`. Stripe POSTs events to
`https://pay.alnyron.dk/webhook`; the Worker checks the signature, retrieves the subscription's
current state from Stripe and writes it through the two service-role-only functions of migration
`supabase/migrations/20261112000100_payments_foundation.sql`:
`payments_sync_subscription(p_event, p_subscription)` and
`payments_record_subscription_invoice(p_event, p_subscription, p_invoice)`. Its only other
database access is one read of `subscriptions` (a user's other entitling subscriptions), plus one
Supabase Auth lookup (whether a user's account exists, see Duplicate subscriptions). All
subscription rules (one effect per event id, older events and ended subscriptions left alone, the
billing customer link, the lapse pause of monitors over the cap) live in those functions.

Separate from the OpenNext web Worker so the Supabase secret key and the Stripe key never ship in
the public app. Always pass `--config workers/payments/wrangler.jsonc`: without it,
`wrangler deploy` hands the root project to OpenNext.

| file | role |
|---|---|
| `wrangler.jsonc` | Worker config: vars (`SUPABASE_URL`, `STRIPE_LIVEMODE`), no routes, no cron |
| `index.ts` | `fetch()` entry: 404 off `/webhook`, 405 for any method but POST, env check, handler |
| `env.ts` | zod/mini schema of the Worker env (names failing keys, never values) |
| `webhook.ts` | one delivery: size cap, signature, event shape, account, mode, the event's handler |
| `stripe-api.ts` | the five Stripe calls (retrieve, mark as duplicate, cancel subscription, list invoice payments, refund) |
| `rpc.ts` | the two writers, the `subscriptions` read and the Supabase Auth account lookup over supabase-js |

The pure parts live in `src/lib/payments/` (`stripe-signature.ts`: the signature check,
`webhook-mapping.ts`: Stripe objects to writer payloads, `stripe.ts`: the REST client shared with
the web app's Checkout); constants in `src/config/payments.ts`.

## What a delivery does

1. A `content-length` over 1 MiB (`PAYMENTS_WEBHOOK_MAX_BODY_BYTES`) is a 413 before reading; the
   body is read up to that size and a longer one is a 413 too.
2. `Stripe-Signature` check (`verifyStripeSignature`): HMAC-SHA256 of `<t>.<raw body>` keyed with
   the whole `whsec_…` secret, compared in constant time (`crypto.subtle.verify`); the signed time
   must be within 300 seconds of the Worker's clock, either way
   (`STRIPE_WEBHOOK_TOLERANCE_SECONDS`). A header with more than 8 `v1` signatures
   (`STRIPE_WEBHOOK_MAX_SIGNATURES`) is malformed before any HMAC is computed. Failure: 400
   `{"error":"invalid_signature"}`, nothing else is called.
3. The body must be an event (`evt_` id, type, Unix `created`, boolean `livemode`, object
   `data.object`), else 400 `{"error":"invalid_event"}`.
4. An event of a connected account (Stripe Connect: `account` set; `connect_event`), an event of
   the other mode (`livemode` ≠ `STRIPE_LIVEMODE`; `livemode_mismatch`) and an event type not
   listed below are answered 200 and ignored.
5. The event's handler. 200 `{"received":true}` when it is done, also when the event is ignored
   or rejected (retrying cannot change those); 500 `{"error":"unavailable"}` when Stripe, the
   database or Supabase Auth failed in a way a retry may fix (network, timeout, 429, 5xx, an
   unexpected answer) or a user's profile is missing (`missing_profile`), so Stripe delivers it
   again later.

### Events handled

The subscription's state is always retrieved from Stripe (`GET /v1/subscriptions/{id}`) when the
event is handled; the event's own copy is never trusted for it, so late or out-of-order deliveries
write the current state. A subscription Stripe does not know (404) is rejected
(`subscription_not_found`).

Every id taken from the event or a Stripe object must be its prefix (`sub_`, `in_`, `pi_`,
`cus_`, `evt_`) followed by letters and digits only (`SUB_ID_REGEX` … in `webhook-mapping.ts`),
checked before any Stripe call. A malformed event id makes the event an `invalid_event` (400);
a malformed session, subscription or invoice id is answered 200 and rejected (`invalid_session`,
`invalid_subscription`, `invalid_invoice`), never 500, so it is not mistaken for a failure a
retry may fix; a payment with a malformed payment intent id is not refunded. A subscription's
`latest_invoice` is read only by the duplicate rule below, so only that rule checks it: a sync
never fails on it.

| event | action |
|---|---|
| `checkout.session.completed` | only a `mode: subscription` session with `metadata.kind` `monitor_subscription` (else ignored); its `client_reference_id` must equal the `metadata.user_id` the web app set on both the session and the subscription (else rejected `user_mismatch`); then the subscription is synced |
| `customer.subscription.created` / `.updated` / `.deleted` | the subscription is synced |
| `invoice.payment_failed` | the invoice's subscription (`parent.subscription_details.subscription`) is synced with Stripe's status, e.g. `past_due`; an invoice without one is ignored |
| `invoice.paid` | the invoice is recorded (amounts in integer øre) with its subscription synced; an invoice without a subscription is ignored; when the subscription carries the duplicate mark, or gets it in that delivery, the invoice's paid payments are refunded (see Duplicate subscriptions). Both ids are checked first; the subscription is then retrieved before the rest of the invoice is checked, so an invoice or subscription the writers cannot take (rejected `invalid_invoice`, else `invalid_subscription`) still has its paid payments refunded when the subscription carries the mark |

The user always comes from server-set metadata (`metadata.user_id`, written by the web app's
Checkout), never from anything the customer typed; without it the database falls back to the
customer's linked user. A writer refusal (SQLSTATE 22023 `invalid_payload`, `unknown_plan`,
`unknown_user`, `customer_user_mismatch`) is answered 200 and logged as rejected with that code
(unless the duplicate rule then finishes the subscription, see below); any other database failure
is a 500.

### Duplicate subscriptions (parallel Checkouts)

A user who completes two Checkouts at once gets two subscriptions. After every successful write
of a subscription in an entitling status (`trialing`, `active`, `past_due`) that does not carry
the duplicate mark, the user's other entitling subscriptions are read from the database (at most
5, `PAYMENTS_MAX_DUPLICATE_CANDIDATES`, the oldest recorded first) and each is retrieved from
Stripe: only one that Stripe now shows as that subscription in an entitling status counts. Of
those and the event's own subscription, the one kept is the oldest (Stripe `created`, tie: the
smaller id) among those WITHOUT the duplicate mark; every other one is a duplicate and is
finished:

1. Mark: `POST /v1/subscriptions/{id}` with `metadata[duplicate_subscription]=true`
   (Idempotency-Key `dup-mark-<id>`), unless it already carries the mark.
2. Refund: every paid payment of its latest invoice, by the payment's `amount_paid`
   (`POST /v1/refunds`, `amount`, `reason=duplicate`, `metadata[reason]=duplicate_subscription`,
   `metadata[subscription]=<id>`, Idempotency-Key `dup-refund-<payment intent id>`).
3. Cancel at once: `DELETE /v1/subscriptions/{id}`,
   `cancellation_details[comment]=duplicate_subscription`.

Why this order: after a failure at any step the duplicate is still entitling and marked, so
Stripe's retry of the delivery finishes it; a marked subscription is never the one kept, so a
duplicate that may already be refunded cannot stay on as the user's subscription (e.g. when the
kept one lapses before the retry), and a marked entitling subscription is finished at its next
event, whatever the writer answers, even when the user has no other subscription; the rule never
looks at a canceled subscription again, so a refund planned after the cancel would be lost (only
an `invoice.paid` of a marked one refunds that invoice, see below).

- Payments not paid yet are never waited for: a payment of the latest invoice that is still
  `open` (or in any status but `paid`, e.g. a payment method that settles later) is not refunded,
  and the duplicate is canceled at once all the same. Canceling ends its billing, so no further
  invoice can follow (e.g. after an interval switch in the customer portal); a payment that still
  settles after the cancel is refunded by its `invoice.paid` (Event invoice refund, below).
- Marked subscription: one carrying the mark was found to be a duplicate before. While it is
  entitling, every handled event finishes it as above (the mark step skipped), after the writer,
  whatever it answered: written, `duplicate`, `stale`, or any refusal (`invalid_payload`,
  `unknown_plan`, `unknown_user`, `customer_user_mismatch`); only a database failure a retry may
  fix stops it (a 500 before any mark, refund or cancel). It is finished alone: the user's others
  are not read (each is handled at its own events), so it is logged
  `duplicate_subscription_canceled` with code `unrecordable_refunded` (no kept subscription is
  known) and the writer's `paused` (null after a refusal), or rejected `invalid_subscription` when
  its malformed `latest_invoice` left it alone.
- Event invoice refund: an `invoice.paid` of a subscription carrying the mark, in any status
  (canceled included), or getting it in that delivery (the duplicate rule, the
  `customer_user_mismatch` path or the `unknown_user` path below finished it), refunds every paid
  payment of that event's invoice the same way (by `amount_paid`, Idempotency-Key
  `dup-refund-<payment intent id>`, `charge_already_refunded` counts as done), after the writer,
  whatever it answered (a database failure a retry may fix is a 500 before any refund). When the
  subscription was finished in that delivery, its latest invoice is refunded already: this
  invoice is refunded only when it is not the latest (an invoice is never listed twice), also
  when a malformed `latest_invoice` left a marked one alone, and the event is logged like the
  finish (e.g. `duplicate_subscription_canceled`). So an older invoice of a duplicate first found
  at that invoice's `invoice.paid` is refunded too. Otherwise (a marked subscription that is no
  longer entitling) the event is logged `duplicate_invoice_refunded` (code null, the writer's
  `paused`, null after a refusal); when the invoice has no paid payment, the writer's outcome
  stands. An unmarked duplicate left alone for a malformed `latest_invoice` gets no mark, so its
  invoice is not refunded.
- The event invoice refund does not depend on the invoice or the subscription being recordable:
  the subscription is retrieved before the invoice is checked beyond its id. When the writers
  cannot take the invoice or the subscription (rejected `invalid_invoice`, checked first, else
  `invalid_subscription`, without a write), and Stripe returned that very subscription (its `id`
  is the invoice's subscription) carrying the mark, the invoice's paid payments are refunded the
  same way and the event is logged `duplicate_invoice_refunded` with that code and `paused` null
  (the rejection stands when the invoice has no paid payment). This is a safeguard: with the
  pinned API version and subscriptions made by the web app's Checkout, neither is expected to
  happen.
- When the second Checkout made a second Stripe customer, the database refuses it
  (`customer_user_mismatch`): it can never be recorded for this user, so when it is entitling it
  is always finished the same way, whatever else the user has. For one without the mark, the
  user's other subscriptions (read and retrieved as above) only set the log code: null when one
  of them is live and unmarked, else `unrecordable_refunded` (the customer is refunded and left
  without a subscription); a marked one is finished like any marked one (above). A refused
  subscription that is not entitling stays rejected `customer_user_mismatch`.
- When the database refuses an entitling subscription without the mark as `unknown_user` although
  its `metadata.user_id` (set by the web app's Checkout) names a user, the database has no
  profile for that user. Whether the account still exists is checked, not assumed: the Worker
  asks Supabase Auth (`GET /auth/v1/admin/users/{id}` with the same secret key, one attempt,
  bounded by `PAYMENTS_RPC_TIMEOUT_MS` like the database calls).
  - Auth answers 404 `user_not_found` (for example, the account was deleted after its Checkout,
    before the subscription was recorded): it can never be recorded, so it is finished the same
    way, alone, without reading other subscriptions (there is no user to read them for), and
    logged `duplicate_subscription_canceled` with code `unrecordable_refunded` and `paused` null.
  - Auth returns the account: its `profiles` row is missing, a database inconsistency an
    operator must fix (see Operations). Nothing is done in Stripe: the delivery is answered 500
    and logged `error` with code `missing_profile`, so Stripe delivers it again, and once the
    profile is restored the retry records the subscription normally.
  - Any other answer or failure (network, timeout, 5xx, 401/403, an unexpected answer) is a 500
    (`rpc_…`) and nothing else is done.

  One whose malformed `latest_invoice` leaves it alone is not finished whatever Auth would
  answer, so Auth is not asked: rejected `invalid_subscription`. An `unknown_user` refusal of one
  without `metadata.user_id` (no app metadata: not a subscription the web app's Checkout made) or
  of one that is not entitling, and the `unknown_plan` and `invalid_payload` refusals, stay
  rejected with their code.
- The check also runs when the event was a duplicate or stale: an earlier delivery may have been
  written and then failed before its Stripe calls.
- Retries: the mark and the refund carry an Idempotency-Key, so a retried delivery gets the first
  request's result; a refund Stripe reports as `charge_already_refunded` counts as done. The
  cancel carries none: Stripe ignores Idempotency-Key on `DELETE` requests (per its
  idempotent-requests docs). If Stripe refuses a repeated cancel with a 4xx, that refusal, like
  any 4xx answer to the cancel, counts as done when the subscription, retrieved again, shows
  `canceled`.
- A duplicate without a latest invoice is marked and canceled without a refund. One whose
  `latest_invoice` is present but malformed (neither an `in_` id nor an expanded invoice with one)
  is neither marked, refunded nor canceled: the event is answered 200 and logged as rejected
  `invalid_subscription` (also when other duplicates were finished), and the database write
  stands. A payment that is not a payment intent, or whose payment intent id or `amount_paid` (a
  positive whole number of øre) is malformed, is not refunded.
- Bound (Workers Free allows 50 subrequests per request, per Cloudflare's limits): 3 (the event's
  subscription, the writer, the read), at most 5 retrieves, per finished duplicate a mark
  (unless it already carries it), a payments list, one refund per paid payment, a cancel and a
  re-retrieve after a refused cancel, and on `invoice.paid` of a subscription carrying the mark
  by then a payments list and its refunds for that invoice (none when its finish refunded it as
  the latest). With one paid payment each: the event's subscription, unmarked, is itself a
  candidate to keep, so one is always kept and at most 5 are finished, 3 + 5 + 5 × 5 = 33; when
  the event's own subscription is one of them, its `invoice.paid` adds 2: at most 35. A marked
  event subscription is finished alone, without the read or a mark: 6 (8 on `invoice.paid`). An
  unmarked one refused `unknown_user` while its `metadata.user_id` names a user is finished
  alone too, after the Auth lookup but without the read: 8 (10 on `invoice.paid`). A
  `customer_user_mismatch` delivery finishes only its own subscription: at most 13 (15 on
  `invoice.paid`); a marked subscription that is not entitling costs 4 on `invoice.paid`; an
  `invoice.paid` whose invoice or subscription cannot be recorded costs the retrieve and, for a
  marked subscription, a payments list and its refunds (3), without the writer. A user with more
  entitling subscriptions is handled over several deliveries: a canceled one leaves the set.
- Limitation: a finish refunds only the duplicate's latest invoice (a duplicate is caught at its
  first event, so normally that is its only invoice); any other payment of a marked subscription
  is refunded per `invoice.paid`, when that invoice gets paid (or, when that `invoice.paid` is
  the event that finishes it, in the same delivery). Open invoices are left to Stripe:
  per Stripe's docs (cancel-subscription API reference), canceling at once means the customer is
  not charged again for the subscription, and by default Stripe then stops the automatic
  collection of the customer's finalized invoices.

**Metadata belongs to the app.** The subscription metadata keys `kind`, `user_id` and
`duplicate_subscription` are set only by the web app's Checkout and by this Worker: never set,
edit or copy them by hand (Dashboard, API or a script). A hand-set `duplicate_subscription` mark
makes the subscription's next event refund and cancel it, even when it is the user's only one;
editing `user_id` on a live subscription can make the database refuse it as
`customer_user_mismatch` (or, when it names a user that has no account, as `unknown_user`), which
refunds and cancels it too.

### The log line

Every delivery that passes the size cap logs exactly one JSON line:

```json
{"msg":"payments webhook","event":"evt_…","type":"invoice.paid","outcome":"applied","code":null,"paused":0}
```

- `outcome`: `applied`, `duplicate` (event id seen before), `stale` (older than the stored state,
  or the subscription has ended), `ignored`, `rejected`, `duplicate_subscription_canceled`,
  `duplicate_invoice_refunded`, `invalid_signature` (then only `reason`: `missing_header`,
  `malformed_header`, `stale_timestamp`, `no_signature_match`), `invalid_event`, `error`
  (answered 500).
- `code`: why it was ignored or rejected (`connect_event`, `livemode_mismatch`, `unhandled_type`,
  `not_monitor_subscription`, `not_subscription_invoice`, `invalid_session`, `user_mismatch`,
  `subscription_not_found`, `invalid_subscription`, `invalid_invoice`, or the writer's refusal);
  for `duplicate_subscription_canceled` null, or `unrecordable_refunded` when no live subscription
  the user keeps is known (none, a marked subscription finished without reading the others, or
  one whose `metadata.user_id` names a user Supabase Auth has no account for); for
  `duplicate_invoice_refunded` null, or `invalid_invoice` / `invalid_subscription` when the
  invoice or the subscription could not be recorded (refunded without a write); for `error` the
  failed call: `stripe_network`, `stripe_invalid_response`, `stripe_http_<status>`,
  `rpc_<code>[_<status>]` (PostgREST/Postgres or Supabase Auth code and HTTP status),
  `rpc_failed`, or `unexpected` (a defect); `missing_profile` when Supabase Auth has the account
  of a user the database refused as `unknown_user` (see Operations).
- `paused`: how many monitors the writer's lapse pause paused.

Never a header, body, key, secret, email, user id or customer id.

### Operations

- `"code":"missing_profile"` in the logs: an account exists in Supabase Auth without its
  `public.profiles` row, so the database refuses the user's subscription (`unknown_user`).
  Restore the user's `profiles` row; Stripe's next delivery of the event then records the
  subscription normally (within Stripe's automatic retries, below; after them, resend the event).
  Never delete a `profiles` row by hand: the user's subscription events then fail until it is
  back.
- Stripe retries a delivery answered 500: per Stripe's webhook docs (2026-11), for up to three
  days with exponential back-off in live mode. After that, or for events that were due while the
  endpoint was disabled, resend the event from the Dashboard (Resend on the event, up to 15 days
  after it was created) or with the Stripe CLI (`stripe events resend <event id>
  --webhook-endpoint=<endpoint id>`, up to 30 days), per the same docs.

## Build

```sh
npm run build:payments
```

Bundles without deploying (`wrangler deploy --dry-run`). Wrangler resolves the bundle path from
the config's directory, so the bundle lands in `workers/payments/.wrangler/payments/`
(git-ignored).

## Local run (e2e Supabase project, Stripe test mode)

1. Copy `.dev.vars.example` to `workers/payments/.dev.vars` (git-ignored) and fill in the
   **isolated e2e project's** URL and secret key (`sb_secret_…`), a Stripe **test** key
   (`sk_test_…` or `rk_test_…`) and `STRIPE_LIVEMODE=false`. Never point a local run at
   production or at live mode.
2. Start the Worker, then forward test-mode events to it with the Stripe CLI, which prints the
   `whsec_…` to put into `.dev.vars` as `STRIPE_WEBHOOK_SECRET` (restart the Worker after):

   ```sh
   npx wrangler dev --config workers/payments/wrangler.jsonc
   stripe listen --forward-to localhost:8787/webhook
   ```

   API version: the Worker's own Stripe calls pin `2026-10-28.endive`, but the events
   `stripe listen` forwards are, per the Stripe CLI docs, formatted in the account's default API
   version, or in the latest one with `--latest` (no other choice). The handler reads some fields
   from the event itself (an invoice's `parent.subscription_details.subscription`, its amounts and
   lines) at their pinned-version paths; per Stripe's changelog, an invoice has `parent` only from
   API version `2025-03-31.basil` on, so with an older account default an `invoice.paid` is
   ignored as `not_subscription_invoice`. Check the account's default API version in the
   Dashboard, or use `--latest` when the latest version is the pinned one.
3. `stripe listen` forwards the test-mode events of the whole Stripe account (per the Stripe CLI
   docs, all events unless `--events` filters them), not only the ones of the local run: run it
   only while the test Checkouts in that account write to the database the Worker uses (the e2e
   project). A subscription whose user that database does not know is refused `unknown_user`,
   and when that project's Supabase Auth has no such account either, the Worker refunds and
   cancels it (`unrecordable_refunded`).

`tests/integration/payments/webhook-worker-live.test.ts` covers the same path in local workerd
against the e2e project and Stripe test mode with synthetically signed events:
`npm run test:integration:e2e-project -- tests/integration/payments/webhook-worker-live.test.ts`.
No test covers a real Stripe → Worker delivery: that needs the deployed endpoint.

## Go-live (production)

The Worker is not part of `npm run deploy`; it ships by hand, once, in this order.

1. Migration 20261112000100 and the live plans must be in production (slice 1a/1b go-live).
2. Store the secrets (paste bare values at the prompt, no quotes, spaces or line break; the env
   check refuses anything else):
   - `npx wrangler secret put SUPABASE_SECRET_KEY --config workers/payments/wrangler.jsonc`: a
     dedicated, revocable production secret key (`sb_secret_…`, service_role). Only this Worker
     and monitor-cron hold one.
   - `npx wrangler secret put STRIPE_PAYMENTS_KEY --config workers/payments/wrangler.jsonc`: a
     **restricted** live key (`rk_live_…`; a full `sk_live_` key is refused) with only these
     permissions, named as the Stripe Dashboard's restricted-key editor shows them (check there
     when creating the key): Subscriptions **Write** (retrieve, the duplicate mark, cancel),
     Invoices **Read** (per Stripe's permissions reference it also covers `/v1/invoice_payments`),
     and the permission to create refunds as the Dashboard labels it (Refunds or Charges
     **Write**; verify when creating the key). A missing permission makes Stripe answer 403 (per
     Stripe's restricted-key docs), which the Worker treats like any failure a retry may fix: 500,
     Stripe delivers again, and the endpoint's event log shows failing deliveries until the key is
     fixed.
   - `npx wrangler secret put STRIPE_WEBHOOK_SECRET --config workers/payments/wrangler.jsonc`: the
     signing secret of the Dashboard endpoint from step 4 (step 4 creates it; store it before the
     first delivery: while any of the three secrets is missing or malformed, the env check answers
     every delivery 500 `{"error":"unavailable"}`, which Stripe retries).
3. Deploy: `npm run deploy:payments`, then attach the custom domain `pay.alnyron.dk` to
   `alnyron-payments` in the Cloudflare dashboard (Workers & Pages > alnyron-payments > Settings >
   Domains & Routes > Add > Custom Domain). Never add a `routes` key to `wrangler.jsonc`: per
   Cloudflare's docs (Wrangler configuration > Source of truth), a deploy replaces routes changed
   in the dashboard with the config's routes, so wrangler could then manage the zone's routes and
   drop the domain attached in the dashboard.
4. Stripe Dashboard (live mode) > Developers > Webhooks: add the endpoint
   `https://pay.alnyron.dk/webhook` listening to events from **Your account** only (not connected
   accounts; per Stripe's docs that is the endpoint's choice of event source; the Worker ignores a
   Connect event anyway, `connect_event`), with API version `2026-10-28.endive` and exactly these
   events: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`. Copy its signing secret into step 2's `STRIPE_WEBHOOK_SECRET`.
5. Stripe Dashboard > Settings > Checkout and Payment Links
   (`https://dashboard.stripe.com/settings/checkout#subscriptions`): turn on "Limit customers to
   one subscription" (Stripe's own guard: a customer who already has an active subscription is
   sent to manage it instead of paying again; the duplicate rule above still covers what gets
   through). Per Stripe's docs (2026-11): redirecting to the customer portal needs the no-code
   customer portal activated with its login link enabled (disabling the link turns the limit off),
   and Stripe detects an existing subscription by the Checkout Session's customer when one is
   given, else by the email address. Check the setting's current name and requirements there.
6. Cloudflare WAF / Bot Fight Mode on the alnyron.dk zone: Stripe's deliveries are server-to-server
   requests with no browser, sent from the IP addresses Stripe publishes for webhooks
   (`https://stripe.com/files/ips/ips_webhooks.json`, per Stripe's docs, which also name the API
   announce mailing list for changes to them). Scope every exception to that list: a WAF custom
   rule that skips the features challenging or blocking the deliveries only for requests to
   `pay.alnyron.dk/webhook` from those IP addresses, a rule that blocks every other request to
   `/webhook` (so a flood is stopped before the Worker and does not use up its Workers Free daily
   requests), and optionally a rate-limiting rule on the path. Per Cloudflare's docs, which rule
   types and how many the zone's plan includes, and whether Bot Fight Mode can be skipped per
   path, depend on the plan: check them at go-live. The Worker itself trusts only the signature.
7. Check the first deliveries in the endpoint's event log in the Stripe Dashboard (answered 200)
   and their log lines (Workers > alnyron-payments > Logs). An event of the other mode is answered
   200 and logged `"outcome":"ignored","code":"livemode_mismatch"`. After the first live
   subscription (e.g. a purchase of your own), require its first events to log
   `"outcome":"applied"`. `unrecordable_refunded` (or `missing_profile`) on a NEW customer means
   the Worker's `SUPABASE_URL` or `SUPABASE_SECRET_KEY` points at another Supabase project than
   the web app's (or accounts were lost): an `unrecordable_refunded` subscription was refunded and
   canceled, which cannot be undone, and every new customer's would be. Disable the endpoint in the
   Stripe Dashboard at once and fix the configuration. Per Stripe's webhook docs, an event whose
   retry falls while the endpoint is disabled is not retried (e.g. the `missing_profile` 500s):
   resend those by hand after re-enabling it (see Operations).

Statements about Stripe, Supabase and Cloudflare dashboards, behaviour, permissions and plan
features reflect their documentation as of 2026-11 and may have changed; check them at go-live.
