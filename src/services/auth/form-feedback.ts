import { createTranslator } from "next-intl";
import { z } from "zod";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { loadMessages } from "@/i18n/messages";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, type AuthValidationKey } from "@/lib/validation/auth";

const messages = loadMessages(AUTH_LOCALE);

/**
 * Danish auth copy (`Auth` in `messages/da.json`) for the auth Server Actions
 * of both areas (admin and MyLife): validation and Supabase errors.
 */
export const authT = createTranslator({ locale: AUTH_LOCALE, messages, namespace: "Auth" });

/** Danish message per invalid form field (first problem only). */
export type FieldErrors<Input> = { [Field in keyof Input]?: string };

const isValidationKey = (key: string): key is AuthValidationKey =>
  Object.hasOwn(messages.Auth.validation, key);

/**
 * Turn a failed `lib/validation/auth` parse into Danish field messages. The
 * schemas put a message key on every issue; anything else (never expected)
 * falls back to the generic "invalid" message of the email rule rather than
 * leaking zod's English text.
 */
export function toFieldErrors<Input>(error: z.ZodError<Input>): FieldErrors<Input> {
  const { fieldErrors } = z.flattenError(error);
  const result: FieldErrors<Input> = {};
  for (const field of Object.keys(fieldErrors) as (keyof Input & string)[]) {
    const key = fieldErrors[field]?.[0];
    if (key === undefined) continue;
    result[field] = authT(`validation.${isValidationKey(key) ? key : "emailInvalid"}`, {
      min: MIN_PASSWORD_LENGTH,
      max: MAX_PASSWORD_BYTES,
    });
  }
  return result;
}
