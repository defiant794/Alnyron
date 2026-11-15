"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";

export interface BuyButtonProps {
  /** The button's label ("Køb"). */
  label: string;
  /** Shown while the browser leaves for Stripe's payment page ("Sender dig til betaling …"). */
  pendingLabel: string;
  className?: string;
}

/**
 * Submit button of the item page's Buy form (`ItemOfferBlock`), which stays a
 * native POST: the static item page needs no session, and buying works
 * without JavaScript. With JavaScript, the first submit of its form disables
 * the button and shows `pendingLabel` (`useFormStatus` does not fire for a
 * form posting to a URL, so the button listens to its own form's submit
 * event), and every further submit is cancelled: one click opens one
 * Checkout. A page the browser restores from its back/forward cache (back
 * from Stripe) has the button ready again.
 */
export default function BuyButton({ label, pendingLabel, className }: BuyButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    let sent = false;
    const onSubmit = (event: SubmitEvent) => {
      if (sent) {
        event.preventDefault();
        return;
      }
      sent = true;
      setPending(true);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      sent = false;
      setPending(false);
    };
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return (
    <Button ref={ref} type="submit" loading={pending} className={className}>
      {pending ? pendingLabel : label}
    </Button>
  );
}
