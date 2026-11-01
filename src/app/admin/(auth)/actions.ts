"use server";

import { redirect } from "next/navigation";
import { ADMIN_HOME_PATH, ADMIN_LOGIN_PATH } from "@/config/admin";
import { safeNext } from "@/lib/safe-next";
import {
  endSession,
  sendPasswordResetLink,
  signInWithPassword,
  type ResetPasswordState,
  type SignInState,
} from "@/services/auth/session";

/**
 * Admin sign-in (see `signInWithPassword`). On success: the `next` admin path
 * (open-redirect guarded, admin area only) or the panel home.
 */
export async function signIn(
  _previous: SignInState | null,
  formData: FormData,
): Promise<SignInState> {
  const failure = await signInWithPassword(formData);
  if (failure) return failure;

  redirect(safeNext(formData.get("next"), "admin") ?? ADMIN_HOME_PATH);
}

/**
 * Admin password reset (see `sendPasswordResetLink`). No `redirectTo`: the
 * DA templates link the Site URL's `/auth/confirm` with
 * `next=/admin/set-password`.
 */
export async function requestPasswordReset(
  _previous: ResetPasswordState | null,
  formData: FormData,
): Promise<ResetPasswordState> {
  return sendPasswordResetLink(formData);
}

/** Sign this browser out (see `endSession`) and go to the admin login page. */
export async function signOut(): Promise<void> {
  await endSession();
  redirect(ADMIN_LOGIN_PATH);
}
