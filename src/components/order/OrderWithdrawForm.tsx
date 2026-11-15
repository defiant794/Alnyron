"use client";

import type { Locale } from "next-intl";
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { useFormStatus } from "react-dom";
import { withdrawOrder } from "@/app/order/withdraw/actions";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";

/** The labels of both steps, resolved on the server (`Order.withdraw`). */
export interface OrderWithdrawLabels {
  orderNumber: string;
  email: string;
  name: string;
  nameHint: string;
  nameMissing: string;
  start: string;
  confirmTitle: string;
  summaryName: string;
  summaryOrderNumber: string;
  summaryEmail: string;
  summaryOrder: string;
  summaryOrderLink: string;
  confirm: string;
  back: string;
  sending: string;
}

export interface OrderWithdrawFormProps {
  /** The page's language: the receipt email's language. */
  locale: Locale;
  /** The personal link's order id and token (only the name is asked), or null (order number and email too). */
  link: { orderId: string; token: string } | null;
  /** The withdrawal statement the consumer confirms (`GOODS_TEXTS[locale].statement`). */
  statement: string;
  /** The goods text version of that statement (`GOODS_TEXT_VERSION`), sent with it. */
  statementVersion: string;
  /** The longest consumer name, in characters (`CONSUMER_NAME_MAX`). */
  nameMaxLength: number;
  labels: OrderWithdrawLabels;
}

type Details = { consumerName: string; orderNumber: string; email: string };

/**
 * The two steps of the online withdrawal function for goods (Art. 11a,
 * approved order-withdraw mock). Step 1 asks for the consumer's name, plus
 * the order number and the order's email without a personal link, and
 * "Fortryd aftale her" moves to step 2 in the browser (no request). Step 2
 * shows the withdrawal statement and the entered details; "Bekræft
 * fortrydelse" sends them to `withdrawOrder`, "Tilbage" returns to step 1
 * with the details kept. While the action runs both buttons are disabled
 * and a status line says it is sending. Focus moves to the step's heading or
 * first field on each switch. Before hydration step 1 cannot submit (React
 * renders a client form action inert), so nothing typed ever reaches a URL.
 */
export default function OrderWithdrawForm({
  locale,
  link,
  statement,
  statementVersion,
  nameMaxLength,
  labels,
}: OrderWithdrawFormProps) {
  const [details, setDetails] = useState<Details>({ consumerName: "", orderNumber: "", email: "" });
  const [confirming, setConfirming] = useState(false);
  const [nameError, setNameError] = useState<string>();
  const headingId = useId();
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const orderNumberField = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  // Focus follows a step switch, never the first render.
  const switched = useRef(false);

  const byLink = link !== null;
  useEffect(() => {
    if (!switched.current) return;
    const stepOneStart = byLink ? nameField : orderNumberField;
    (confirming ? confirmHeading.current : stepOneStart.current)?.focus();
  }, [confirming, byLink]);

  const edit = (key: keyof Details) => (event: ChangeEvent<HTMLInputElement>) =>
    setDetails((current) => ({ ...current, [key]: event.target.value }));

  function toConfirm() {
    // `required` stops an empty name; a name of spaces only gets here.
    if (details.consumerName.trim() === "") {
      setNameError(labels.nameMissing);
      nameField.current?.focus();
      return;
    }
    setNameError(undefined);
    switched.current = true;
    setConfirming(true);
  }

  if (confirming) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <h2 id={headingId} ref={confirmHeading} tabIndex={-1} className="text-h3 font-semibold">
          {labels.confirmTitle}
        </h2>
        <div className="flex flex-col gap-3 rounded-input border border-border bg-surface p-4">
          <p className="font-semibold">{statement}</p>
          <dl className="grid gap-x-4 gap-y-1 text-small sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">{labels.summaryName}</dt>
            <dd className="font-semibold">{details.consumerName.trim()}</dd>
            {link === null ? (
              <>
                <dt className="text-muted">{labels.summaryOrderNumber}</dt>
                <dd className="font-semibold">{details.orderNumber.trim()}</dd>
                <dt className="text-muted">{labels.summaryEmail}</dt>
                <dd className="font-semibold">{details.email.trim()}</dd>
              </>
            ) : (
              <>
                <dt className="text-muted">{labels.summaryOrder}</dt>
                <dd className="font-semibold">{labels.summaryOrderLink}</dd>
              </>
            )}
          </dl>
        </div>
        <form action={withdrawOrder} className="flex flex-col gap-3">
          <input type="hidden" name="channel" value={link === null ? "form" : "link"} />
          {link === null ? (
            <>
              <input type="hidden" name="order_number" value={details.orderNumber.trim()} />
              <input type="hidden" name="email" value={details.email.trim()} />
            </>
          ) : (
            <>
              <input type="hidden" name="order_id" value={link.orderId} />
              <input type="hidden" name="token" value={link.token} />
            </>
          )}
          <input type="hidden" name="consumer_name" value={details.consumerName.trim()} />
          <input type="hidden" name="statement_version" value={statementVersion} />
          <input type="hidden" name="locale" value={locale} />
          <ConfirmButtons
            labels={labels}
            onBack={() => {
              switched.current = true;
              setConfirming(false);
            }}
          />
        </form>
      </section>
    );
  }

  return (
    <form action={toConfirm} className="flex flex-col gap-4">
      {link === null && (
        <>
          <Field
            ref={orderNumberField}
            name="order_number"
            label={labels.orderNumber}
            inputMode="numeric"
            pattern="[0-9]+"
            maxLength={16}
            autoComplete="off"
            required
            value={details.orderNumber}
            onChange={edit("orderNumber")}
          />
          <Field
            name="email"
            type="email"
            label={labels.email}
            maxLength={320}
            autoComplete="email"
            required
            value={details.email}
            onChange={edit("email")}
          />
        </>
      )}
      <Field
        ref={nameField}
        name="consumer_name"
        label={labels.name}
        hint={labels.nameHint}
        error={nameError}
        maxLength={nameMaxLength}
        autoComplete="name"
        required
        value={details.consumerName}
        onChange={edit("consumerName")}
      />
      <Button type="submit" className="self-start">
        {labels.start}
      </Button>
    </form>
  );
}

/**
 * "Bekræft fortrydelse" and "Tilbage" of the confirm step: both disabled while
 * the form's action runs, with a status line saying it is sending.
 */
function ConfirmButtons({ labels, onBack }: { labels: OrderWithdrawLabels; onBack: () => void }) {
  const { pending } = useFormStatus();
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="submit" loading={pending}>
          {labels.confirm}
        </Button>
        <Button variant="secondary" onClick={onBack} disabled={pending}>
          {labels.back}
        </Button>
      </div>
      <p role="status" className="text-small text-muted">
        {pending ? labels.sending : ""}
      </p>
    </>
  );
}
