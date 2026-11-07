"use server";

import { redirect } from "next/navigation";
import { MONITOR_DASHBOARD_PATH, MONITOR_LOGIN_PATH } from "@/config/monitor";
import { safeNext } from "@/lib/safe-next";
import { requireMonitor } from "@/services/auth/require-role";
import {
  endSession,
  sendPasswordResetLink,
  signInWithPassword,
  signUpWithPassword,
  type ResetPasswordState,
  type SignInState,
  type SignUpResult,
} from "@/services/auth/session";
import { setPassword, type SetPasswordState } from "@/services/auth/set-password";

/**
 * Monitor sign-in (see `signInWithPassword`). On success: the `next` Monitor
 * path (open-redirect guarded, Monitor area only) or the dashboard, whose
 * gate checks the role (`requireMonitor()`). An account whose email is not
 * confirmed yet cannot sign in (Supabase refuses it like a wrong password).
 */
export async function signIn(
  _previous: SignInState | null,
  formData: FormData,
): Promise<SignInState> {
  const failure = await signInWithPassword(formData);
  if (failure) return failure;

  redirect(safeNext(formData.get("next"), "monitor") ?? MONITOR_DASHBOARD_PATH);
}

/**
 * Public Monitor signup (see `signUpWithPassword`): no session and no
 * redirect; the user confirms the address through the emailed link.
 */
export async function signUp(_previous: SignUpResult | null, formData: FormData): Promise<SignUpResult> {
  return signUpWithPassword(formData);
}

/**
 * Monitor password reset (see `sendPasswordResetLink`). No `redirectTo`: the
 * Site URL link of the DA template applies, and `/auth/confirm` lands a
 * `monitor_user` on `/monitor/reset` by role.
 */
export async function requestPasswordReset(
  _previous: ResetPasswordState | null,
  formData: FormData,
): Promise<ResetPasswordState> {
  return sendPasswordResetLink(formData);
}

/**
 * Set a new password (see `setPassword`): the end of a reset link
 * (`/monitor/reset`) and the change-password form in the settings. Owner and
 * `monitor_user` only. Success: the dashboard.
 */
export async function updatePassword(
  _previous: SetPasswordState | null,
  formData: FormData,
): Promise<SetPasswordState> {
  await requireMonitor();

  const failure = await setPassword(formData);
  if (failure) return failure;

  redirect(MONITOR_DASHBOARD_PATH);
}

/** Sign this browser out (see `endSession`) and go to the Monitor login page. */
export async function signOut(): Promise<void> {
  await endSession();
  redirect(MONITOR_LOGIN_PATH);
}
