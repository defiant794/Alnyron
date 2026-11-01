"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { MYLIFE_HOME_PATH, MYLIFE_LOGIN_PATH, myLifeOrigin } from "@/config/mylife";
import { safeNext } from "@/lib/safe-next";
import {
  endSession,
  sendPasswordResetLink,
  signInWithPassword,
  type ResetPasswordState,
  type SignInState,
} from "@/services/auth/session";

/**
 * MyLife sign-in (see `signInWithPassword`). On success: the `next` MyLife
 * path (open-redirect guarded, MyLife area only) or the MyLife home, whose
 * gate checks the role (`requireMyLife()`).
 */
export async function signIn(
  _previous: SignInState | null,
  formData: FormData,
): Promise<SignInState> {
  const failure = await signInWithPassword(formData);
  if (failure) return failure;

  redirect(safeNext(formData.get("next"), "mylife") ?? MYLIFE_HOME_PATH);
}

/**
 * MyLife password reset (see `sendPasswordResetLink`). Asked on the MyLife
 * host, the link must lead back there (the session cookies are per host), so
 * `redirectTo` is that host's origin, taken from the MyLife host allowlist
 * (`myLifeOrigin`), never from user input; the DA templates accept only the
 * two exact MyLife origins (`https://mylife.alnyron.dk`,
 * `http://mylife.localhost:3000`). Asked on the main host
 * (`/mylife/forgot-password`), none is passed and the Site URL link applies;
 * `/auth/confirm` still lands a `mylife_user` on `/mylife/set-password` by
 * role.
 */
export async function requestPasswordReset(
  _previous: ResetPasswordState | null,
  formData: FormData,
): Promise<ResetPasswordState> {
  return sendPasswordResetLink(formData, myLifeOrigin((await headers()).get("host")));
}

/** Sign this browser out (see `endSession`) and go to the MyLife login page. */
export async function signOut(): Promise<void> {
  await endSession();
  redirect(MYLIFE_LOGIN_PATH);
}
