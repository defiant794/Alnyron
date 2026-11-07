"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import SubmitButton from "@/components/ui/SubmitButton";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";
import type { SignUpResult } from "@/services/auth/session";

export type SignupFormProps = {
  /** The Monitor `signUp` Server Action. */
  action: (previous: SignUpResult | null, formData: FormData) => Promise<SignUpResult>;
  /** Minimum password length, also enforced by the server schema. */
  minLength: number;
  labels: {
    email: string;
    emailPlaceholder: string;
    password: string;
    passwordHint: string;
    submit: string;
    confirmationTitle: string;
    rateLimited: string;
    unavailable: string;
  };
};

/**
 * Email + password signup (approved signup mock) posting to the Monitor
 * `signUp` Server Action. Works without JavaScript. Once Supabase has the
 * request, the form gives way to "Tjek din e-mail" (the same answer whether
 * the address is new, already has an account or is refused), announced
 * through a status region that is always in the DOM and focused; its body
 * (`Monitor.signup.confirmationBody`, which the page provides to the client)
 * names the typed address. Input problems show on their field; rate limiting
 * and an unavailable service show above the fields; errors take the focus.
 */
export default function SignupForm({ action, minLength, labels }: SignupFormProps) {
  const t = useTranslations("Monitor.signup");
  const [state, formAction] = useActionState(action, null);
  const formRef = useFormResultFocus(state);
  const confirmationRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (state?.type === "confirmation") confirmationRef.current?.focus();
  }, [state]);

  const formError =
    state?.type === "rate_limited" ? labels.rateLimited : state?.type === "unavailable" ? labels.unavailable : null;
  const fieldErrors = state?.type === "field_error" ? state.fieldErrors : undefined;

  return (
    <>
      <div role="status" className="contents">
        {state?.type === "confirmation" && (
          <section className="flex flex-col gap-2 rounded-input border border-success bg-success/5 p-4 text-center">
            <h2 ref={confirmationRef} tabIndex={-1} className="text-h3 font-semibold text-success">
              {labels.confirmationTitle}
            </h2>
            <p className="text-small">{t("confirmationBody", { email: state.email })}</p>
          </section>
        )}
      </div>
      {state?.type !== "confirmation" && (
        <form ref={formRef} action={formAction} className="flex flex-col gap-6">
          {formError && (
            <Notice tone="error" role="alert" tabIndex={-1} data-form-result>
              {formError}
            </Notice>
          )}
          <Field
            label={labels.email}
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            placeholder={labels.emailPlaceholder}
            defaultValue={state?.email}
            error={fieldErrors?.email}
          />
          <Field
            label={labels.password}
            hint={labels.passwordHint}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={minLength}
            required
            error={fieldErrors?.password}
          />
          <SubmitButton className="w-full">{labels.submit}</SubmitButton>
        </form>
      )}
    </>
  );
}
