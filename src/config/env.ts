import { z } from "zod";

/**
 * Environment contract. Validated LAZILY — this module must never validate at
 * import time (so `import "@/config/env"` is always safe, AC-14). Call the parse
 * helpers where the values are actually needed.
 *
 * Error messages name every missing/invalid variable and NEVER include a
 * variable's value (AC-8…AC-12).
 */

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.url(),
});

const serverSchema = z.object({
  RESEND_API_KEY: z.string().min(1),
  MAIL_FROM: z.string().min(1),
});

// The Supabase subset of the public contract, for code that needs only the
// database (the public client), not the site URL.
const supabasePublicSchema = publicSchema.pick({
  NEXT_PUBLIC_SUPABASE_URL: true,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: true,
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type SupabasePublicEnv = z.infer<typeof supabasePublicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

function parseWith<T>(
  schema: z.ZodType<T>,
  source: Record<string, string | undefined>,
  label: string,
): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    const names = Array.from(
      new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ).join(", ");
    throw new Error(`Invalid or missing ${label} environment variables: ${names}`);
  }
  return result.data;
}

// Default source must reference each NEXT_PUBLIC_* var LITERALLY: Next.js only
// inlines `process.env.NEXT_PUBLIC_X` literals into the client bundle, so
// passing the whole `process.env` would be empty (and throw) in the browser.
export function parsePublicEnv(
  source: Record<string, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  },
): PublicEnv {
  return parseWith(publicSchema, source, "public");
}

/** Supabase URL + publishable key only; same literal-reference rule as above. */
export function parseSupabasePublicEnv(
  source: Record<string, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  },
): SupabasePublicEnv {
  return parseWith(supabasePublicSchema, source, "Supabase public");
}

export function parseServerEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  return parseWith(serverSchema, source, "server");
}

/** Reads process.env at CALL time (lazy), not at import time (AC-15). */
export function getServerEnv(): ServerEnv {
  return parseServerEnv(process.env);
}
