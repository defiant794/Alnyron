# Alnyron

Website for Alnyron: Next.js 15 (App Router), React 19, Tailwind CSS v4 and TypeScript, deployed to Cloudflare Workers through OpenNext.

## Getting started

1. Install dependencies: `npm install`
2. Copy the "App" block of `.env.example` to `.env.local` and fill in the values; `src/config/env.ts` is the environment contract, apart from the Stripe variables in the server-only `src/config/stripe-env.ts`. No secret goes in a root `.env*` file: OpenNext compiles every one of them into the Worker bundle. The server secrets `RESEND_API_KEY` and `STRIPE_CHECKOUT_KEY` go in the shell environment for `npm run dev` / `npm run start`, in the git-ignored `.dev.vars` for `npm run preview` and in `wrangler secret put` for the deployed Worker (the "Server secrets" block). Test-only secrets (`SUPABASE_DB_PASSWORD`, `SUPABASE_SECRET_KEY`) go in the git-ignored `tests/.env.e2e` (the "Tests" block).
3. Stripe (the Monitor subscription): `scripts/stripe-setup.mjs` creates the product, the monthly and yearly prices, the 25% moms Tax Rate and the Billing Portal configuration once (a second run creates nothing) and prints only their ids, for `STRIPE_TAX_RATE_ID` and `STRIPE_PORTAL_CONFIGURATION_ID` in `.env.local` and the plans seed. Test mode: `node --env-file=.env.local scripts/stripe-setup.mjs` with a test key in `STRIPE_CHECKOUT_KEY`; that key may sit in `.env.local` for the run, but must be out of every root `.env*` file before `npm run cf:build`, which otherwise fails (as for `RESEND_API_KEY`). A live key is refused without `--live`. The app itself takes a full secret key (`sk_`) only in test mode; in live mode only a restricted `rk_live_` key. `STRIPE_LIVEMODE` (`false` locally, `true` only on the production Worker) must match the key's mode, or the billing actions return their error. Production: at go-live, once the live ids exist, `"STRIPE_LIVEMODE": "true"` and the live `STRIPE_TAX_RATE_ID` and `STRIPE_PORTAL_CONFIGURATION_ID` (none of them secret) go in `wrangler.jsonc` `"vars"`, like `MAIL_FROM`: every deploy sets the Worker's plain variables from that block alone. Only `STRIPE_CHECKOUT_KEY` goes in with `wrangler secret put`. `npm run preview` runs the built Worker with those vars, and they win over `.env.local`, so a preview with a test key then needs `STRIPE_LIVEMODE=false` and the test-mode ids in `.dev.vars`, which override them. The billing actions are rate-limited per user (`BILLING_RATE_LIMITER` in `wrangler.jsonc`: 10 sessions per 60 s, `src/config/payments.ts`); `npm run dev` simulates the binding locally, and without it every billing action fails closed.
4. Start the dev server: `npm run dev`, then open [http://localhost:3000](http://localhost:3000).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build (`next build`) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest) |
| `npm run test:integration` | Integration tests (Vitest) against the Supabase project, each in a rolled-back transaction; needs `SUPABASE_DB_PASSWORD` (environment or `tests/.env.e2e`), TLS verified against `supabase/prod-ca-2021.crt` |
| `npm run test:e2e` | End-to-end tests (Playwright) against a running `npm run dev`, or a production build (`npm run build`, then `npm run start`). For a production build set the same random `E2E_REVALIDATE_SECRET` (`openssl rand -hex 32`) in the shell environment of both `npm run start` and `npm run test:e2e` (never in a file): the category scenarios refresh the ISR cache through the test-only `POST /api/test/revalidate`, which 404s without that variable. The secret is only sent to a loopback `PLAYWRIGHT_BASE_URL` (`localhost`, `127.0.0.1`, `[::1]`); against any other host the refresh is skipped. Reads `tests/.env.e2e`. The home-page category scenarios add and remove marked `e2e-home-*` items in the Supabase project (committed rows, cleaned up before and after; needs `SUPABASE_DB_PASSWORD`); the admin-auth scenarios seed `@alnyron-test.local` admins with random per-run passwords (deleted before and after each block, plus a global sweep before and after the run; the invite and reset flows need `SUPABASE_SECRET_KEY`). Never run them at the same time as `npm run test:integration` or while a production site is served from the same project |
| `npm run cf:build` | OpenNext build for Cloudflare Workers, then `scripts/guard-no-bundled-secrets.mjs` fails the build if a server-only secret (`E2E_REVALIDATE_SECRET`, `RESEND_API_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_PASSWORD`, `STRIPE_CHECKOUT_KEY`) was compiled into `.open-next` (e.g. from a root `.env*` file), or any file there holds a live Stripe key's value (`sk_live_`/`rk_live_`, under any name or none); it reports variable names and files, never values |
| `npm run preview` | OpenNext build + local Workers preview |

## Design system

- Tokens (colour, type, spacing, radius, shadow, motion) live in `src/styles/globals.css` as a Tailwind `@theme` and mirror the project's DESIGN.md, which is the source of truth.
- Font: Inter, self-hosted at build time by `next/font` (`src/styles/fonts.ts`).
- UI primitives are in `src/components/ui/`, the logo in `src/components/brand/`.

## Runbooks

- [Give someone admin or MyLife access](docs/runbooks/area-user-onboarding.md): allowlist row, `admin.createUser`, then an invite link (the signup hook refuses allowlisted emails since migration 0400, which opens public Monitor signup).
