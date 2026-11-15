"use client";

import { useLocale, useTranslations } from "next-intl";
import { unstable_rethrow } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { approveRefund, type ApproveRefundError, type ApproveRefundResult } from "@/app/admin/(panel)/orders/actions";
import Button from "@/components/ui/Button";
import { cardClassName } from "@/components/ui/card-styles";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import TextAreaField from "@/components/ui/TextAreaField";
import { ORDER_GOODS_STATES, type OrderGoodsState } from "@/config/payments";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";
import { cx } from "@/lib/cx";
import { formatKronerWithOre } from "@/lib/payments/money";
import { parseKronerToOre } from "@/lib/payments/orders/money";

export type OrderRefundFormProps = {
  /** Whether the approval can be given: a withdrawal waits for it, or `offline`; the order is not refunded. */
  available: boolean;
  /**
   * No withdrawal yet: the owner records a notice that came by email or letter. The approval
   * creates the withdrawal (`payments_approve_order_refund`, channel `admin`); only the heading and
   * lead differ.
   */
  offline: boolean;
  orderId: string;
  orderNumber: number;
  /** The order's email, named in the confirmation. */
  email: string;
  /** The goods were shipped: only "returned" is possible; else only "not shipped". */
  shipped: boolean;
  /** The payment was captured (at dispatch, or at Checkout): a refund; else the reservation is released. */
  captured: boolean;
  /** What can still be refunded in øre (the total less earlier refunds); the whole reservation when uncaptured. */
  availableOre: number;
};

/** The deduction problems shown at the fields before anything is sent. */
type FieldError = Extract<ApproveRefundError, "deduction-format" | "deduction-too-large" | "reason-required">;

/**
 * "Behandl fortrydelse" on an order's admin page (approved order-detail mock,
 * amendment A1): the goods state the owner confirms (returned for a shipped
 * order, not shipped otherwise; the other option is disabled, as the payments
 * Worker would refuse it). Returned goods take an optional deduction for
 * diminished value in kroner and its reason, and show the refund it leaves;
 * goods never shipped release the reservation ("intet trækkes", no
 * deduction), or refund in full what was captured at Checkout. For an order
 * without a withdrawal (`offline`) the same form is "Registrér fortrydelse":
 * it records a notice the buyer sent by email or letter. The first button
 * checks the deduction and asks for confirmation (the amount and the buyer's
 * email, "Det kan ikke fortrydes"); the second has the Worker approve and
 * refund or release it (`approveRefund`). The outcome is shown here in Danish
 * and takes the focus; the section stays to show it after the refreshed page
 * drops the form, so the page renders it always and passes `available`. Copy:
 * `Admin.orders.detail` (`refund`, `errors`).
 */
