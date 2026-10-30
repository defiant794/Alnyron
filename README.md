# Alnyron

Website for Alnyron: Next.js 15 (App Router), React 19, Tailwind CSS v4 and TypeScript, deployed to Cloudflare Workers through OpenNext.

## Getting started

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in the values. `src/config/env.ts` is the environment contract.
3. Start the dev server: `npm run dev`, then open [http://localhost:3000](http://localhost:3000).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build (`next build`) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest) |
| `npm run test:integration` | Integration tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright) |
| `npm run cf:build` | OpenNext build for Cloudflare Workers |
| `npm run preview` | OpenNext build + local Workers preview |

## Design system

- Tokens (colour, type, spacing, radius, shadow, motion) live in `src/styles/globals.css` as a Tailwind `@theme` and mirror the project's DESIGN.md, which is the source of truth.
- Font: Inter, self-hosted at build time by `next/font` (`src/app/layout.tsx`).
- UI primitives are in `src/components/ui/`, the logo in `src/components/brand/`.
