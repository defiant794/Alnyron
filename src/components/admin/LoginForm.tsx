"use client";

import { useActionState } from "react";
import { signIn } from "@/app/admin/(auth)/actions";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import SubmitButton from "@/components/ui/SubmitButton";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";

export type LoginFormProps = {
  /** Admin path to return to after signing in (already passed through `safeNext`). */
  next: string | null;
  labels: { email: string; password: string; submit: string };
};

/**
 * Email + password form posting to the `signIn` Server Action. Works without
 * JavaScript; with it, the button shows a busy state and errors render in
 * place, taking the focus. A failed attempt keeps the email and clears the
 * password.
 */
export default function LoginForm({ next, labels }: LoginFormProps) {
  const [state, formAction] = useActionState(signIn, {});
  const formRef = useFormResultFocus(state);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-6">
      {next && <input type="hidden" name="next" value={next} />}
      {state.error && (
        <Notice tone="error" role="alert" tabIndex={-1} data-form-result>
          {state.error}
        </Notice>
      )}
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
      <Field
        label={labels.password}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={state.fieldErrors?.password}
      />
      <SubmitButton className="w-full">{labels.submit}</SubmitButton>
    </form>
  );
}
