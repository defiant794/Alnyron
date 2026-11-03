import { createTranslator, type Locale } from "next-intl";
import { loadMessages } from "@/i18n/messages";
import type { PublicCatalogSection } from "@/services/content/catalog";
import ItemCard from "./ItemCard";

export interface CatalogIndexViewProps {
  locale: Locale;
  section: PublicCatalogSection;
}

/** Cards per row on wide screens (`lg:grid-cols-3`): their images are above the fold. */
const FIRST_ROW_SIZE = 3;

/**
 * Section page body (approved section mock): the section's title and lead,
 * then a card per published item (1, 2 or 3 columns), featured items first.
 * A visually hidden level-2 heading names the card list, so the cards'
 * level-3 titles follow it without skipping a level. All text comes from the
 * DB; Danish fallback text carries `lang="da"` and a blank lead is left out.
 */
export default function CatalogIndexView({ locale, section }: CatalogIndexViewProps) {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: "Catalog" });
  const langOf = (key: string) => (section.fallbackKeys.includes(key) ? "da" : undefined);

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-content flex-col gap-12 px-6 py-16 focus:outline-none md:py-24"
    >
      <header className="flex max-w-2xl flex-col gap-4">
        <h1 lang={langOf("title")} className="text-h1 font-bold tracking-tight">
          {section.title}
        </h1>
        {section.description.trim() !== "" && (
          <p lang={langOf("description")} className="max-w-prose text-h3 text-muted">
            {section.description}
          </p>
        )}
      </header>
      <h2 className="sr-only">{t("itemsHeading")}</h2>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {section.items.map((item, index) => (
          <li key={item.id}>
            <ItemCard
              item={item}
              kind={section.kind}
              featuredLabel={t("featured")}
              priority={index < FIRST_ROW_SIZE}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}
