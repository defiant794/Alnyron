import { vi } from "vitest";
import type { Locale } from "next-intl";
import { loadMessages } from "@/i18n/messages";

type TranslationsOptions = { locale: Locale; namespace?: string };

/**
 * `vi.mock("next-intl/server", ...)` factory for rendering server components
 * in unit tests. There is no request context, so callers pass `locale`
 * explicitly; translations come from the real `messages/*.json` with the
 * Danish fallback merge. A missing key throws instead of echoing the key, so
 * a typo fails the test.
 */
export function nextIntlServerMock() {
  return {
    setRequestLocale: vi.fn(),
    getTranslations: vi.fn(async ({ locale, namespace }: TranslationsOptions) => {
      const messages = loadMessages(locale);
      return (key: string) => {
        const path = namespace ? `${namespace}.${key}` : key;
        const value = path
          .split(".")
          .reduce<unknown>(
            (node, part) =>
              typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined,
            messages,
          );
        if (typeof value !== "string") throw new Error(`Missing message "${path}" for locale "${locale}"`);
        return value;
      };
    }),
  };
}
