import { createTranslator, type Locale } from "next-intl";
import { z } from "zod";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { loadMessages } from "@/i18n/messages";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, type AuthValidationKey } from "@/lib/validation/auth";

function createAuthTranslator(locale: Locale) {
  return createTranslator({ locale, messages: loadMessages(locale), namespace: "Auth" });
}

const AUTH_TRANSLATORS = {
  da: createAuthTranslator("da"),
  en: createAuthTranslator("en"),
} satisfies Record<Locale, unknown>;

/**
 * Auth copy (`Auth` in `messages/*.json`) in `locale`, for the auth Server
 * Actions: validation and Supabase errors. The admin and MyLife areas ask for
 * Danish (`AUTH_LOCALE`, their only language); Monitor for its visitor's
 * language.
 */
export function authTranslator(locale: Locale) {
  return AUTH_TRANSLATORS[locale];
}

/** Message per invalid form field (first problem only), in the form's language. */
export type FieldErrors<Input> = { [Field in keyof Input]?: string };

const isValidationKey = (key: string): key is AuthValidationKey =>
  Object.hasOwn(loadMessages(AUTH_LOCALE).Auth.validation, key);

/**
 * Turn a failed `lib/validation/auth` parse into field messages in `locale`
 * (Danish unless given). The schemas put a message key on every issue;
 * anything else (never expected) falls back to the generic "invalid" message
 * of the email rule rather than leaking zod's English text.
 */
export function toFieldErrors<Input>(error: z.ZodError<Input>, locale: Locale = AUTH_LOCALE): FieldErrors<Input> {
  const { fieldErrors } = z.flattenError(error);
  const t = authTranslator(locale);
  const result: FieldErrors<Input> = {};
  for (const field of Object.keys(fieldErrors) as (keyof Input & string)[]) {
    const key = fieldErrors[field]?.[0];
    if (key === undefined) continue;
    result[field] = t(`validation.${isValidationKey(key) ? key : "emailInvalid"}`, {
      min: MIN_PASSWORD_LENGTH,
      max: MAX_PASSWORD_BYTES,
    });
  }
  return result;
}
