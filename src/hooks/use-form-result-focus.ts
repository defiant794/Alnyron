"use client";

import { useEffect, useRef, type RefObject } from "react";

/** Elements that can take the focus after a submission, in priority order within the form. */
const RESULT_TARGETS = '[data-form-result], [aria-invalid="true"]';

/**
 * Keeps keyboard users in place when a Server Action form returns. The submit
 * button is disabled while the action runs, so the browser drops the focus
 * to `<body>`; once a new `state` arrives, focus moves to the first element
 * in the form that is either the form-level message (mark it
 * `data-form-result` and `tabIndex={-1}`) or a field with
 * `aria-invalid="true"`. Focusing the message also reads it out to screen
 * readers. The first render (nothing submitted yet) leaves focus alone.
 *
 * @param state The `useActionState` state; a new object means a new result.
 * @returns A ref for the `<form>`.
 */
export function useFormResultFocus(state: unknown): RefObject<HTMLFormElement | null> {
  const formRef = useRef<HTMLFormElement>(null);
  const initialState = useRef(state);

  useEffect(() => {
    if (state === initialState.current) return;
    formRef.current?.querySelector<HTMLElement>(RESULT_TARGETS)?.focus();
  }, [state]);

  return formRef;
}
