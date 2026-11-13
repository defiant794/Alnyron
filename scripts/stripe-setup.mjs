/**
 * Stripe setup for the Monitor subscription: creates, once, what the app and
 * the plans seed refer to, and prints their ids. Idempotent: every object is
 * looked up first (product by id, prices by lookup_key, the Tax Rate and the
 * Billing Portal configuration by their `alnyron_key` metadata), so a second
 * run creates nothing.
 *
 *   - Product `monitor_plus` ("Monitor Plus").
 *   - Prices `monitor_plus_month` (10 kr a month) and `monitor_plus_year`
 *     (95 kr a year): DKK, tax_behavior inclusive. A price whose amount,
 *     currency or interval differs from the one below stops the run (a Stripe
 *     price cannot be changed; create a new one deliberately instead).
 *   - Tax Rate "Moms": 25%, inclusive, DK (metadata alnyron_key=moms25).
 *   - Billing Portal configuration (metadata alnyron_key=monitor_plus): update
 *     the payment method; cancel at the end of the period; switch between the
 *     two prices (with prorations; the quantity stays 1); no invoice history;
 *     update email and address. An existing configuration whose features
 *     differ is updated to these (versioned here, never hand-set in the
 *     Dashboard).
 *
 * Usage: node --env-file=.env.local scripts/stripe-setup.mjs [--live]
 *
 * Reads the key from STRIPE_CHECKOUT_KEY. For the local test-mode setup it
 * may be in .env.local while this script runs, but never in a root .env*
 * file during `npm run cf:build`: OpenNext compiles every root .env* file
 * into the Worker bundle, and scripts/guard-no-bundled-secrets.mjs then
 * fails the build (the same rule as RESEND_API_KEY). Remove it from there
 * before building; the app reads it from the shell environment. The app's
 * own production key is a restricted key that cannot create products,
 * prices, tax rates or portal configurations: for the live setup put a full
 * secret key in that variable in the shell environment for this one run. A
 * live key (`*_live_*`) is refused unless `--live` is given. Prints only
 * object ids and the env lines to add (STRIPE_TAX_RATE_ID,
 * STRIPE_PORTAL_CONFIGURATION_ID), never the key; an error prints Stripe's
 * status, type, code, param and message with any key-shaped text masked.
 */

/** Mirrors STRIPE_API_VERSION in src/lib/payments/stripe.ts (this .mjs runs in Node, without the TypeScript source). */
const STRIPE_API_VERSION = "2026-10-28.endive";
const API = "https://api.stripe.com/v1";
const REQUEST_TIMEOUT_MS = 20_000;

const PRODUCT = { id: "monitor_plus", name: "Monitor Plus" };
const CURRENCY = "dkk";
const PRICES = [
  { lookup_key: "monitor_plus_month", unit_amount: 1000, interval: "month" },
  { lookup_key: "monitor_plus_year", unit_amount: 9500, interval: "year" },
];
const TAX_RATE = { display_name: "Moms", percentage: 25, inclusive: true, country: "DK", jurisdiction: "DK" };
const TAX_RATE_KEY = "moms25";
const PORTAL_KEY = "monitor_plus";

const KEY_SHAPE = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/;
const KEY_TEXT = /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g;

/** Stops the run with `message` (never a key). */
function fail(message) {
  console.error(`stripe-setup: ${message}`);
  process.exit(1);
}

const key = process.env.STRIPE_CHECKOUT_KEY ?? "";
const live = process.argv.includes("--live");
if (!KEY_SHAPE.test(key)) fail("STRIPE_CHECKOUT_KEY is missing or not a Stripe secret/restricted key");
if (key.includes("_live_") && !live) fail("refusing a live-mode key without --live");

/** Stripe's bracket form encoding: `a[b][c]`, `a[0]`; undefined skipped (as encodeStripeForm). */
function encode(params, form = new URLSearchParams(), prefix = "") {
  for (const [name, value] of Object.entries(params)) {
    const field = prefix ? `${prefix}[${name}]` : name;
    if (value === undefined) continue;
    if (value !== null && typeof value === "object") encode(value, form, field);
    else form.append(field, String(value));
  }
  return form;
}

