import { cache } from "react";
import { getPublicClient } from "@/lib/supabase/public";

/** Company details shown in the footer and contact copy (`site_settings`). */
export interface SiteSettings {
  companyName: string;
  contactEmail: string;
  /** The company's 8-digit Danish CVR number; `null` while it is not set. */
  cvr: string | null;
}

/**
 * Reads the `site_settings` singleton. Deduplicated per render: the footer
 * and the page body both need it.
 *
 * @throws when the query fails or the row is missing, so a broken read never
 *   replaces a good cached page with empty company details.
 */
export const getSiteSettings = cache(async (): Promise<SiteSettings> => {
  const { data, error } = await getPublicClient()
    .from("site_settings")
    .select("company_name, contact_email, cvr");
  if (error) throw new Error(`Failed to load site settings: ${error.message}`);

  const row = data?.[0];
  if (!row) throw new Error("Failed to load site settings: no site_settings row");

  return { companyName: row.company_name, contactEmail: row.contact_email, cvr: row.cvr };
});
