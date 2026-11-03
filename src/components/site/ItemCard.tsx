import Image from "next/image";
import NextLink from "next/link";
import { cardClassName } from "@/components/ui/card-styles";
import { KIND_GLYPH, type CatalogKind } from "@/config/catalog";
import { cx } from "@/lib/cx";
import type { PublicCatalogItem } from "@/services/content/catalog";
import PriceText from "./PriceText";

export interface ItemCardProps {
  item: PublicCatalogItem;
  /** The section's kind: picks the {@link KIND_GLYPH} shown when the item has no image. */
  kind: CatalogKind;
  /** Text of the badge on a featured item ("Udvalgt"). */
  featuredLabel: string;
  /** Load the image eagerly with high priority: cards in the first row are above the fold (LCP). */
  priority: boolean;
}

/**
 * One item on a section page (approved section mock): its first image, or
 * the kind's glyph on a tinted panel, edge to edge on top; the "Udvalgt"
 * badge on a featured item; then title, summary and price. The title is a
 * level-3 heading at the DESIGN.md h3 size (20/28), below the section page's
 * list heading; it links to the item page and the link covers the whole card.
 * Text shown from Danish on another locale carries `lang="da"`; a blank
 * summary or a missing price is left out.
 */
export default function ItemCard({ item, kind, featuredLabel, priority }: ItemCardProps) {
  const langOf = (key: string) => (item.fallbackKeys.includes(key) ? "da" : undefined);
  const [image] = item.media;

  return (
    <article className={cx(cardClassName("white", true), "flex h-full flex-col")}>
      <div className="relative h-36 overflow-hidden rounded-t-card bg-linear-135 from-accent/10 to-surface">
        {image ? (
          <Image
            src={image.src}
            alt={image.alt}
            lang={image.lang}
            width={image.width}
            height={image.height}
            priority={priority}
            sizes="(min-width: 1024px) 352px, (min-width: 640px) 50vw, 100vw"
            className="size-full object-cover"
          />
        ) : (
          <span aria-hidden="true" className="flex size-full items-center justify-center text-h1 text-accent/30">
            {KIND_GLYPH[kind]}
          </span>
        )}
        {item.featured && (
          <span className="absolute top-3 left-3 rounded-pill bg-accent px-pill-x py-pill-y text-xs leading-5 font-semibold text-accent-ink">
            {featuredLabel}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="text-h3 font-semibold">
          <NextLink
            href={item.href}
            lang={langOf("title")}
            className="after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-focus"
          >
            {item.title}
          </NextLink>
        </h3>
        {item.summary.trim() !== "" && (
          <p lang={langOf("summary")} className="flex-1 text-small text-muted">
            {item.summary}
          </p>
        )}
        {item.price && <PriceText price={item.price} className="font-semibold" />}
      </div>
    </article>
  );
}
