import type { Messages } from "next-intl";
import { z } from "zod";

/**
 * Key of a validation message in `messages/*.json` (`Auth.validation`).
 * Every issue these schemas raise carries such a key as its message, so the
 * caller shows copy from the message files (in the area's language) instead
 * of zod's English.
 */
export type AuthValidationKey = keyof Messages["Auth"]["validation"];

/** Issue options that set the message key (zod 4 `error` param). */
function issue(key: AuthValidationKey) {
  return { error: key };
}

/** bcrypt, which Supabase Auth stores passwords with, reads at most 72 bytes. */
export const MAX_PASSWORD_BYTES = 72;

/** Matches `minimum_password_length` in `supabase/config.toml` and the dashboard. */
export const MIN_PASSWORD_LENGTH = 12;

// RFC 5321 caps an address at 254 characters. Surrounding whitespace is
// trimmed first so a pasted address with a trailing space still validates.
const email = z
  .string(issue("emailInvalid"))
  .trim()
  .pipe(z.email(issue("emailInvalid")).max(254, issue("emailInvalid")));

/** Sign-in form: any non-empty password (existing passwords may predate the length rule). */
export const signInSchema = z.object({
  email,
  password: z.string(issue("passwordRequired")).min(1, issue("passwordRequired")),
});

/** Forgot-password form. */
export const resetPasswordSchema = z.object({ email });

/** A password being chosen: the length rule Supabase Auth enforces, checked first. */
const newPassword = z
  .string(issue("passwordTooShort"))
  .min(MIN_PASSWORD_LENGTH, issue("passwordTooShort"))
  .refine(
    (value) => new TextEncoder().encode(value).length <= MAX_PASSWORD_BYTES,
    issue("passwordTooLong"),
  );

/** Set-password form (invite and recovery links): length rule plus a matching repeat. */
export const setPasswordSchema = z
  .object({
    password: newPassword,
    confirm: z.string(issue("passwordMismatch")),
  })
  .refine((data) => data.password === data.confirm, {
    ...issue("passwordMismatch"),
    path: ["confirm"],
  });

/** Monitor signup form: email plus a new password (one field, no repeat, per the signup mock). */
export const signUpSchema = z.object({ email, password: newPassword });

export type SignInInput = z.infer<typeof signInSchema>;
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
