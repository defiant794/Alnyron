"use client";

import { useActionState } from "react";
import { updatePassword } from "@/app/admin/(panel)/set-password/actions";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import SubmitButton from "@/components/ui/SubmitButton";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";

export type SetPasswordFormProps = {
  /** The account's email, offered to password managers alongside the new password. */
  email: string;
  /** Minimum password length, also enforced by the server schema. */
  minLength: number;
  labels: { password: string; passwordHint: string; confirm: string; submit: string };
};

/**
 * New password + repeat, posting to the `updatePassword` Server Action.
 * Errors take the focus; the full-width submit matches the login forms.
 */
export default function SetPasswordForm({ email, minLength, labels }: SetPasswordFormProps) {
  const [state, formAction] = useActionState(updatePassword, {});
  const formRef = useFormResultFocus(state);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-6">
      {/* Lets password managers store the new password under the right account. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      {state.error && (
        <Notice tone="error" role="alert" tabIndex={-1} data-form-result>
          {state.error}
        </Notice>
      )}
      <Field
        label={labels.password}
        hint={labels.passwordHint}
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={minLength}
        required
        error={state.fieldErrors?.password}
      />
      <Field
        label={labels.confirm}
        name="confirm"
        type="password"
        autoComplete="new-password"
        minLength={minLength}
        required
        error={state.fieldErrors?.confirm}
      />
      <SubmitButton className="w-full">{labels.submit}</SubmitButton>
    </form>
  );
}