export default function OrderRefundForm({
  available,
  offline,
  orderId,
  orderNumber,
  email,
  shipped,
  captured,
  availableOre,
}: OrderRefundFormProps) {
  const t = useTranslations("Admin.orders.detail");
  const locale = useLocale();
  const goodsState: OrderGoodsState = shipped ? "returned" : "not_shipped";
  const [deduction, setDeduction] = useState("");
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [fieldError, setFieldError] = useState<{ error: FieldError } | null>(null);
  const [result, setResult] = useState<ApproveRefundResult | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useFormResultFocus(fieldError);
  const confirmRef = useRef<HTMLParagraphElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const backRequested = useRef(false);
  const baseId = useId();

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

  const returned = goodsState === "returned";
  const deductionOre = returned && deduction.trim() !== "" ? parseKronerToOre(deduction) : 0;
  const refundOre = deductionOre === null ? null : availableOre - deductionOre;
  const kroner = (ore: number) => formatKronerWithOre(ore, locale);
  const confirming = step === "confirm";
  const fieldMessage = fieldError && t(`errors.${fieldError.error}`);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || confirming) return;
    let error: FieldError | null = null;
    if (deductionOre === null) error = "deduction-format";
    else if (refundOre === null || refundOre < 1) error = "deduction-too-large";
    else if (deductionOre > 0 && reason.trim() === "") error = "reason-required";
    setResult(null);
    if (error) setFieldError({ error });
    else setStep("confirm");
  }

  function handleConfirm() {
    if (pending) return;
    const formData = new FormData();
    formData.set("orderId", orderId);
    formData.set("orderNumber", String(orderNumber));
    formData.set("goodsState", goodsState);
    if (returned) {
      formData.set("deduction", deduction);
      formData.set("deductionReason", reason);
    }
    startTransition(async () => {
      let outcome: ApproveRefundResult;
      try {
        outcome = await approveRefund(formData);
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
    <section aria-labelledby={`${baseId}-heading`} className={cx(cardClassName("white", false), "flex flex-col gap-4 p-6")}>
      <h2 id={`${baseId}-heading`} className="text-h3 font-semibold">
        {offline ? t("refund.offlineHeading") : t("refund.heading")}
      </h2>
      {available && (
        <form ref={formRef} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
          <p className="text-small text-muted">{offline ? t("refund.offlineLead") : t("refund.lead")}</p>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-small font-semibold">{t("refund.goodsState")}</legend>
            {ORDER_GOODS_STATES.map((state) => (
              <label
                key={state}
                className="flex min-h-11 items-center gap-2 rounded-input border border-border-input px-3 text-small has-checked:border-accent has-checked:bg-accent/5 has-checked:font-semibold has-disabled:cursor-not-allowed has-disabled:border-border has-disabled:text-muted"
              >
                <input
                  type="radio"
                  name="goodsState"
                  value={state}
                  defaultChecked={state === goodsState}
                  disabled={state !== goodsState}
                  className="size-4 shrink-0 accent-accent"
                />
                {state === "returned" ? t("refund.returned") : t("refund.notShipped")}
              </label>
            ))}
          </fieldset>
          {returned ? (
            <>
              <Field
                label={t("refund.deduction")}
                hint={t("refund.deductionHint")}
                name="deduction"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={deduction}
                readOnly={confirming}
                onChange={(event) => {
                  setDeduction(event.currentTarget.value);
                  setFieldError(null);
                }}
                error={fieldError?.error !== "reason-required" ? (fieldMessage ?? undefined) : undefined}
              />
              <TextAreaField
                label={t("refund.reason")}
                name="deductionReason"
                rows={3}
                maxLength={500}
                value={reason}
                readOnly={confirming}
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                  setFieldError(null);
                }}
                error={fieldError?.error === "reason-required" ? (fieldMessage ?? undefined) : undefined}
              />
              {refundOre !== null && refundOre >= 1 && (
                <p className="rounded-input bg-surface p-3 text-small">
                  {deductionOre === 0
                    ? t("refund.computedFull", { refund: kroner(refundOre) })
                    : t("refund.computed", {
                        refund: kroner(refundOre),
                        available: kroner(availableOre),
                        deduction: kroner(deductionOre ?? 0),
                      })}
                </p>
              )}
            </>
          ) : (
            <p className="rounded-input bg-surface p-3 text-small font-semibold">
              {captured ? t("refund.refundAll", { amount: kroner(availableOre) }) : t("refund.release")}
            </p>
          )}
          {confirming && refundOre !== null ? (
            <div className="flex flex-col gap-3 rounded-input bg-surface p-4">
              <p ref={confirmRef} tabIndex={-1} className="font-semibold">
                {captured
                  ? t("refund.confirmRefund", { amount: kroner(refundOre), email })
                  : t("refund.confirmRelease", { amount: kroner(availableOre), email })}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button variant="danger" loading={pending} onClick={handleConfirm}>
                  {captured ? t("refund.refundButton", { amount: kroner(refundOre) }) : t("refund.releaseButton")}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={handleBack}>
                  {t("refund.back")}
                </Button>
              </div>
            </div>
          ) : (
            <Button ref={submitRef} type="submit" className="w-full">
              {returned ? t("refund.submitReturned") : t("refund.submitNotShipped")}
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
          {result.ok ? t(`refund.done.${result.status}`) : t(`errors.${result.error}`)}
        </Notice>
      )}
    </section>
  );
}
