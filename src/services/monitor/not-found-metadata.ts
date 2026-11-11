import type { Metadata } from "next";
import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { MONITOR_ROBOTS } from "@/config/monitor";

/**
 * Metadata of the Monitor 404 ("Siden findes ikke", in the visitor's
 * Monitor `locale`): the not-found boundary's own, and what a monitor page
 * returns for an unknown or foreign id. Next.js keeps the page's resolved
 * metadata when its render calls `notFound()`, so those pages must title
 * themselves as the 404 too (WCAG 2.4.2).
 */
export async function monitorNotFoundMetadata(locale: Locale): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: "Monitor.notFound" });
  return { title: t("title"), robots: MONITOR_ROBOTS };
}
