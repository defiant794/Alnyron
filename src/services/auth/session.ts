import { cookies } from "next/headers";
import { createServerClient } from "@/lib/supabase/server";
import { resetPasswordSchema, signInSchema, type SignInInput } from "@/lib/validation/auth";
import { authT, toFieldErrors, type FieldErrors } from "@/services/auth/form-feedback";

/** State of a sign-in form (admin and MyLife `signIn`). */
export type SignInState = {
  /** Form-level message (credentials, rate limit, outage). */
  error?: string;
  fieldErrors?: FieldErrors<SignInInput>;
  /** Echoed so the email field keeps its value after a failed attempt. */
  email?: string;
};

/** State of a forgot-password form (admin and MyLife `requestPasswordReset`). */
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

/**
 * Email + password sign-in (architecture §6), shared by the admin and MyLife
 * `signIn` actions, which send the user on to their area once it succeeds.
 * Every credential failure (wrong password, unknown or unconfirmed account)
 * gets the same message, so the form never reveals whether an account
 * exists. Only rate limiting and an unreachable auth service, which say
 * nothing about the account, get their own message.
 *
 * @returns The state to show, or `null` once signed in.
 */
export async function signInWithPassword(formData: FormData): Promise<SignInState | null> {
  const emailField = formData.get("email");
  const email = typeof emailField === "string" ? emailField : "";
  const parsed = signInSchema.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) return { email, fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (!error) return null;

  const { status } = error;
  const message =
    status === 429
      ? "login.rateLimited"
      : status !== undefined && (status === 0 || status >= 500)
        ? "login.unavailable"
        : "login.invalidCredentials";
  return { email: parsed.data.email, error: authT(message) };
}

/**
 * Send a password-reset link (architecture §6), shared by the admin and
 * MyLife `requestPasswordReset` actions. The answer is the same whether or not
 * the address has an account (no account enumeration); it echoes the
 * submitted address so the form keeps it. Supabase failures go to the server
 * log only.
 *
 * Without `redirectTo` the DA templates build the link from the project's
 * Site URL, `{{ .SiteURL }}/auth/confirm?token_hash=...&next=/admin/set-password`,
 * which also serves invites sent from the dashboard (they carry none). With
 * it (the MyLife host's own origin, never user input) they link
 * `{{ .RedirectTo }}/auth/confirm?...&next=/mylife/set-password`, but only
 * when it is exactly `https://mylife.alnyron.dk` or
 * `http://mylife.localhost:3000`; any other value gets the Site URL link.
 */
export async function sendPasswordResetLink(
  formData: FormData,
  redirectTo: string | null = null,
): Promise<ResetPasswordState> {
  const emailField = formData.get("email");
  const email = typeof emailField === "string" ? emailField : "";
  const parsed = resetPasswordSchema.safeParse({ email });
  if (!parsed.success) return { email, fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createServerClient();
  const { error } = redirectTo
    ? await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo })
    : await supabase.auth.resetPasswordForEmail(parsed.data.email);
  if (error) console.error(`requestPasswordReset failed: ${error.code ?? error.status ?? "unknown"}`);
  return { sent: true, email: parsed.data.email };
}

/**
 * End this browser's session (other devices stay signed in), shared by the
 * admin and MyLife `signOut` actions, which then show their login page. If
 * Supabase cannot revoke the session, the auth cookies are still removed so
 * the browser is signed out either way.
 */
export async function endSession(): Promise<void> {
  const supabase = await createServerClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (!error) return;

  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (name.startsWith("sb-")) cookieStore.delete(name);
  }
}
