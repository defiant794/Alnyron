"use client";

import { useFormStatus } from "react-dom";
import Button, { type ButtonProps } from "./Button";

export type SubmitButtonProps = Omit<ButtonProps, "type" | "loading">;

/**
 * Submit button for a Server Action form: shows the busy state (spinner,
 * `aria-busy`, disabled) while its form is submitting, so it cannot be sent
 * twice. Without JavaScript it is a plain submit button.
 */
export default function SubmitButton(props: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return <Button {...props} type="submit" loading={pending} />;
}