class StripeRequestError extends Error {
  constructor(status, error) {
    const detail = [error?.type, error?.code, error?.param && `param ${error.param}`].filter(Boolean).join(", ");
    const message = String(error?.message ?? "").replace(KEY_TEXT, "[key]");
    super(`HTTP ${status}${detail ? ` (${detail})` : ""}${message ? `: ${message}` : ""}`);
    this.status = status;
    this.code = error?.code ?? null;
  }
}

/** One Stripe API call: GET parameters go in the query string, POST parameters in the form body. */
async function stripe(method, path, params = {}) {
  const url = new URL(`${API}${path}`);
  const form = encode(params);
  if (method === "GET") form.forEach((value, name) => url.searchParams.append(name, value));
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    body: method === "GET" ? undefined : form.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new StripeRequestError(response.status, body?.error);
  return body;
}

/** Every object of a list endpoint (follows `has_more`). */
async function listAll(path, params = {}) {
  const items = [];
  let startingAfter;
  for (;;) {
    const page = await stripe("GET", path, { ...params, limit: 100, starting_after: startingAfter });
    items.push(...page.data);
    if (!page.has_more || page.data.length === 0) return items;
    startingAfter = page.data.at(-1).id;
  }
}

const created = [];
const report = [];

/** Records one object's id and what this run did with it. */
function note(label, id, action) {
  if (action === "created") created.push(id);
  report.push(`${label.padEnd(28)} ${id} (${action})`);
}

// Product -----------------------------------------------------------------------------------------
async function ensureProduct() {
  let product = null;
  try {
    product = await stripe("GET", `/products/${PRODUCT.id}`);
  } catch (error) {
    if (!(error instanceof StripeRequestError) || error.code !== "resource_missing") throw error;
  }
  if (product === null) {
    product = await stripe("POST", "/products", { id: PRODUCT.id, name: PRODUCT.name });
    note("product", product.id, "created");
  } else if (product.name !== PRODUCT.name || !product.active) {
    product = await stripe("POST", `/products/${PRODUCT.id}`, { name: PRODUCT.name, active: true });
    note("product", product.id, "updated");
  } else {
    note("product", product.id, "existing");
  }
}

// Prices ------------------------------------------------------------------------------------------
async function ensurePrices() {
  const existing = await listAll("/prices", { lookup_keys: PRICES.map((price) => price.lookup_key) });
  const ids = {};
  for (const wanted of PRICES) {
    let price = existing.find((candidate) => candidate.lookup_key === wanted.lookup_key) ?? null;
    if (price !== null) {
      const differs =
        price.product !== PRODUCT.id ||
        price.currency !== CURRENCY ||
        price.unit_amount !== wanted.unit_amount ||
        price.recurring?.interval !== wanted.interval ||
        price.recurring?.interval_count !== 1 ||
        price.tax_behavior !== "inclusive";
      if (differs) fail(`price ${wanted.lookup_key} (${price.id}) differs from this script; resolve it in Stripe first`);
      if (!price.active) {
        price = await stripe("POST", `/prices/${price.id}`, { active: true });
        note(`price ${wanted.lookup_key}`, price.id, "reactivated");
      } else {
        note(`price ${wanted.lookup_key}`, price.id, "existing");
      }
    } else {
      price = await stripe("POST", "/prices", {
        product: PRODUCT.id,
        currency: CURRENCY,
        unit_amount: wanted.unit_amount,
        recurring: { interval: wanted.interval },
        tax_behavior: "inclusive",
        lookup_key: wanted.lookup_key,
      });
      note(`price ${wanted.lookup_key}`, price.id, "created");
    }
    ids[wanted.interval] = price.id;
  }
  return ids;
}

