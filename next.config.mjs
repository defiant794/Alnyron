import createNextIntlPlugin from "next-intl/plugin";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Mirrors MEDIA_BUCKET in src/config/catalog.ts (kept in sync; this .mjs config
// is loaded by Node directly and cannot import the TypeScript source).
const MEDIA_BUCKET = "media";

// Mirrors MONITOR_BILLING_PATH in src/config/payments.ts (kept in sync, as
// above; a unit test compares them).
const MONITOR_BILLING_PATH = "/monitor/billing";

// The Monitor host, as a header-rule `has` host value: production and the
// local dev/e2e host, with or without the trailing FQDN dot, like
// `isMonitorHost` (`config/monitor.ts`). Next matches `^value$` against the
// lowercased Host header without its port.
const MONITOR_HOST = "monitor\\.(?:alnyron\\.dk|localhost)\\.?";

// Points next-intl's server APIs at the per-request config (locale + messages).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Populates getCloudflareContext() in the Node process of `next dev`, `next
// build` and `next start` (whenever Next sets globalThis.AsyncLocalStorage) via
// a local wrangler platform proxy built from wrangler.jsonc. Every binding is
// simulated locally (the local D1 stand-in never contacts Cloudflare, so any
// database_id works; the Durable Object binding only logs a wrangler warning).
// OpenNext's cache overrides (open-next.config.ts) apply only in the built
// Worker.
void initOpenNextCloudflareForDev();

// Security headers. CSP uses 'unsafe-inline' for scripts/styles because a nonce
// CSP forces dynamic rendering and would break ISR (architecture.md §1).
// 'unsafe-eval' is added ONLY in development (Next's dev client requires it).
const isDev = process.env.NODE_ENV !== "production";
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

// Catalog images load from the public media bucket of the Supabase project
// (src/lib/public-media-url.ts); only that path prefix is allowed.
const mediaImageSrc = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? ` ${new URL(`/storage/v1/object/public/${MEDIA_BUCKET}/`, process.env.NEXT_PUBLIC_SUPABASE_URL).toString()}`
  : "";

// The admin MediaManager PUTs images straight to a signed upload URL of the
// media bucket (src/lib/media-upload.ts); only that endpoint is allowed, every
// other request stays same-origin.
const mediaUploadConnectSrc = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? ` ${new URL(`/storage/v1/object/upload/sign/${MEDIA_BUCKET}/`, process.env.NEXT_PUBLIC_SUPABASE_URL).toString()}`
  : "";

// The Monitor billing page's Server Actions answer a form POST with a redirect
// to Stripe's hosted Checkout or Billing Portal, which browsers check against
// the page's form-action. Only that page's policy adds the two Stripe origins;
// every other page keeps form-action 'self'.
const STRIPE_FORM_ACTION = "https://checkout.stripe.com https://billing.stripe.com";

/**
 * The site's Content-Security-Policy with `formAction` as the form-action
 * source list. Both policies come from here, so they differ in nothing else.
 */
function contentSecurityPolicy(formAction) {
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${mediaImageSrc}`,
    "font-src 'self'",
    `connect-src 'self'${mediaUploadConnectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action ${formAction}`,
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

const csp = contentSecurityPolicy("'self'");
const billingCsp = contentSecurityPolicy(`'self' ${STRIPE_FORM_ACTION}`);

/** @type {import("next").NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      // The Monitor billing page only: the same CSP with Stripe's Checkout and
      // Billing Portal in form-action. These follow the catch-all rule above:
      // when several matching rules set the same header, the last one wins.
      // The page is /monitor/billing on any host, and /billing on the Monitor
      // host (header rules match the requested path, before the middleware
      // rewrites it into /monitor/billing).
      {
        source: MONITOR_BILLING_PATH,
        headers: [{ key: "Content-Security-Policy", value: billingCsp }],
      },
      {
        source: "/billing",
        has: [{ type: "host", value: MONITOR_HOST }],
        headers: [{ key: "Content-Security-Policy", value: billingCsp }],
      },
      {
        source: "/admin/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/mylife/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      // Monitor, its public landing page included. The two sources name the
      // landing and the pages under it separately, like every other area rule
      // names its prefix.
      {
        source: "/monitor",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/monitor/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/auth/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      // The MyLife host serves only the private MyLife area. Header rules match
      // the requested path, before the middleware rewrites it into /mylife
      // (mylife.alnyron.dk/login is /login here), so the host is matched
      // instead: production and the local dev/e2e host, with or without the
      // trailing FQDN dot, like `isMyLifeHost` (`config/mylife.ts`). Next
      // matches `^value$` against the lowercased Host header without its port.
      {
        source: "/:path*",
        has: [{ type: "host", value: "mylife\\.(?:alnyron\\.dk|localhost)\\.?" }],
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      // The Monitor host likewise, every page there (the public landing and
      // signup included): monitor.alnyron.dk/login is /login here, before the
      // middleware rewrites it into /monitor/login. Same host forms as
      // `isMonitorHost` and the same value as MONITOR_ROBOTS (`config/monitor.ts`).
      {
        source: "/:path*",
        has: [{ type: "host", value: MONITOR_HOST }],
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      // Keep the *.workers.dev preview out of search indexes. Every X-Robots-Tag
      // rule uses the same "noindex, nofollow" value, so none weakens another
      // where they overlap (a later matching header rule wins on a shared key).
      {
        source: "/:path*",
        has: [{ type: "host", value: ".*\\.workers\\.dev" }],
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
