"use client";

import { useRef } from "react";
import Button from "@/components/ui/Button";
import SubmitButton from "@/components/ui/SubmitButton";

export type DeleteMonitorDialogProps = {
  /** `deleteMonitorAction` bound to the monitor. */
  action: (formData: FormData) => Promise<void>;
  labels: { open: string; title: string; body: string; confirm: string; cancel: string };
};

/**
 * "Slet" on the monitor page: opens a modal dialog that names what is lost
 * and asks again; only "Slet overvågning" in the dialog deletes. The native
 * `<dialog>` traps focus, closes on Escape and returns focus to "Slet".
 * Without JavaScript the dialog cannot open, so nothing can be deleted by
 * accident.
 */
export default function DeleteMonitorDialog({ action, labels }: DeleteMonitorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <Button variant="danger" aria-haspopup="dialog" onClick={() => dialogRef.current?.showModal()}>
        {labels.open}
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby="delete-monitor-title"
        aria-describedby="delete-monitor-body"
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-card border border-border bg-bg p-6 text-fg shadow-card backdrop:bg-fg/40"
      >
        <form action={action} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h2 id="delete-monitor-title" className="text-h3 font-semibold">
              {labels.title}
            </h2>
            <p id="delete-monitor-body" className="text-muted">
              {labels.body}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="secondary" onClick={() => dialogRef.current?.close()}>
              {labels.cancel}
            </Button>
            <SubmitButton variant="danger">{labels.confirm}</SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
