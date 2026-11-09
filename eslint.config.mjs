import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      // `.next` and any copy of it (`.next.bak.*`), like the `/.next*/` rule in .gitignore.
      ".next*/**",
      ".open-next/**",
      ".wrangler/**",
      "workers/monitor-cron/.wrangler/**",
      "out/**",
      "build/**",
      "cloudflare-env.d.ts",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
