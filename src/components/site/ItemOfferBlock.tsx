import { createTranslator, type Locale } from "next-intl";
import { cardClassName } from "@/components/ui/card-styles";
import Link from "@/components/ui/Link";
import { GOODS_TEXTS } from "@/config/legal/goods-texts";
import { GOODS_CHECKOUT_ROUTE } from "@/config/payments";
import { SYSTEM_PAGE_PATHNAMES } from "@/config/system-pages";
import { loadMessages } from "@/i18n/messages";
import { getPathname } from "@/i18n/navigation";
import { cx } from "@/lib/cx";
import BuyButton from "./BuyButton";
import { formatOfferPrice } from "./offer-price";

export interface ItemOfferBlockProps {
  /** The item and its active physical offer's price (øre incl. moms and delivery). */
  offer: { itemId: string; priceOre: number };
  locale: Locale;
}

/**
 * The item page's purchase block (approved item-buy mock) for an item with an
 * active physical offer: the price and its note (`formatOfferPrice`, as on
 * the item's card), the Buy form, the facts (Denmark only, dispatch time,
 * withdrawal period, return shipping, payment on dispatch) and a link to
 * /terms. The form is a native POST to `/api/checkout/item` with only the
 * item id and the page's language, so the static page needs no session; the
 * route asks the payments Worker for a Stripe Checkout and redirects there.
 * The note, facts and link label are the versioned legal texts
 * (`GOODS_TEXTS`), the rest UI messages.
 */
export default function ItemOfferBlock({ offer, locale }: ItemOfferBlockProps) {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: "Catalog.offer" });
  const texts = GOODS_TEXTS[locale].itemPage;
  const price = formatOfferPrice(offer.priceOre, locale);

  return (
    <section aria-label={t("label")} className={cx(cardClassName("surface", false), "flex flex-col gap-4 p-6")}>
      <div className="flex flex-col gap-0.5">
        <p className="text-h2 font-bold">{price.text}</p>
        <p className="text-small text-muted">{price.vat}</p>
      </div>
      <form method="post" action={GOODS_CHECKOUT_ROUTE}>
        <input type="hidden" name="item_id" value={offer.itemId} />
        <input type="hidden" name="locale" value={locale} />
        <BuyButton label={t("buy")} pendingLabel={t("buyPending")} className="w-full" />
      </form>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-small text-muted">
        {texts.facts.map((fact) => (
          <li key={fact} className="flex gap-1.5">
            <span aria-hidden="true" className="text-success">
              ✓
            </span>
            {fact}
          </li>
        ))}
      </ul>
      <Link
        href={getPathname({ href: SYSTEM_PAGE_PATHNAMES.terms, locale })}
        className="inline-flex min-h-11 items-center self-start text-small"
      >
        {texts.termsLinkLabel}
      </Link>
    </section>
  );
}
