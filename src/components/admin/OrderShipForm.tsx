"use client";

import { useLocale, useTranslations } from "next-intl";
import { unstable_rethrow } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { markShipped, type ShipOrderResult } from "@/app/admin/(panel)/orders/actions";
import Button from "@/components/ui/Button";
import { cardClassName } from "@/components/ui/card-styles";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import { cx } from "@/lib/cx";
import { formatKronerWithOre } from "@/lib/payments/money";

export type OrderShipFormProps = {
  /** Whether the order can be shipped now: reserved, with no withdrawal. */
  available: boolean;
  orderId: string;
  orderNumber: number;
  /** The payment was captured at Checkout already, so nothing is charged now. */
  captured: boolean;
  /** What the capture charges, in øre (the order's total). */
  amountOre: number;
};

/**
 * "Markér afsendt" on an order's admin page (approved order-detail mock,
 * amendment A1): an optional tracking reference and "Markér afsendt og træk
 * betalingen", which first asks for confirmation (the amount charged and the
 * order number; it cannot be undone), then has the payments Worker capture
 * the reserved payment, mark the order shipped and email the buyer
 * (`markShipped`). The confirm button shows a spinner while that runs; the
 * outcome is shown here in Danish (a refused capture names what to do) and
 * takes the focus, as the button is disabled meanwhile and gone once the
 * refreshed page shows the order shipped. The section stays to show the
 * outcome after the form is gone, so the page renders it always and passes
 * `available`. Copy: `Admin.orders.detail` (`ship`, `errors`) from the page's
 * client provider.
 */
export default function OrderShipForm({ available, orderId, orderNumber, captured, amountOre }: OrderShipFormProps) {
  const t = useTranslations("Admin.orders.detail");
  const locale = useLocale();
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [result, setResult] = useState<ShipOrderResult | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const confirmRef = useRef<HTMLParagraphElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const backRequested = useRef(false);
  const headingId = useId();

  useEffect(() => {
    if (step === "confirm") confirmRef.current?.focus();
    else if (backRequested.current) {
      backRequested.current = false;
      submitRef.current?.focus();
    }
  }, [step]);

  useEffect(() => {
    if (!pending && result) noticeRef.current?.focus();
  }, [pending, result]);

  if (!available && result === null) return null;

  const amount = formatKronerWithOre(amountOre, locale);
  const number = String(orderNumber);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || step === "confirm") return;
    // A repeated outcome is a new notice, announced and focused again.
    setResult(null);
    setStep("confirm");
  }

  function handleConfirm() {
    if (pending || !formRef.current) return;
    const formData = new FormData(formRef.current);
    startTransition(async () => {
      let outcome: ShipOrderResult;
      try {
        outcome = await markShipped(formData);
      } catch (caught) {
        // A redirect from the action (an expired session) is the router's; a request that got no answer is not.
        unstable_rethrow(caught);
        outcome = { ok: false, error: "unavailable" };
      }
      setResult(outcome);
      setStep("edit");
    });
  }

  function handleBack() {
    backRequested.current = true;
    setStep("edit");
  }

  return (
    <section aria-labelledby={headingId} className={cx(cardClassName("white", false), "flex flex-col gap-4 p-6")}>
      <h2 id={headingId} className="text-h3 font-semibold">
        {t("ship.heading")}
      </h2>
      {available && (
        <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4">
          <p className="text-small text-muted">{captured ? t("ship.leadCaptured") : t("ship.lead")}</p>
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="orderNumber" value={orderNumber} />
          <Field
            label={t("ship.tracking")}
            name="trackingRef"
            placeholder={t("ship.trackingPlaceholder")}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            readOnly={step === "confirm"}
          />
          {step === "confirm" ? (
            <div className="flex flex-col gap-3 rounded-input bg-surface p-4">
              <p ref={confirmRef} tabIndex={-1} className="font-semibold">
                {captured ? t("ship.confirmShip", { number }) : t("ship.confirmCapture", { amount, number })}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button loading={pending} onClick={handleConfirm}>
                  {captured ? t("ship.shipButton") : t("ship.captureButton", { amount })}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={handleBack}>
                  {t("ship.back")}
                </Button>
              </div>
            </div>
          ) : (
            <Button ref={submitRef} type="submit" className="w-full">
              {captured ? t("ship.submitCaptured") : t("ship.submit")}
            </Button>
          )}
        </form>
      )}
      {result && (
        <Notice
          ref={noticeRef}
          tabIndex={-1}
          tone={result.ok ? "success" : "error"}
          role={result.ok ? "status" : "alert"}
        >
          {result.ok ? t(`ship.done.${result.status}`) : t(`errors.${result.error}`)}
        </Notice>
      )}
    </section>
  );
}
