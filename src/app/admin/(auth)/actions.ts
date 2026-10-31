"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_HOME_PATH, ADMIN_LOGIN_PATH } from "@/config/admin";
import { safeNext } from "@/lib/safe-next";
import { createServerClient } from "@/lib/supabase/server";
import { resetPasswordSchema, signInSchema, type SignInInput } from "@/lib/validation/auth";
import { authT, toFieldErrors, type FieldErrors } from "@/services/auth/form-feedback";

export type SignInState = {
  /** Form-level message (credentials, rate limit, outage). */
  error?: string;
  fieldErrors?: FieldErrors<SignInInput>;
  /** Echoed so the email field keeps its value after a failed attempt. */
  email?: string;
};

export type ResetPasswordState = {
  /** True once the request was handed to Supabase, whether or not the address has an account. */
  sent?: boolean;
  fieldErrors?: FieldErrors<{ email: string }>;
  /**
   * Echoed so the email field keeps its value after a field error and after
   * sending (React resets the form once the action finishes). It is the
   * address the user typed, so it reveals nothing about the account.
   */
  email?: string;
};

const formString = (value: FormDataEntryValue | null): string =>
  typeof value === "string" ? value : "";

/**
 * Email + password sign-in (architecture §6). Every credential failure (wrong
 * password, unknown or unconfirmed account) gets the same message, so the
 * form never reveals whether an account exists. Only rate limiting and an
 * unreachable auth service, which say nothing about the account, get their
 * own message. On success: the `next` admin path (open-redirect guarded) or
 * the panel home.
 */
export async function signIn(
  _previous: SignInState | null,
  formData: FormData,
): Promise<SignInState> {
  const email = formString(formData.get("email"));
  const parsed = signInSchema.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) return { email, fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    const status = error.status;
    const message =
      status === 429
        ? "login.rateLimited"
        : status !== undefined && (status === 0 || status >= 500)
          ? "login.unavailable"
          : "login.invalidCredentials";
    return { email: parsed.data.email, error: authT(message) };
  }

  redirect(safeNext(formString(formData.get("next"))) ?? ADMIN_HOME_PATH);
}

/**
 * Send a password-reset link (architecture §6). The answer is the same
 * whether or not the address has an account (no account enumeration); it
 * echoes the submitted address so the form keeps it. Supabase failures go
 * to the server log only. No `redirectTo` is passed:
 * the DA recovery template builds its link from the project's Site URL,
 * `{{ .SiteURL }}/auth/confirm?token_hash=...&type=recovery&next=/admin/set-password`
 * (the invite template likewise), so the link works for resets and for
 * invites sent from the dashboard, which carry no `redirectTo`.
 */
export async function requestPasswordReset(
  _previous: ResetPasswordState | null,
  formData: FormData,
): Promise<ResetPasswordState> {
  const email = formString(formData.get("email"));
  const parsed = resetPasswordSchema.safeParse({ email });
  if (!parsed.success) return { email, fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email);
  if (error) console.error(`requestPasswordReset failed: ${error.code ?? error.status ?? "unknown"}`);
  return { sent: true, email: parsed.data.email };
}

/**
 * End this browser's session (other devices stay signed in) and go to the
 * login page. If Supabase cannot revoke the session, the auth cookies are
 * still removed so the browser is signed out either way.
 */
export async function signOut(): Promise<void> {
  const supabase = await createServerClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) {
    const cookieStore = await cookies();
    for (const { name } of cookieStore.getAll()) {
      if (name.startsWith("sb-")) cookieStore.delete(name);
    }
  }
  redirect(ADMIN_LOGIN_PATH);
}
