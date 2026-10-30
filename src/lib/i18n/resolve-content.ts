import type { Locale } from "next-intl";
import { mergeLocalizedWithFallbacks, type LocalizedOverride } from "@/lib/i18n/merge-localized";

/** A DB translation row resolved for one locale. */
export type ResolvedContent<T> = {
  /** Field values for the requested locale, with Danish filling every gap. */
  value: T;
  /**
   * Dotted paths of string fields rendered from the Danish row (`"lead"`,
   * `"content.hero.title"`). Elements showing them on a non-Danish page need
   * `lang="da"` (WCAG 3.1.2). Always empty for Danish.
   */
  fallbackKeys: string[];
};

/**
 * Resolves DB content for `locale`. Danish is the required source row; any
 * other locale uses its own row where a field is a non-blank string and falls
 * back to Danish per field (and per leaf inside JSON fields) otherwise. A
 * missing translation row falls back entirely.
 */
export function resolveContent<T extends object>(
  daRow: T,
  translatedRow: LocalizedOverride<T> | null | undefined,
  locale: Locale,
): ResolvedContent<T> {
  if (locale === "da") return { value: daRow, fallbackKeys: [] };

  const { value, fallbackPaths } = mergeLocalizedWithFallbacks(daRow, translatedRow);
  return { value, fallbackKeys: fallbackPaths };
}
