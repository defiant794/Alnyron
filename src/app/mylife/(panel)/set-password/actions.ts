"use server";

import { redirect } from "next/navigation";
import { MYLIFE_HOME_PATH } from "@/config/mylife";
import { requireMyLife } from "@/services/auth/require-role";
import { setPassword, type SetPasswordState } from "@/services/auth/set-password";

/**
 * Set the signed-in MyLife user's password (`/mylife/set-password`, the end
 * of the invite and reset links; see `setPassword`). Owner and `mylife_user`
 * only. Success: the MyLife home.
 */
export async function updatePassword(
  _previous: SetPasswordState | null,
  formData: FormData,
): Promise<SetPasswordState> {
  await requireMyLife();

  const failure = await setPassword(formData);
  if (failure) return failure;

  redirect(MYLIFE_HOME_PATH);
}
