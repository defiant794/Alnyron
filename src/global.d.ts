import type { routing } from "@/i18n/routing";
import type da from "../messages/da.json";

// Strict next-intl typing: `Locale` is "da" | "en", and message keys are
// checked against the Danish source file.
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof da;
  }
}
