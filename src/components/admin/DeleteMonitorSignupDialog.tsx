"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import type { DeleteMonitorUserError } from "@/services/admin/monitor-users";

/** The dialog's copy; its body comes from the client provider (`Admin.monitorUsers.delete.body`). */
export type DeleteMonitorSignupDialogLabels = {
  title: string;
  confirm: string;
  /** Confirm button text while the delete runs. */
  pending: string;
  cancel: string;
  errors: { failed: string; notFound: string; notMonitorUser: string; hasActiveSubscription: string };
};

export type DeleteMonitorSignupDialogProps = {
  /** The `<dialog>` element: the table opens it with `showModal()` for the chosen signup. */
  ref: RefObject<HTMLDialogElement | null>;
  /** Address of the signup the dialog asks about (null until a Slet button was used). */
  email: string | null;
  /** Whether the delete runs: the buttons are disabled and the dialog's `cancel` (Escape) is prevented. */
  pending: boolean;
  /**
   * Why the last attempt failed, shown as an alert. After `not-found` "Slet tilmelding" stays disabled
   * (nothing is left to delete). Once the delete has ended with a failure the focus moves into the open
   * dialog: to "Slet tilmelding" after `failed` (a retry may succeed), to Annuller otherwise.
   */
  error: DeleteMonitorUserError | null;
  labels: DeleteMonitorSignupDialogLabels;
  /** "Slet tilmelding" was pressed. */
  onConfirm: () => void;
  /** The dialog closed, whichever way. */
  onClose: () => void;
};

const ERROR_LABELS = {
  failed: "failed",
  "not-found": "notFound",
  "not-monitor-user": "notMonitorUser",
  "has-active-subscription": "hasActiveSubscription",
} as const satisfies Record<DeleteMonitorUserError, keyof DeleteMonitorSignupDialogLabels["errors"]>;

/** The address in the body, in bold. */
function strong(chunks: ReactNode) {
  return <strong className="font-semibold wrap-anywhere text-fg">{chunks}</strong>;
}

/**
 * Modal confirmation for deleting one Monitor signup (Admin › Monitor-brugere):
 * named by its title and described by its body, which names the address and
 * says the account and all its monitors go for good. Only "Slet tilmelding"
 * deletes. While the delete runs its buttons are disabled and its `cancel`
 * (Escape) is prevented; Chromium may still close it on a repeated Escape, so
 * the table opens it again for a failure: the outcome shows here, a failure
 * as an alert above the buttons, with the focus on "Slet tilmelding" when a
 * retry may succeed (`failed`) and on Annuller when there is nothing to retry.
 */
export default function DeleteMonitorSignupDialog({
  ref,
  email,
  pending,
  error,
  labels,
  onConfirm,
  onClose,
}: DeleteMonitorSignupDialogProps) {
  const t = useTranslations("Admin.monitorUsers.delete");
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // A failure leaves the focus outside the buttons: the browser drops it from "Slet tilmelding" once that is
  // disabled for the delete, and a dialog the table opened again meanwhile found both buttons disabled.
  // Keyed on `pending` too: the alert can commit while the buttons are still disabled and cannot take it.
  useEffect(() => {
    if (pending || error === null || !ref.current?.open) return;
    (error === "failed" ? confirmRef : cancelRef).current?.focus();
  }, [pending, error, ref]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-card border border-border bg-bg p-6 text-fg shadow-card backdrop:bg-fg/40"
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h2 id={titleId} className="text-h3 font-semibold">
            {labels.title}
          </h2>
          <p id={bodyId} className="text-muted">
            {email !== null && t.rich("body", { email, strong })}
          </p>
        </div>
        {error && (
          <Notice tone="error" role="alert">
            {labels.errors[ERROR_LABELS[error]]}
          </Notice>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <Button ref={cancelRef} variant="secondary" disabled={pending} onClick={() => ref.current?.close()}>
            {labels.cancel}
          </Button>
          <Button ref={confirmRef} variant="danger" loading={pending} disabled={error === "not-found"} onClick={onConfirm}>
            {pending ? labels.pending : labels.confirm}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
