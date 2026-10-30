import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseSupabasePublicEnv } from "@/config/env";
import type { Database } from "@/types/database";

/**
 * Supabase client for public pages, the sitemap and build-time params
 * (architecture §6). It uses the publishable key and never touches cookies or
 * headers, so pages reading through it stay static (SSG/ISR). Anonymous RLS
 * applies: only published content is visible.
 *
 * A new client per call: it holds no session, so there is nothing to share.
 */
export function getPublicClient(): SupabaseClient<Database> {
  const env = parseSupabasePublicEnv();
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
