import type { ReactNode } from "react";
import { cardClassName } from "@/components/ui/card-styles";
import { cx } from "@/lib/cx";

export type OrderPageTone = "success" | "error";

export interface OrderPageProps {
  /** The page's h1. */
  title: string;
  /** A ✓ (success) or ! (error) mark above the title (approved order-pages mock); none for a form. */
  tone?: OrderPageTone;
  children: ReactNode;
}

const MARKS: Record<OrderPageTone, { glyph: string; className: string }> = {
  success: { glyph: "✓", className: "bg-success/10 text-success" },
  error: { glyph: "!", className: "bg-error/10 text-error" },
};

/**
 * The main landmark of an /order page (thanks, error, withdraw): one white
 * card (approved order-pages and order-withdraw mocks) with an optional
 * status mark, the h1 and the page's content. The skip link targets it.
 * Overflow-wrap is inherited, so a long Danish word in a heading breaks
 * inside the word instead of widening the page at 320px (WCAG 1.4.10).
 */
export default function OrderPage({ title, tone, children }: OrderPageProps) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-2xl flex-col px-6 py-12 wrap-break-word focus:outline-none md:py-16"
    >
      <div className={cx(cardClassName("white", false), "flex flex-col gap-6 p-6 md:p-8")}>
        {tone && (
          <span
            aria-hidden="true"
            className={cx(
              "flex size-12 items-center justify-center rounded-pill text-h3 font-bold",
              MARKS[tone].className,
            )}
          >
            {MARKS[tone].glyph}
          </span>
        )}
        <h1 className="text-h2 font-bold tracking-tight">{title}</h1>
        {children}
      </div>
    </main>
  );
}
