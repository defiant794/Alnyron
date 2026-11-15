# alnyron-payments

Stripe's webhook endpoint for Monitor subscriptions (payments slice 1c), the right of
withdrawal (fortrydelsesret, slice 1d) and goods orders (physical 3D figures, slice S2, see
Ordrer): a Cloudflare Worker served on the custom domain
`pay.alnyron.dk`. Stripe POSTs events to `https://pay.alnyron.dk/webhook`; the Worker checks the
signature, retrieves the subscription's current state from Stripe and writes it through the two
service-role-only functions of migration
`supabase/migrations/20261112000100_payments_foundation.sql`:
`payments_sync_subscription(p_event, p_subscription)` and
`payments_record_subscription_invoice(p_event, p_subscription, p_invoice)`. Its only other
webhook database access is one read of `subscriptions` (a user's other entitling subscriptions),
one Supabase Auth lookup (whether a user's account exists, see Duplicate subscriptions) and the
Checkout consent (see Fortrydelse). All subscription rules (one effect per event id, older events
and ended subscriptions left alone, the billing customer link, the lapse pause of monitors over
the cap) live in those functions.

Besides `fetch`, the Worker exports the named entrypoints `WithdrawalService` and
`OrderService`, which the web app calls over its service bindings `PAYMENTS` and `ORDERS` (never
over a route), and a `scheduled` handler, the hourly sweep (cron `0 * * * *`); see Fortrydelse
and Ordrer. Their rules live in migrations
`supabase/migrations/20261114000300_payments_withdrawal.sql` and
`supabase/migrations/20261114000400_payments_goods_orders.sql`.

Separate from the OpenNext web Worker so the Supabase secret key, the Stripe key and the Resend
key never ship in the public app. Always pass `--config workers/payments/wrangler.jsonc`:
without it, `wrangler deploy` hands the root project to OpenNext.

| file | role |
|---|---|
| `wrangler.jsonc` | Worker config: vars (`SUPABASE_URL`, `STRIPE_LIVEMODE`, `MAIL_FROM`, `WITHDRAWAL_ALERT_TO`, `SITE_URL`, `ORDER_NOTIFY_TO`, `STRIPE_TAX_RATE_ID`), the hourly cron, no routes |
| `index.ts` | `fetch()` entry: 404 off `/webhook`, 405 for any method but POST, env check, handler; `scheduled()`: the sweep; re-exports `WithdrawalService` and `OrderService` |
| `env.ts` | zod/mini schema of the Worker env (names failing keys, never values) |
| `webhook.ts` | one delivery: size cap, signature, event shape, account, mode, the event's handler, the Checkout consent |
| `withdrawal-service.ts` | `WithdrawalService.withdraw`: token → user, begin, one pass |
| `withdrawal.ts` | `processWithdrawal`: one pass over a withdrawal (cancel, credit note, receipt, owner alert) |
| `sweep.ts` | `runSweep`: the hourly sweep within its subrequest budget |
| `consent.ts` | the order confirmation of a recorded consent (send + stamp), shared by webhook and sweep |
| `mail.ts` | the three Resend emails (order confirmation, receipt, owner alert) and `sendMail`, the Resend send both mailers share |
| `deps.ts`, `refusal.ts`, `cloudflare-workers.d.ts` | the clients built from the env; the P0001 refusal check; the hand-typed `cloudflare:workers` module |
| `stripe-api.ts` | the Stripe calls: the webhook's five (retrieve, mark as duplicate, cancel subscription, list invoice payments, refund) and the withdrawal's four (cancel, list invoices, list credit notes, create credit note) |
| `rpc.ts` | the writers, the `subscriptions` read and the Supabase Auth lookups (account exists, account email, token user) over supabase-js |
| `orders/env.ts` | goods (slice S2): `parseOrdersEnv` (`ORDER_LINK_SECRET`, `ORDER_NOTIFY_TO`, `STRIPE_TAX_RATE_ID`), apart from `env.ts` |
| `orders/service.ts` | `OrderService` (startCheckout, withdraw, markShipped, approveRefund), see Ordrer |
| `orders/webhook.ts` | the goods events: a goods Checkout completed, `charge.refunded`, `payment_intent.canceled` |
| `orders/withdrawal.ts` | `processOrderRefund`: one pass over an approved goods withdrawal (refund or release, credit note email) |
| `orders/sweep.ts` | `runOrderPass`: the sweep's goods pass |
| `orders/stripe.ts`, `orders/rpc.ts`, `orders/mail.ts`, `orders/deliver.ts`, `orders/deps.ts` | the goods Stripe calls (Checkout, payment intent read, capture, cancel, refund), the goods writers and reads, the goods emails, send + stamp, the goods clients |

The pure parts live in `src/lib/payments/` (`stripe-signature.ts`: the signature check,
`webhook-mapping.ts`: Stripe objects to writer payloads, `stripe.ts`: the REST client shared with
the web app's Checkout; `orders/`: the goods session normalizer, Checkout parameters, link token,
refund math, emails and the OrderService contract); constants in `src/config/payments.ts`, goods
texts in `src/config/legal/goods-texts.ts`.

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
| `checkout.session.completed` | only a `mode: subscription` session with `metadata.kind` `monitor_subscription` (else ignored); its `client_reference_id` must equal the `metadata.user_id` the web app set on both the session and the subscription (else rejected `user_mismatch`); then the subscription is synced, and unless the writer refused it, the session's consent is recorded and the order confirmation sent (see Fortrydelse) |
| `customer.subscription.created` / `.updated` / `.deleted` | the subscription is synced |
| `invoice.payment_failed` | the invoice's subscription (`parent.subscription_details.subscription`) is synced with Stripe's status, e.g. `past_due`; an invoice without one is ignored |
| `invoice.paid` | the invoice is recorded (amounts in integer øre) with its subscription synced; an invoice without a subscription is ignored; when the subscription carries the duplicate mark, or gets it in that delivery, the invoice's paid payments are refunded (see Duplicate subscriptions). Both ids are checked first; the subscription is then retrieved before the rest of the invoice is checked, so an invoice or subscription the writers cannot take (rejected `invalid_invoice`, else `invalid_subscription`) still has its paid payments refunded when the subscription carries the mark |
| `checkout.session.completed` / `checkout.session.async_payment_succeeded` of a goods session | a `mode: payment` session with `metadata.kind` `goods_order` goes to the goods branch (see Ordrer), never to a subscription writer; any other `async_payment_succeeded` is ignored (`not_goods_order`) |
| `charge.refunded` | goods: the charge's cumulative `amount_refunded` is synced onto its order (`payments_sync_order_refund`, never lowered, bounded by the captured amount); a charge of no goods order (a subscription's) is ignored `unknown_order` |
| `payment_intent.canceled` | goods: an authorized, uncaptured order is canceled (`payments_order_authorization_canceled`); a lapsed authorization emails the owner "send ikke varen" (see Ordrer); a payment intent of no goods order is ignored `unknown_order` |

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
  `consent_rpc_…` (the consent writer), `rpc_failed`, or `unexpected` (a defect);
  `missing_profile` when Supabase Auth has the account of a user the database refused as
  `unknown_user` (see Operations).
- `paused`: how many monitors the writer's lapse pause paused.
- `consent` and `mail`: only on a `checkout.session.completed` the sync writer did not refuse
  (see Fortrydelse > Logs).

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

## Fortrydelse

The right of withdrawal (fortrydelsesret, forbrugeraftaleloven) for the Monitor subscription,
slice 1d. The legal texts are versioned in `src/config/legal/withdrawal-texts.ts`; the rules
live in migration `20261114000300_payments_withdrawal.sql`.

### Consent (L-1)

The web app's Checkout requires the terms checkbox (`consent_collection[terms_of_service]`) with
the text of `WITHDRAWAL_TEXT_VERSION` and puts that version into the session's and the
subscription's `metadata.withdrawal_text_version`. On `checkout.session.completed`, after the
sync writer answered anything but a refusal, the Worker records the consent
(`payments_record_checkout_consent`: session, subscription, version, the sha256 of the texts the
customer saw, locale, `accepted_at` = the event's `created`) when `consent.terms_of_service` is
`accepted` and the version is known; otherwise it logs `consent_missing` (a later withdrawal then
refunds everything). It then sends the order confirmation (the withdrawal information on a
durable medium) to the account's email (Resend key `withdrawal-info/<session id>`) and stamps
`info_sent_at`, which starts the 14 days. Not for a subscription that has ended (canceled,
`incomplete_expired`, or finished as a duplicate in that delivery). A failure of the consent
writer that a retry may fix answers 500 (Stripe redelivers; the record is evidence); a failed
email never does (the sweep resends it).

### Withdrawal (L-2)

`/monitor/billing/withdraw` calls `WithdrawalService.withdraw` over the binding with the user's
access token, never a user id:

1. Supabase Auth resolves the token to the user (id and the account email for the receipt).
2. `payments_begin_withdrawal` records the notice with the database clock (`requested_at`) after
   checking ownership, an entitling status and the deadline (`window_expired`,
   `not_withdrawable`); a second submit resumes the recorded one.
3. One pass of `processWithdrawal` (`withdrawal.ts`), under a 120 s lease
   (`payments_claim_withdrawal`):
   - received: the subscription Stripe returns must be the stored one (customer, `start_date`, no
     duplicate mark), else `needs_manual subscription_mismatch` WITHOUT a cancel; then
     `DELETE /v1/subscriptions/{id}` (`prorate=false`, comment `withdrawal`) → step `canceled`.
   - canceled: the refund, automated only for exactly one paid invoice of the plain shape (one
     subscription line of the whole amount, no balance, nothing else open, no credit note but
     this withdrawal's own), else `needs_manual invoice_shape`. Amount (`wd-refund-1`):
     retained = floor(paid × E / period) with E the seconds from the line's period start to
     `requested_at` (0 to the period), only with a consent (`retention_basis = consent`; without
     one nothing is retained). A credit note on the invoice line with the refund to the original
     payment (`POST /v1/credit_notes`, VAT reversed on the line, `metadata[withdrawal_id]`,
     Idempotency-Key `wd-cn-<id>`), reused when one with that metadata exists → step `refunded`.
     Nothing to refund → `no_refund_due`.
   - the receipt once (`withdrawal-ack/<id>`, also while still in progress), and for
     `needs_manual` the owner alert once to `WITHDRAWAL_ALERT_TO` (`withdrawal-alert/<id>`: ids
     and the reason, whether the subscription is stopped and whether the consumer has the
     receipt, never a name or an email). Both bodies follow the withdrawal's state, so a send
     whose stamp failed may be retried with another body: Resend then answers its 409
     `invalid_idempotent_request` (per Resend's docs as of 2026-11), nothing is sent again, and
     it is stamped with `email_id` `idempotent_replay` (the order confirmation's stamp too). That
     the first request's email went out is an inference: the docs do not say whether a refused
     first request keeps its key. A receipt in doubt: Resend dashboard > Emails, search the
     consumer's address (`ack_email`).
   - a failure a later pass may fix is recorded as `failed <code>` (`last_error`, a code only);
     after more than 8 passes (`WITHDRAWAL_MAX_ATTEMPTS`) a withdrawal still received or canceled
     goes to `needs_manual retries_exhausted`.
4. The answer is the withdrawal's state once the notice is recorded, whatever the pass got done.

### The sweep (`scheduled`, hourly)

`payments_pending_work(20, 24)` lists withdrawals with work left (no live lease), the least
recently updated first: a claim and every step move one to the back, so a withdrawal that keeps
failing never holds the front. One whose only work left is an email (the receipt, or the owner
alert of a `needs_manual` one) is listed only while it has had fewer than 24 passes
(`WITHDRAWAL_MAX_MAIL_ATTEMPTS`, a day of sweeps); the pass that reaches 24 and still leaves an
email unsent logs `"step":"mail","outcome":"given_up","code":"retries_exhausted"` (see manual
handling). It also lists order confirmations not yet sent (accepted in the last 30 days, of a
subscription that has not ended). Each withdrawal gets one `processWithdrawal` pass, each
confirmation is sent and stamped; a failing item is logged and the sweep goes on. Every Stripe,
Supabase and Resend fetch is counted, and an item starts only when its worst case still fits 45
subrequests: 15 for a withdrawal pass (charged what it really made, at least 10), 4 for a
confirmation. While a confirmation waits, a pass starts only when 15 + 4 still fit, so a full
withdrawal list never starves the confirmations. A run makes 45 at most (Workers Free allows 50,
per Cloudflare's docs as of 2026-11): the rest waits an hour.

Confirmations keep their order (oldest accepted first) and have no attempt counter: one Resend
refuses for good (e.g. a bad account address, `mail_rejected`) is retried every hour for its 30
days ahead of newer ones, and about 11 such rows fill a run's confirmation budget. The sweep log
names the session of each failure (`"session":…,"outcome":"error","code":"confirmation_failed"`):
the same session failing hour after hour means check the account's email, send the confirmation
by hand, and stamp it as `service_role` with `select public.payments_mark_consent_info_sent(
'<session id>', 'manual');`.

### Logs

Ids and codes only, never a name, an email, a token or an amount but øre integers:

- The webhook line of a `checkout.session.completed` gains `"consent"` (`recorded`, `duplicate`,
  `consent_missing`, `consent_rejected`) and `"mail"` (`sent`, `not_needed`, `no_recipient`,
  `failed`, or null without a record).
- `{"msg":"payments withdraw","withdrawal":…,"outcome":…,"code":…}`: one per
  `WithdrawalService.withdraw` call; `outcome` `created`/`existing`, `refused` (code
  `invalid_input`, `invalid_env`, `auth_failed`, `unauthenticated`, `no_email`,
  `not_withdrawable`, `window_expired`, `begin_failed`) or `process_failed`.
- `{"msg":"payments withdrawal","withdrawal":…,"step":…,"outcome":…,"code":…}`: one per step of
  a pass (`claim` claimed/busy/done, then the steps applied/already; `needs_manual` with the
  reason, `failed` with the code: `stripe_unavailable`, `stripe_refused`, `cancel_failed`,
  `invoice_not_recorded`, `mail_<rate_limited|quota|config|transient|rejected>`, `rpc_failed`),
  and `mail` `given_up` with code `retries_exhausted` when the sweep stops retrying an email.
- `{"msg":"payments sweep",…}`: per failed item (`process_failed`, `confirmation_failed`, or
  `pending_work_failed`), per confirmation its outcome, and a closing
  `{"outcome":"done","withdrawals":n,"consents":n,"budgetStop":bool,"subrequests":n}`.

## Fortrydelse: manuel behandling

The owner alert (subject and body name the withdrawal id, the subscription, `requested_at` and
the reason) means the Worker stopped automating that withdrawal. It says whether the consumer
has the receipt (in-progress wording); the consumer sees the withdrawal as in progress on
`/monitor/billing`.

**Deadline: refund within 14 days of `requested_at`** (forbrugeraftaleloven § 22). List them:

```sql
select id, stripe_subscription_id, manual_reason, last_error, canceled_at,
       requested_at, requested_at + interval '14 days' as refund_by, retention_basis
  from public.subscription_withdrawals
 where status = 'needs_manual'
 order by requested_at;
```

### An email the sweep gave up on

The log line `"step":"mail","outcome":"given_up","code":"retries_exhausted"` means a receipt or
an owner alert still failed after 24 passes (`last_error` has the mail code, e.g.
`mail_config`: fix the Resend key or the sending domain first). List them, including withdrawals
whose alert never reached you:

```sql
select id, status, manual_reason, last_error, attempts, ack_sent_at, alerted_at, requested_at
  from public.subscription_withdrawals
 where status in ('completed', 'needs_manual')
   and (ack_sent_at is null or (status = 'needs_manual' and alerted_at is null))
 order by requested_at;
```

A missing receipt (`ack_sent_at` null): send the consumer (`ack_email`) the receipt by hand
(when the notice was received, for which agreement, and the refund once made), then record it,
as `service_role`, with `select public.payments_withdrawal_step('<withdrawal id>', 'ack_sent',
'{"email_id": "manual"}');`. A `needs_manual` withdrawal whose alert was not sent: handle it by
reason (below) and record the alert with `'alerted', '{}'`. The Worker then sends neither.

### Per reason

- `subscription_mismatch`: the subscription was **not** canceled. In the Stripe Dashboard,
  open the subscription and compare its customer and start date with `subscriptions`
  (`stripe_customer_id`, `started_at`), and look for `metadata.duplicate_subscription = true`
  (a duplicate the webhook already refunds and cancels: check its refunds before doing
  anything). When it is the consumer's contract, cancel it at once (Cancel subscription >
  Immediately, no proration credit), record the cancel (below), then refund.
- `invoice_shape`: the subscription **is** canceled. Look at its invoices: more than one paid
  invoice (a renewal or an interval switch), a customer balance (`starting_balance`), a credit
  note already on the invoice, extra lines, or an open invoice (void it: Invoice > Void, so the
  customer is not charged). Refund the unused part of what was paid for the period the notice
  falls in, by the formula above (with `retention_basis = no_consent` everything paid).
- `stripe_refused`: Stripe answered the credit note with a 4xx (e.g. the restricted key lacks
  Credit notes: Write) or the note did not match the computed refund. Check the invoice's
  credit notes for one with `metadata.withdrawal_id = <id>`: if one exists, do not issue
  another; record that one.
- `retries_exhausted`: more than 8 passes failed (`last_error` has the last code, e.g.
  `stripe_unavailable`, `rpc_failed`). With `canceled_at` null the subscription was **not**
  canceled: cancel it first; then refund. Fix the cause first (keys, Stripe or Supabase status).

### Refund by hand: a credit note with a refund

Stripe Dashboard > Invoices > the paid invoice > create a credit note (Dashboard label may be
"Issue credit note"): the subscription line item with the refund amount (VAT is then reversed
on the line), reason "Order change", memo `Fortrydelse af Monitor-abonnement`, metadata
`withdrawal_id = <withdrawal id>` (the Worker reuses a note it finds by that metadata), and
refund the amount to the original payment method. Note the credit note id (`cn_…`), its total
tax and the refund id (`re_…`).

### Record it (service_role `payments_withdrawal_step`)

In the Supabase SQL editor of production, as `service_role` (the functions are not executable
by any other API role). First the cancel, if `canceled_at` is null (a needs_manual withdrawal
keeps its status), then the refund, which completes it:

```sql
begin;
set local role service_role;
select public.payments_withdrawal_step('<withdrawal id>', 'canceled',
  '{"canceled_at": "<ISO time Stripe shows for the cancel>"}');
select public.payments_withdrawal_step('<withdrawal id>', 'refunded', '{
  "stripe_invoice_id": "in_…",
  "service_start_at": "<invoice line period start, ISO>",
  "period_end_at": "<invoice line period end, ISO>",
  "paid_ore": 0, "retained_ore": 0, "refund_ore": 0, "refund_tax_ore": 0,
  "calc_version": "wd-refund-1",
  "stripe_credit_note_id": "cn_…",
  "stripe_refund_id": "re_…"}');
commit;
```

Amounts in øre: `paid_ore = retained_ore + refund_ore`, `refund_ore > 0`, `refund_tax_ore` the
credit note's total tax, `retained_ore = 0` when `retention_basis = no_consent`. The invoice must
be recorded in `subscription_invoices` for that subscription (else `invoice_not_recorded`), and
its `amount_refunded_ore` may not exceed its total (a CHECK). When nothing was paid, record
`'no_refund_due'` with `{"stripe_invoice_id": null, "paid_ore": 0, "calc_version":
"wd-refund-1"}` instead (a paid amount there only with a consent: `invalid_transition`
otherwise). The `refunded` and `no_refund_due` steps take a `needs_manual` withdrawal only once
`canceled_at` is set. The consumer's billing page then shows the completed withdrawal; the
Worker sends no second receipt (enable Stripe's credit note emails if the customer should get
the credit note).

## Ordrer

Goods orders (slice S2, migration `20261114000400_payments_goods_orders.sql`): a one-time
purchase of a physical 3D figure, delivered in Denmark only, **charged on dispatch** (contract
amendments A1/A2). Checkout only authorizes the payment (`capture_method=manual`; no Stripe
invoice or Customer), "Markér afsendt og træk betalingen" captures it, a withdrawal before
dispatch releases the authorization (nothing is charged) and one after dispatch is refunded. The
order confirmation email is the invoice ("Ordrebekræftelse og faktura nr. <n>", n = the order
number, with the seller, the buyer and the moms); a refund or a release gets a credit note email
("Kreditnota til faktura nr. <n>"). The goods code is separate from the subscriptions
(`orders/`, its own tables and writers); shared are the signature check, `stripe_events`, the
Stripe and Resend transports and the cron.

**For the accountant: invoice numbers.** The order number, which is the invoice number, comes
from a database sequence (`orders.order_number`, from 1001). `payments_record_order` looks for an
order of the Checkout Session before it inserts one, so a repeated or late event for a session
already recorded (`async_payment_succeeded` after `completed`, a replay under a new event id)
takes no number. A number can still be skipped, a gap in the series: the database draws it when
the order row is inserted and never hands it out again, even when that write is rolled back (a
failure later in the same transaction, or two deliveries of one session at the same moment, where
the second insert is skipped). A skipped number has no order, no invoice email and no payment
behind it.

### Environment

| key | kind | what |
|---|---|---|
| `ORDER_LINK_SECRET` | secret: `npx wrangler secret put ORDER_LINK_SECRET --config workers/payments/wrangler.jsonc` | the HMAC key of the personal withdraw links (`/order/withdraw?o=&t=`): 32 to 256 characters without whitespace (`openssl rand -base64 48`). Only this Worker holds it, never the web app. Rotating it invalidates every link already sent (the order number + email form still works). |
| `ORDER_NOTIFY_TO` | var | where the owner's order emails go (`info@alnyron.dk`) |
| `STRIPE_TAX_RATE_ID` | var | the 25 % inclusive Tax Rate on the Checkout line: live `txr_1Ubdp4FBWtA5MNzbg2ZKznPw` (`wrangler.jsonc`), test `txr_1Ub3CpFIgZG2PjS18JkfB0FE` (`.dev.vars`) |

`parseOrdersEnv` (`orders/env.ts`) reads them apart from the subscription env, which never needs
them. Without a valid set: every `OrderService` call answers `unavailable` (log `invalid_env`);
the webhook still records goods orders but logs `"code":"orders_env_unavailable"` and leaves
their emails to the sweep; the sweep skips its goods pass
(`{"msg":"payments order sweep","outcome":"skipped","code":"orders_env_unavailable"}`).

### Webhook (goods)

1. `checkout.session.completed` or `checkout.session.async_payment_succeeded` of a
   `mode: payment` session with `metadata.kind` `goods_order`: `normalizeGoodsSession`
   (`awaiting_payment`, `invalid_session` → ignored). With manual capture a completed session is
   `unpaid`: the Worker reads `GET /v1/payment_intents/{pi}?expand[]=latest_charge`;
   `requires_capture` → the order is recorded `authorized` with `authorization_expires_at` = the
   card's `capture_before` (7 days after Checkout; null for Klarna or Amazon Pay); `succeeded` →
   recorded as captured at Checkout (anomaly `captured_at_checkout`, "Markér afsendt" captures
   nothing more); any other status → ignored `awaiting_payment`; a failed read → 500. A `paid`
   session is recorded as captured at Checkout without the read.
2. The buyer: `metadata.user_id` equal to `client_reference_id` (both set by the Worker for a
   buyer whose access token Supabase Auth confirmed) and an account Supabase Auth still has → the
   order's `user_id`; else a guest order (anomaly `user_unverified` when the two differ); a failed
   Auth lookup → 500.
3. `payments_record_order`: `duplicate` (a seen event, or the session's order exists) → no
   emails; a 22023 refusal → rejected; any other failure → 500.
4. Recorded: the order confirmation (the invoice, `order-confirm/<order id>`) to the order's email
   and the new-order email (`order-owner/<order id>`) to `ORDER_NOTIFY_TO`, each stamped
   (`payments_order_mail_sent`). A failed send counts in `mail_attempts` and the sweep resends it.

`charge.refunded` → `payments_sync_order_refund` (no email: a refund made in the Dashboard shows on
the admin page). `payment_intent.canceled` → `payments_order_authorization_canceled`: a lapsed
authorization (`cancel_reason` `authorization_expired`) emails the owner "Betalingen for ordre <n>
er udløbet; send ikke varen" (`order-expired/<order id>`, stamped `expired_alert` and resent by the
sweep until stamped); the Worker's own release for a withdrawal (`withdrawn`) sends nothing. At
most 7 subrequests a delivery. The webhook log line of a goods event adds `order` (the id) and per
email `confirmation`, `owner` or `alert`: `sent`, `deferred` (no orders env) or the failure's
code (`mail_transient`, `rpc_…`).

### OrderService (service binding `ORDERS`)

Inputs and answers follow `src/lib/payments/orders/service-contract.ts` (`invalid_input` for
anything else). The web app sends the user's access token, never a user id; the writers check
the owner/admin role.

| method | what it does |
|---|---|
| `startCheckout({itemId, locale, accessToken?})` | the item's active physical offer (`payments_goods_offer`; none → `not_purchasable`), the token's user when Supabase Auth confirms it and it has an email (else a guest Checkout, never an error), then `POST /v1/checkout/sessions` with `STRIPE_PAYMENTS_KEY`: `{ok: true, url}` on checkout.stripe.com only |
| `withdraw(link or form)` | the personal link's token (HMAC under `ORDER_LINK_SECRET`) or order number + the order's email (`payments_find_order`); every identification failure and a refunded or canceled order without a withdrawal is the same `refused`. A new notice sends the receipt to the order's email (`order-wd-ack/<withdrawal id>`) and the owner's alert (`order-wd-alert/<withdrawal id>`, "SEND IKKE VAREN" when not shipped, the late flag, the refund deadline); a repeated notice (also after the refund or the release) answers `received` and sends nothing |
| `markShipped({accessToken, orderId, trackingRef?})` | `payments_order_begin_ship` (stores the tracking) → `POST /v1/payment_intents/{pi}/capture` (Idempotency-Key `ord-cap-<order id>`; skipped when captured at Checkout) → `payments_order_captured` → the shipped email (`order-shipped/<order id>`) → `shipped`. A refused capture (400 or 402) is decided by a re-read: `succeeded` (captured before) → shipped; `canceled` or `charge_expired_for_capture` → the order is canceled, the owner gets `order-expired/<order id>`, answer `conflict authorization_expired`; anything else (a decline) → the order stays reserved with the anomaly `capture_failed`, the owner gets "Ordre <n>: betalingen kunne ikke trækkes" (`order-capture-failed/<order id>`), answer `conflict capture_refused`. A failure a retry may fix (network, 401/403 a key permission, 404, 409, 429, 5xx) → `unavailable` with nothing marked shipped; clicking again captures once (same key) |
| `approveRefund({accessToken, orderId, goodsState, deductionOre, deductionReason?})` | `payments_approve_order_refund` (`not_shipped` on an uncaptured order releases the authorization, otherwise refund of total − refunded − deduction; an order with no withdrawal yet gets one with channel `admin`: the owner records a notice that came by email or letter from the order's page; the buyer gets no withdrawal receipt and the owner no withdrawal alert for it, only the credit note once it completes) → one `processOrderRefund` pass → `completed`, `canceled` (released), `needs_manual` or `approved` (the sweep finishes it) |

`processOrderRefund` (`orders/withdrawal.ts`): claim (a 120 s lease; counts the pass) → release
(`POST /v1/payment_intents/{pi}/cancel`, `cancellation_reason=requested_by_customer`, key
`ord-cancel-<withdrawal id>`; a refused cancel is done when the payment intent then shows
`canceled`) and step `authorization_canceled`, or refund: first
`GET /v1/refunds?payment_intent=<pi>&limit=100`, reusing a `succeeded` or `pending` refund with
`metadata.order_withdrawal_id` equal to this withdrawal's id. Other withdrawals' refunds and
failed/canceled refunds are ignored. Only if none matches, `POST /v1/refunds` of `refund_ore`,
`metadata[order_withdrawal_id]` and `metadata[order_number]`, key `ord-re-<withdrawal id>`. Then
step `refunded` (`refund_tax_ore` = the 25 % moms in it) → the credit note email
(`order-refund/<withdrawal id>`, step `receipt_sent`). A failed, malformed or incomplete refund
list is a transient error: no refund POST. Stripe refusing the refund or release (400 or 402,
or a new refund it reports `failed` or `canceled`) → `needs_manual stripe_refused`; a failure a retry may fix
(incl. 401/403) → `attempt_failed` (the sweep retries, at most 8 passes,
`WITHDRAWAL_MAX_ATTEMPTS`, the last one going to `needs_manual retries_exhausted`). Both manual reasons send the owner
"Ordre <n>: fortrydelsen kræver manuel behandling" (`order-wd-manual/<withdrawal id>`, step
`manual_alert_sent`; a failed send is retried by the sweep). No credit notes or invoices in
Stripe: the credit note is the email.

### The sweep's goods pass

After the subscription and withdrawal passes, with what they left of the 45 subrequests and at
most 12 (`PAYMENTS_SWEEP_ORDER_SUBREQUESTS`): `payments_pending_order_work(20, 24)` lists missing
order emails (the confirmation, the new order, the shipped email, the lapsed-reservation alert),
capture warnings (an authorized order whose authorization lapses within 48 hours: the owner's
"Ordre <n>: betalingen udløber …", `order-capture-warn/<order id>`), withdrawal emails (the
receipt and the owner's alert, never for a channel `admin` notice the owner recorded; the credit
note; from 4 days before the refund deadline the owner's reminder
`order-wd-remind/<withdrawal id>`; the owner's manual-handling alert of a `needs_manual` one until
stamped) and approved withdrawals (one
`processOrderRefund` pass each). An item starts only when its worst case still fits: an email 2
subrequests plus 1 for the read of its order or withdrawal, a refund pass 6. Logs
`{"msg":"payments order sweep",…}` per email and pass, and a closing
`{"outcome":"done","orders":n,"warnings":n,"withdrawals":n,"budgetStop":bool,"subrequests":n}`.

### Logs (goods)

- `{"msg":"payments order service","method":…,"outcome":"ok"|<error>,"code":…,"order":…}`: one
  per `OrderService` call (code e.g. `invalid_env`, `auth_failed`, `link_not_matched`,
  `not_withdrawable`, `stripe_http_402`, `alert_sent`, `mail_sent`).
- `{"msg":"payments order refund","withdrawal":…,"step":…,"outcome":…,"code":…}`: one per step
  of a `processOrderRefund` pass.
- `{"msg":"payments order sweep",…}`: see above.

## Ordrer: manuel behandling

What the owner's goods emails mean:

- **"Ordre <n>: betalingen udløber <tid>"**: an unshipped order's card reservation lapses
  within 48 hours. Send it and click "Markér afsendt og træk betalingen" before then.
- **"Ordre <n>: betalingen er udløbet"** ("send ikke varen"): the authorization lapsed and the
  order is canceled; nothing was charged. Do not send the goods; write to the buyer (the email is
  in the alert) to order again if the sale should go through. Nothing to record.
- **"Ordre <n>: betalingen kunne ikke trækkes"** (A2-3): Stripe refused the capture for another
  reason (e.g. a decline). The order stays reserved (`authorized`, anomaly `capture_failed`) and
  is not marked shipped. Look at the payment in the Stripe Dashboard (Payments > the payment);
  do not send the goods before it is resolved. Once the payment is captured (e.g. in the
  Dashboard), "Markér afsendt" again: Stripe refuses the second capture, the Worker re-reads the
  payment intent as `succeeded` and marks the order shipped.
- **"Ordre <n>: fortrydelsen kræver manuel behandling"**: the Worker stopped automating a refund
  or release. **Deadline: within 14 days of the notice** (`refund_due_at`). List them:

```sql
select w.id, o.order_number, w.action, w.manual_reason, w.last_error, w.refund_ore,
       w.deduction_ore, w.requested_at, w.refund_due_at
  from public.order_withdrawals w
  join public.orders o on o.id = w.order_id
 where w.status = 'needs_manual'
 order by w.refund_due_at;
```

Per reason:

- `stripe_refused`: Stripe answered the refund or the release with a 400 or 402 (e.g. the amount
  exceeds what is left on the charge; a missing key permission, 401/403, is retried instead and
  ends as `retries_exhausted`). For a refund, look at the payment's refunds in the Stripe Dashboard for one with
  `metadata.order_withdrawal_id = <id>`: if there is one, record it (below) and refund nothing
  more. For a release whose payment intent shows `succeeded` (the money was captured after all),
  refund it in full in the Dashboard instead and record that refund.
- `retries_exhausted`: 8 passes failed (`last_error` has the last code, e.g.
  `stripe_http_503`, `stripe_network`). Fix the cause first (keys, Stripe or Supabase status).

Let the Worker try again once the cause is fixed and nothing was done in Stripe by hand
(SQL editor of production; service_role bypasses RLS):

```sql
begin;
set local role service_role;
update public.order_withdrawals
   set status = 'approved', manual_reason = null, attempts = 0, lease_until = null,
       manual_alert_sent_at = null, manual_alert_email_id = null, updated_at = now()
 where id = '<withdrawal id>' and status = 'needs_manual';
commit;
```

The next sweep (hourly) runs the pass; should it end in manual handling again, the owner is
alerted again (under the same Idempotency-Key, so not within 24 hours of the first alert).
The pass reuses a `succeeded` or `pending` refund with
`metadata.order_withdrawal_id = <id>` even after Stripe's 24-hour Idempotency-Key window;
failed/canceled refunds do not count. A refund made by hand without that metadata must be
recorded below instead of retrying the pass. Recording it is one transaction, so no sweep can
claim the row in between.

Record a refund made by hand in the Dashboard (amount `refund_ore`; note the `re_…` id):

```sql
begin;
set local role service_role;
update public.order_withdrawals
   set status = 'approved', manual_reason = null, updated_at = now()
 where id = '<withdrawal id>' and status = 'needs_manual' and action = 'refund';
select public.payments_order_withdrawal_step('<withdrawal id>', 'refunded',
  '{"refund_id": "re_…", "refund_tax_ore": <refund_ore - round(refund_ore * 4 / 5)>}');
commit;
```

The order is then `refunded` and the next sweep sends the buyer the credit note email. A release
done by hand (Dashboard > the payment > Cancel) of an uncaptured order is recorded the same way,
with `action = 'cancel_authorization'` in the update and step `authorization_canceled` with
`'{}'`; the order becomes `canceled` and the sweep sends the cancellation credit note.

Order emails the sweep gave up on (24 failed sends, `mail_attempts`): fix the cause (e.g.
`mail_config`: the Resend key or domain), then let the sweep resend them:

```sql
select id, order_number, mail_attempts, confirmation_sent_at, owner_notified_at,
       shipped_email_sent_at, expired_alert_sent_at, capture_warning_sent_at
  from public.orders
 where mail_attempts >= 24;
update public.orders set mail_attempts = 0, updated_at = now() where id = '<order id>';
```

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
   (`sk_test_…` or `rk_test_…`, with Credit notes: Write for withdrawals),
   `STRIPE_LIVEMODE=false`, a Resend key (`RESEND_API_KEY`) and the owner-alert test address
   `WITHDRAWAL_ALERT_TO=delivered+withdrawal-alert@resend.dev` (`MAIL_FROM` and `SITE_URL` keep
   the production values; `.dev.vars` keys override the config's vars). Never point a local run
   at production or at live mode.

   Goods (slice S2) need three more keys there, else the Worker answers every `OrderService`
   call `unavailable` and leaves order emails to the sweep: `ORDER_LINK_SECRET` (a fresh random
   value of at least 32 characters, e.g. `openssl rand -base64 48`; the e2e specs
   `tests/e2e/payments-s2-*.spec.ts` read it from `.dev.vars` to build a personal withdraw link),
   `ORDER_NOTIFY_TO=delivered+orders@resend.dev` (Resend's test sink) and the TEST-mode Tax Rate
   `STRIPE_TAX_RATE_ID=txr_1Ub3CpFIgZG2PjS18JkfB0FE` (the config's var is the live one, unknown to
   test mode). With a restricted test key, add Checkout Sessions, Products and PaymentIntents:
   Write (a full `sk_test_` key has them). No script writes `.dev.vars`: it is filled by hand from
   `.dev.vars.example`.
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
`tests/integration/payments/withdrawal-live.test.ts` runs `processWithdrawal` with the Worker's
real Stripe and Supabase modules against a real test subscription (cancel, credit note with VAT,
the database steps, the reconcile after a pass that died after the credit note).

### The web app's binding, locally

The web app reaches `WithdrawalService` over the service binding `PAYMENTS` (root
`wrangler.jsonc` `services`). Under `next dev`, `initOpenNextCloudflareForDev` (next.config.mjs)
takes the app's bindings from wrangler's `getPlatformProxy`, which finds the payments Worker of a
separate `wrangler dev` on the same machine through wrangler's local dev registry. Verified
2026-11-14 (wrangler 4.156, Next 15.5, Windows): run the payments Worker first, then the web app
against the e2e project:

```sh
npx wrangler dev --config workers/payments/wrangler.jsonc   # terminal 1: reads workers/payments/.dev.vars
npm run dev:e2e -- -p 3000                                  # terminal 2: the web app (scripts/next-e2e-project.mjs)
```

- Use `npm run dev:e2e`, not `npm run dev`: the withdraw action forwards the session's access
  token, and the Worker checks it with the Supabase Auth of its own `SUPABASE_URL`, so the web
  app must sign in against the same (e2e) project that `.dev.vars` names.
- Restarting the payments Worker breaks the binding of a running `next dev` (every call fails
  with "Network connection lost.", still after a minute): restart terminal 2 as well, after
  terminal 1 shows `Ready on http://127.0.0.1:8787`.
- What the binding answers (check it after a restart): a call with an invalid input gives
  `{"ok":false,"code":"invalid_input"}` and the Worker logs
  `{"msg":"payments withdraw",...,"code":"invalid_input"}`. Without `.dev.vars` the Worker has no
  secrets (the config's `vars` alone, `SUPABASE_URL` being production's), so a well-formed call
  answers `unavailable` (log `"code":"invalid_env"`) before any request leaves the Worker.
- Without terminal 1 the call fails ("Network connection lost.") and the withdraw action
  answers `?error=unavailable`.

The emails are real Resend sends: `.dev.vars` sets
`WITHDRAWAL_ALERT_TO=delivered+withdrawal-alert@resend.dev`, and every test account that receives
an order confirmation or a receipt must have a `delivered+<label>@resend.dev` address (Resend's
test sink), never a real inbox. Trigger the sweep of the running Worker (terminal 1, no extra
flag) with `curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=0+*+*+*+*"`, the route
wrangler 4.156 prints at start; `/__scheduled` answers 404 unless the Worker was started with
`--test-scheduled`.

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

### Slice 1d go-live (fortrydelse)

On top of the steps above, in exactly this order. The 1d Worker goes out before the migrations:
it works against the database before them (its sync payload's extra `start_date` key is ignored
by the 1c writers; a `checkout.session.completed` fails 500 on the consent writer that does not
exist yet, so Stripe redelivers it; the sweep logs `pending_work_failed`), while the 1c Worker
would have its deliveries refused once 0300 requires `start_date`.

1. `STRIPE_PAYMENTS_KEY` (the restricted live key): add **Credit notes: Write** in the Stripe
   Dashboard's restricted-key editor (`POST /v1/credit_notes`; it includes the read the Worker's
   reconcile list needs, per Stripe's permissions reference). Without it every refund is answered
   403 and ends `needs_manual stripe_refused`. The test-mode key used locally needs it too.
2. The Resend key:
   `npx wrangler secret put RESEND_API_KEY --config workers/payments/wrangler.jsonc` (`re_…`, a
   key allowed to send from the verified `send.alnyron.dk` domain). Check the vars in
   `wrangler.jsonc`: `MAIL_FROM` (same as the web Worker's), `WITHDRAWAL_ALERT_TO`
   (`info@alnyron.dk`, the owner alert) and `SITE_URL` (`https://alnyron.dk`).
3. Stripe Dashboard > Settings > Public details: Terms of service URL `https://alnyron.dk/terms`.
   Checkout's `consent_collection[terms_of_service]=required` needs it (the slice 1d spike made
   test-mode Checkouts with it set); check it is set for live mode too.
4. Deploy the payments Worker: `npm run deploy:payments`. This also registers the hourly cron
   (`0 * * * *`): check Workers & Pages > alnyron-payments > Settings > Triggers.
5. Right after it, the migrations on production, one at a time and in order:
   `20261114000100_system_page_terms_key.sql` (adds the enum value `terms`; it must be committed
   before the next file uses it), then `20261114000200_system_page_terms.sql` (the `/terms` page
   and its reserved slug), then `20261114000300_payments_withdrawal.sql` (the withdrawal tables
   and functions, and the sync writer's required `start_date`). Fallback, only if 0300 went in
   before the 1d Worker: the 1c Worker's deliveries in between are refused `invalid_payload`,
   answered 200, so Stripe does not retry them; resend (Stripe Dashboard > the event > Resend)
   every event logged `"outcome":"rejected","code":"invalid_payload"` in between.

   `started_at`: 0300 adds it without a backfill, on the premise that production holds no
   subscription yet (no live plan, no `monitor_plans` row, was ever seeded there, so no Checkout
   could make one). Check the premise right after 0300; this must return no row:

   ```sql
   select stripe_subscription_id, status
     from public.subscriptions
    where started_at is null and status not in ('canceled', 'incomplete_expired');
   ```

   Should it return any, backfill each before step 6, else its withdrawal is refused
   `not_withdrawable` and the billing page shows no "Fortryd aftale" until its next event sets
   `started_at` (for a yearly plan up to a year away). Read the subscription's `start_date` (Unix
   seconds) in the Stripe Dashboard or with `GET /v1/subscriptions/<id>` (the restricted key),
   then in the SQL editor of production:

   ```sql
   update public.subscriptions
      set started_at = to_timestamp(<start_date>), updated_at = now()
    where stripe_subscription_id = '<sub_…>' and started_at is null;
   ```

   Such a subscription has no recorded consent, so its window is the start day + 14 days plus 12
   months and a withdrawal refunds everything paid.
6. Then deploy the web Worker (`npm run deploy`): its `PAYMENTS` service binding names
   `alnyron-payments` and its `WithdrawalService` entrypoint, which must exist first. Until it
   does, `/monitor/billing/withdraw` answers `?error=unavailable` and no withdrawal is recorded.
7. Check: a test-mode or own live Checkout logs `"consent":"recorded","mail":"sent"` on its
   `checkout.session.completed` line, the order confirmation arrives, and the next full hour logs
   `{"msg":"payments sweep",…,"outcome":"done",…}`.

### Slice S2 go-live (goods)

Blocker first: the accountant confirms the documents (order confirmation = invoice, credit note
emails, Stripe receipt; contract amendment A2-0). Then, in this order:

1. Migration `20261114000400_payments_goods_orders.sql` on production (additive: the goods tables
   and writers; `admin_save_item` behaves as before without the `offers` key). Until it is in, the
   sweep's goods pass logs `pending_order_work_rpc_…` and a `charge.refunded` subscribed in step 4
   would fail 500, so it goes first.
2. `STRIPE_PAYMENTS_KEY` (the restricted live key): add **Checkout Sessions: Write**,
   **Products: Write** (Checkout's inline `product_data` makes a Product per session) and
   **PaymentIntents: Write** (read, capture, cancel); the refund permission and Credit notes: Write
   (1d) stay. A missing one shows as 403: `startCheckout` and "Markér afsendt" answer
   `unavailable`, a refund or release is retried and ends `needs_manual retries_exhausted`.
3. `npx wrangler secret put ORDER_LINK_SECRET --config workers/payments/wrangler.jsonc` (32 to 256
   characters, no whitespace); check the vars `ORDER_NOTIFY_TO` and `STRIPE_TAX_RATE_ID` (a live
   25 % **inclusive** Tax Rate) in `wrangler.jsonc`; then `npm run deploy:payments`.
4. Stripe Dashboard (live mode) > the `https://pay.alnyron.dk/webhook` endpoint: add the events
   `checkout.session.async_payment_succeeded`, `charge.refunded` and `payment_intent.canceled`.
5. Deploy the web Worker (`npm run deploy`): its `ORDERS` service binding names `alnyron-payments`
   and the `OrderService` entrypoint, which must exist first.
6. Check with an own purchase: its `checkout.session.completed` line logs
   `"outcome":"recorded","confirmation":"sent","owner":"sent"`; "Markér afsendt" logs
   `{"msg":"payments order service","method":"markShipped","outcome":"ok",…}` and the payment
   shows captured in the Dashboard; the next full hour logs
   `{"msg":"payments order sweep",…,"outcome":"done",…}`.

Statements about Stripe, Supabase and Cloudflare dashboards, behaviour, permissions and plan
features reflect their documentation as of 2026-11 and may have changed; check them at go-live.
