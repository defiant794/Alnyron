import { parseSupabasePublicEnv } from "@/config/env";
import { MEDIA_BUCKET } from "@/config/catalog";

/**
 * Public URL of a catalog image (`media.storage_path`, e.g.
 * `items/<item-id>/<uuid>.webp`) in the public media bucket. Each path
 * segment is URL-encoded; the slashes between them are kept.
 */
export function publicMediaUrl(storagePath: string): string {
  const { NEXT_PUBLIC_SUPABASE_URL: supabaseUrl } = parseSupabasePublicEnv();
  const path = storagePath.split("/").map(encodeURIComponent).join("/");
  return new URL(`/storage/v1/object/public/${MEDIA_BUCKET}/${path}`, supabaseUrl).toString();
}
