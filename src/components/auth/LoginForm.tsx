"use client";

import { useActionState, useEffect, useRef } from "react";
import Field from "@/components/ui/Field";
import Link from "@/components/ui/Link";
import Notice from "@/components/ui/Notice";
import SubmitButton from "@/components/ui/SubmitButton";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";
import type { SignInState } from "@/services/auth/session";

export type LoginFormProps = {
  /** The area's `signIn` Server Action (admin or MyLife). */
  action: (previous: SignInState, formData: FormData) => Promise<SignInState>;
  /** Path to return to after signing in (already passed through `safeNext` for the area). */
  next: string | null;
  /** The area's forgot-password page, offered right after a failed sign-in's message. */
  forgotPasswordHref: string;
  labels: { email: string; password: string; submit: string; resetPassword: string };
  /** Example values shown in the empty fields (the MyLife login mock). */
  placeholders?: { email: string; password: string };
  /**
   * Message the page arrives with, e.g. why a dead invite or reset link sent
   * the user here (`?error=link_invalid`). It is in the server HTML, so its
   * `role="alert"` is never announced as a change; it takes the focus on
   * arrival instead, which reads it out (unless the user already focused
   * something before the page hydrated).
   */
  initialError?: string;
};

/**
 * Email + password form posting to a `signIn` Server Action. Works without
 * JavaScript; with it, the button shows a busy state and errors render in
 * place, taking the focus. A failed attempt keeps the email, clears the
 * password and links to the area's forgot-password page.
 */
export default function LoginForm({
  action,
  next,
  forgotPasswordHref,
  labels,
  placeholders,
  initialError,
}: LoginFormProps) {
  const [state, formAction] = useActionState(action, {});
  const formRef = useFormResultFocus(state);
  const initialErrorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const focused = document.activeElement;
    if (focused === null || focused === document.body) initialErrorRef.current?.focus();
  }, []);

  return (
    <>
      {initialError && (
        <Notice ref={initialErrorRef} tone="error" role="alert" tabIndex={-1}>
          {initialError}
        </Notice>
      )}
      <form ref={formRef} action={formAction} className="flex flex-col gap-6">
        {next && <input type="hidden" name="next" value={next} />}
        {state.error && (
          // The reset link sits right after the message (the next Tab stop
          // from the focused alert), outside it so the alert stays the message.
          <div className="flex flex-col">
            <Notice tone="error" role="alert" tabIndex={-1} data-form-result>
              {state.error}
            </Notice>
            <Link href={forgotPasswordHref} className="inline-flex min-h-11 items-center self-start">
              {labels.resetPassword}
            </Link>
          </div>
        )}
        <Field
          label={labels.email}
          name="email"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          placeholder={placeholders?.email}
          defaultValue={state.email}
          error={state.fieldErrors?.email}
        />
        <Field
          label={labels.password}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder={placeholders?.password}
          error={state.fieldErrors?.password}
        />
        <SubmitButton className="w-full">{labels.submit}</SubmitButton>
      </form>
    </>
  );
}
