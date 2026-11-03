import type { FormattedPrice } from "@/lib/format-price";

export interface PriceTextProps {
  price: FormattedPrice;
  /** Size and weight of the price itself; the VAT note is always small, regular and muted. */
  className?: string;
}

/** A catalog price with its VAT note after it ("fra 12.000 kr. inkl. moms", "Kontakt"). */
export default function PriceText({ price, className }: PriceTextProps) {
  return (
    <p className={className}>
      {price.text}
      {price.vat && (
        <>
          {" "}
          <span className="text-small font-normal text-muted">{price.vat}</span>
        </>
      )}
    </p>
  );
}
