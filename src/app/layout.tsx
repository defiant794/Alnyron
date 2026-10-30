/**
 * Passthrough root layout. The public document (`<html lang>`, fonts, skip
 * link) lives in `app/[locale]/layout.tsx`, so the language follows the
 * route; this file exists so `app/not-found.tsx` can render unmatched paths.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
