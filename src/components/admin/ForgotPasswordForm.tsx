"use client";

import { useActionState } from "react";
import { requestPasswordReset } from "@/app/admin/(auth)/actions";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import SubmitButton from "@/components/ui/SubmitButton";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";

export type ForgotPasswordFormProps = {
  labels: { email: string; submit: string; sent: string };
};

/**
 * Email form posting to `requestPasswordReset`. The confirmation is the same
 * for every valid address and is announced through a status region that is
 * always in the DOM (`display: contents`, so the empty region adds no gap);
 * it also takes the focus. The form stays and keeps the submitted address
 * (echoed by the action, as React resets the form once the action finishes),
 * so a mistyped address can be corrected.
 */
export default function ForgotPasswordForm({ labels }: ForgotPasswordFormProps) {
  const [state, formAction] = useActionState(requestPasswordReset, {});
  const formRef = useFormResultFocus(state);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-6">
      <div role="status" className="contents">
        {state.sent && (
          <Notice tone="success" tabIndex={-1} data-form-result>
            {labels.sent}
          </Notice>
        )}
      </div>
      <Field
        label={labels.email}
        name="email"
        type="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        defaultValue={state.email}
        error={state.fieldErrors?.email}
      />
      <SubmitButton className="w-full">{labels.submit}</SubmitButton>
    </form>
  );
}
