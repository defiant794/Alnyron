import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// Path aliases (@/*) via vite-tsconfig-paths; React/JSX transform via plugin-react.
// With `projects` defined, root plugins do not propagate, so each project repeats them.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react(), tsconfigPaths()],
        // css.postcss inline object: passing an object bypasses the
        // postcss.config.mjs file lookup entirely (Vite only skips it when an
        // inline object is given).  Empty plugins[] = no PostCSS transforms,
        // so Tailwind v4's @import "tailwindcss" does not crash unit tests.
        css: { postcss: { plugins: [] } },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          // next-intl's ESM imports `next/navigation` without an extension,
          // which native Node cannot resolve (next has no exports map). Run it
          // through Vite instead; this also lets vi.mock("next/navigation")
          // reach next-intl's own router hooks.
          server: { deps: { inline: ["next-intl"] } },
        },
      },
      {
        plugins: [react(), tsconfigPaths()],
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
