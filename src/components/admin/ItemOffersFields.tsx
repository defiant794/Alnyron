"use client";

import { useId } from "react";
import Field from "@/components/ui/Field";
import { SWITCH_CLASS } from "@/components/ui/switch-styles";
import { OFFER_KINDS, type OfferKind } from "@/config/payments";
import { cx } from "@/lib/cx";
import { formatOreAsKroner, isOfferPriceInRange, parseKronerToOre } from "@/lib/payments/orders/money";
import type { AdminItemOffer } from "@/services/admin/catalog-read";

/** Why an offer price cannot be saved: missing on a live offer, not kroner, or outside the allowed range. */
export type OfferPriceError = "price-required" | "price-format" | "price-range";

/** The offer price problems of a save, per kind. */
export type OfferErrors = Partial<Record<OfferKind, OfferPriceError>>;

/** One offer as `admin_save_item` takes it (`offers` payload key). */
export type OfferInput = { kind: OfferKind; price_ore: number; active: boolean };

export type ItemOffersLabels = {
  heading: string;
  lead: string;
  physicalActive: string;
  physicalPrice: string;
  priceHint: string;
  digitalPrice: string;
  digitalActive: string;
  digitalNote: string;
  errors: Record<OfferPriceError, string>;
};

export type ItemOffersFieldsProps = {
  /** The item's saved offers (none for a new item). */
  offers: AdminItemOffer[];
  /** Price problems of the last save attempt, shown at their fields. */
  errors: OfferErrors;
  labels: ItemOffersLabels;
};

/**
 * The item's offer set from the "Salg" fields of `form`, as the item save's
 * `offers` (it replaces the stored set): a kind with a price in kroner
 * ("249,95", `parseKronerToOre`) is sold at it, live when its switch is on
 * (the digital file never is yet); a kind without a price has no offer, and
 * a live one without a price is an error. A price that is not kroner, or
 * outside {@link isOfferPriceInRange}, is an error at its field.
 */
export function readOffers(form: FormData): { ok: true; offers: OfferInput[] } | { ok: false; errors: OfferErrors } {
  const offers: OfferInput[] = [];
  const errors: OfferErrors = {};
  for (const kind of OFFER_KINDS) {
    const value = form.get(`offers.${kind}.price`);
    const text = typeof value === "string" ? value.trim() : "";
    const active = kind === "physical" && form.get(`offers.${kind}.active`) === "on";
    const priceOre = text === "" ? null : parseKronerToOre(text);
    if (text === "") {
      if (active) errors[kind] = "price-required";
    } else if (priceOre === null) errors[kind] = "price-format";
    else if (!isOfferPriceInRange(priceOre)) errors[kind] = "price-range";
    else offers.push({ kind, price_ore: priceOre, active });
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, offers };
}

/**
 * "Salg" in the item editor, for an item in a 3D section only: "Sælg som
 * 3D-print" (the physical offer's switch) with its price incl. moms and
 * delivery in Denmark, and the digital file's price, whose switch stays off
 * ("kan ikke købes endnu"). Prices are typed in kroner. Uncontrolled: the
 * editor reads the fields on save (`readOffers`).
 */
export default function ItemOffersFields({ offers, errors, labels }: ItemOffersFieldsProps) {
  const baseId = useId();
  const priceOf = (kind: OfferKind) => {
    const offer = offers.find((candidate) => candidate.kind === kind);
    return offer ? formatOreAsKroner(offer.priceOre) : "";
  };
  const physicalActive = offers.some((offer) => offer.kind === "physical" && offer.active);

  return (
    <section aria-labelledby={`${baseId}-heading`} className="flex flex-col gap-4 border-t border-border pt-6">
      <h3 id={`${baseId}-heading`} className="font-semibold">
        {labels.heading}
      </h3>
      <p className="text-small text-muted">{labels.lead}</p>
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
        <span className="font-semibold">{labels.physicalActive}</span>
        <input
          type="checkbox"
          name="offers.physical.active"
          defaultChecked={physicalActive}
          className={SWITCH_CLASS}
        />
      </label>
      <Field
        label={labels.physicalPrice}
        hint={labels.priceHint}
        name="offers.physical.price"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        defaultValue={priceOf("physical")}
        error={errors.physical && labels.errors[errors.physical]}
      />
      <div data-offer-kind="digital" className="flex flex-col gap-4">
        <Field
          label={labels.digitalPrice}
          hint={labels.priceHint}
          name="offers.digital.price"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={priceOf("digital")}
          error={errors.digital && labels.errors[errors.digital]}
        />
        <div className="flex flex-col gap-1">
          <label className="flex min-h-11 cursor-not-allowed items-center justify-between gap-4 text-muted">
            <span className="font-semibold">{labels.digitalActive}</span>
            <input
              type="checkbox"
              name="offers.digital.active"
              disabled
              aria-describedby={`${baseId}-digital-note`}
              className={cx(SWITCH_CLASS, "disabled:cursor-not-allowed disabled:opacity-60")}
            />
          </label>
          <p id={`${baseId}-digital-note`} className="text-small text-muted">
            {labels.digitalNote}
          </p>
        </div>
      </div>
    </section>
  );
}
