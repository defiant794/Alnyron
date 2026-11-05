import createNextIntlPlugin from "next-intl/plugin";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Mirrors MEDIA_BUCKET in src/config/catalog.ts (kept in sync; this .mjs config
// is loaded by Node directly and cannot import the TypeScript source).
const MEDIA_BUCKET = "media";

// Points next-intl's server APIs at the per-request config (locale + messages).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Populates getCloudflareContext() (KV + other bindings) during `next dev` via
// the wrangler platform proxy. No-op in production/build.
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

const csp = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${mediaImageSrc}`,
  "font-src 'self'",
  `connect-src 'self'${mediaUploadConnectSrc}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

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
      {
        source: "/admin/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/mylife/:path*",
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