// Tax Rate ----------------------------------------------------------------------------------------
async function ensureTaxRate() {
  const rates = await listAll("/tax_rates", { active: true });
  const rate = rates.find((candidate) => candidate.metadata?.alnyron_key === TAX_RATE_KEY);
  if (rate) {
    const differs =
      rate.percentage !== TAX_RATE.percentage ||
      rate.inclusive !== TAX_RATE.inclusive ||
      rate.country !== TAX_RATE.country ||
      rate.jurisdiction !== TAX_RATE.jurisdiction ||
      rate.display_name !== TAX_RATE.display_name;
    if (differs) fail(`tax rate ${rate.id} (alnyron_key=${TAX_RATE_KEY}) differs from this script; resolve it in Stripe first`);
    note("tax rate", rate.id, "existing");
    return rate.id;
  }
  const createdRate = await stripe("POST", "/tax_rates", { ...TAX_RATE, metadata: { alnyron_key: TAX_RATE_KEY } });
  note("tax rate", createdRate.id, "created");
  return createdRate.id;
}

// Billing Portal configuration --------------------------------------------------------------------
function portalFeatures(priceIds) {
  return {
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "create_prorations",
      // Quantity stays 1: a plan's cap does not grow with it.
      products: [
        { product: PRODUCT.id, prices: [priceIds.month, priceIds.year], adjustable_quantity: { enabled: false } },
      ],
    },
    invoice_history: { enabled: false },
    customer_update: { enabled: true, allowed_updates: ["email", "address"] },
  };
}

/** The feature settings this script manages, in a comparable form (lists sorted). */
function comparable(features) {
  const sorted = (list) => [...(list ?? [])].sort();
  return JSON.stringify({
    payment_method_update: features.payment_method_update?.enabled,
    subscription_cancel: [features.subscription_cancel?.enabled, features.subscription_cancel?.mode],
    subscription_update: [
      features.subscription_update?.enabled,
      sorted(features.subscription_update?.default_allowed_updates),
      features.subscription_update?.proration_behavior,
      (features.subscription_update?.products ?? []).map((product) => [
        product.product,
        sorted(product.prices),
        product.adjustable_quantity?.enabled,
      ]),
    ],
    invoice_history: features.invoice_history?.enabled,
    customer_update: [features.customer_update?.enabled, sorted(features.customer_update?.allowed_updates)],
  });
}

async function ensurePortalConfiguration(priceIds) {
  const features = portalFeatures(priceIds);
  // The list leaves out subscription_update.products unless it is expanded.
  const configurations = await listAll("/billing_portal/configurations", {
    active: true,
    expand: ["data.features.subscription_update.products"],
  });
  const configuration = configurations.find((candidate) => candidate.metadata?.alnyron_key === PORTAL_KEY);
  if (configuration) {
    if (comparable(configuration.features) === comparable(features)) {
      note("portal configuration", configuration.id, "existing");
    } else {
      await stripe("POST", `/billing_portal/configurations/${configuration.id}`, { features });
      note("portal configuration", configuration.id, "updated");
    }
    return configuration.id;
  }
  const createdConfiguration = await stripe("POST", "/billing_portal/configurations", {
    features,
    metadata: { alnyron_key: PORTAL_KEY },
  });
  note("portal configuration", createdConfiguration.id, "created");
  return createdConfiguration.id;
}

try {
  await ensureProduct();
  const priceIds = await ensurePrices();
  const taxRateId = await ensureTaxRate();
  const portalId = await ensurePortalConfiguration(priceIds);
  console.log(`Stripe ${live ? "LIVE" : "test"} mode, API ${STRIPE_API_VERSION}`);
  for (const line of report) console.log(line);
  console.log(`created: ${created.length}`);
  console.log(`\nEnv (${live ? 'wrangler.jsonc "vars", with "STRIPE_LIVEMODE": "true"' : ".env.local"}):`);
  console.log(`STRIPE_TAX_RATE_ID=${taxRateId}`);
  console.log(`STRIPE_PORTAL_CONFIGURATION_ID=${portalId}`);
  console.log(`\nmonitor_plans.stripe_price_id: month ${priceIds.month}, year ${priceIds.year}`);
} catch (error) {
  for (const line of report) console.error(line);
  fail(
    error instanceof StripeRequestError
      ? error.message
      : `${error?.name ?? "Error"}: ${String(error?.message ?? "").replace(KEY_TEXT, "[key]")}`,
  );
}
