"use client";

import Image from "next/image";
import { useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import { MEDIA_ALT_MAX, MEDIA_MAX_BYTES, MEDIA_MAX_PER_ITEM } from "@/config/catalog";
import { cx } from "@/lib/cx";
import { checkMediaFile, prepareImage, putSignedUpload, uploadTypeFor } from "@/lib/media-upload";
import { publicMediaUrl } from "@/lib/public-media-url";
import type { CatalogActionError, CatalogActionResult, CatalogSaveResult } from "@/services/admin/catalog";
import type { MediaUploadResult } from "@/services/admin/media";

/** One image of the item, in its order. */
export type MediaManagerImage = {
  id: string;
  /** Public URL of the image (thumbnail). */
  src: string;
  /** `media.storage_path`. */
  path: string;
  altDa: string;
  altEn: string;
  /** 1-based place in the item's gallery. */
  position: number;
};

/** The errors MediaManager shows; any other failure reads as `failed`. */
export type MediaManagerError = "too-large" | "unsupported-type" | "too-many-media" | "alt-required" | "failed";

/** What `createMediaUpload` needs: the item, and type and size of the file about to be uploaded. */
export type MediaUploadInput = { itemId: string; mimeType: string; size: number };

/** What `attachMedia` needs once the object is stored. */
export type MediaAttachInput = {
  itemId: string;
  path: string;
  alt_da: string;
  alt_en: string;
  width: number;
  height: number;
};

export type MediaManagerProps = {
  /** The saved item's id; `undefined` for a new item (uploads need a saved item). */
  itemId: string | undefined;
  /** The item's images in their order. */
  images: MediaManagerImage[];
  /** The `createMediaUpload` Server Action. */
  onCreateUpload: (input: MediaUploadInput) => Promise<MediaUploadResult>;
  /** The `attachMedia` Server Action. */
  onAttach: (input: MediaAttachInput) => Promise<CatalogSaveResult>;
  /** The `detachMedia` Server Action. */
  onDetach: (mediaId: string) => Promise<CatalogActionResult>;
  /**
   * Danish alt text a new image starts with (the item's title), so it can be
   * attached at once; the admin refines it in the list. Without it, the
   * file's name is used.
   */
  defaultAlt?: string;
  /** Marks every image whose Danish alt text is blank (after a save failed with `alt-required`). */
  showAltErrors?: boolean;
  labels: {
    heading: string;
    saveFirst: string;
    empty: string;
    addImage: string;
    uploading: string;
    /** Shown in the drop zone when a file is dragged over it while an upload or removal runs. */
    busy: string;
    altDaLabel: string;
    altEnLabel: string;
    /**
     * Word before an image's position in the alt-text inputs' accessible
     * names ("billede": "Alt-tekst (DA), billede 2"), so each image's inputs
     * have their own name.
     */
    image: string;
    remove: string;
    confirmRemove: string;
    errors: Record<MediaManagerError, string>;
    countOf: (count: number, max: number) => string;
    /** Text before the "Tilføj billede" button in the drop zone ("Træk et billede hertil, eller"). */
    dropHint?: string;
    /** Accepted types and size, under the drop zone. */
    formats?: string;
    /** Move controls; without them the order is fixed here. */
    moveUp?: string;
    moveDown?: string;
  };
};

const SHOWN_ERRORS: readonly MediaManagerError[] = ["too-large", "unsupported-type", "too-many-media", "alt-required"];

/** The MediaManager error for a service failure. */
function shownError(error: CatalogActionError | MediaManagerError): MediaManagerError {
  return SHOWN_ERRORS.find((candidate) => candidate === error) ?? "failed";
}

/**
 * "Billeder" of the item editor (approved item-editor mock). States: a new
 * item shows "Gem elementet før upload" and no upload control; a saved one a
 * drop zone with "Tilføj billede", the count ("2 af 8"), "Ingen billeder
 * endnu" while empty, and its images with thumbnail, Danish (required) and
 * English alt text, move controls and "Fjern" (after a confirm).
 *
 * One upload at a time: the file is checked here first (type, size: no
 * request for a refused file), then `onCreateUpload` checks the item's room
 * and mints a signed upload URL under the admin's session; the browser
 * re-encodes the image (scaled to at most 2400px, WebP where it can encode
 * it, metadata dropped), PUTs it straight to the bucket and `onAttach`
 * records it. While that runs the list shows an "Uploader" tile and the
 * upload controls are disabled.
 *
 * The drop zone cancels every drag over it, so a dropped file never makes
 * the browser open it in place of the editor. While it cannot take a file
 * (an upload or removal runs, or the item holds the maximum), a dragged file
 * shows the "not allowed" cursor and the zone says why instead of taking it.
 *
 * Alt texts and order are part of the item form: the inputs are named
 * `media.<id>.alt_da` / `.alt_en` and `media.order` lists the ids in order,
 * so the editor's save sends them.
 */
export default function MediaManager({
  itemId,
  images: initialImages,
  onCreateUpload,
  onAttach,
  onDetach,
  defaultAlt,
  showAltErrors = false,
  labels,
}: MediaManagerProps) {
  const [images, setImages] = useState(initialImages);
  const [uploading, setUploading] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<{ code: MediaManagerError; fileName?: string } | null>(null);
  const [drag, setDrag] = useState<"accept" | "refuse" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const full = images.length >= MEDIA_MAX_PER_ITEM;
  const busy = uploading !== null || removing !== null;

  async function upload(file: File) {
    if (!itemId || busy) return;
    const checked = checkMediaFile(file);
    if (!checked.ok) {
      setError({ code: checked.error, fileName: file.name });
      return;
    }
    if (full) {
      setError({ code: "too-many-media", fileName: file.name });
      return;
    }

    setError(null);
    setUploading(file.name);
    const fail = (code: CatalogActionError | MediaManagerError) => setError({ code: shownError(code), fileName: file.name });
    try {
      const type = uploadTypeFor(checked.type);
      const slot = await onCreateUpload({ itemId, mimeType: type, size: file.size });
      if (!slot.ok) return fail(slot.error);

      const prepared = await prepareImage(file, type);
      if (!prepared.ok) return fail(prepared.error);
      const { blob, width, height } = prepared.image;
      if (blob.size > MEDIA_MAX_BYTES) return fail("too-large");
      if (!(await putSignedUpload(slot.path, slot.token, blob, type))) return fail("failed");

      const altDa = defaultAlt?.trim() || file.name.replace(/\.[^.]*$/, "");
      const attached = await onAttach({ itemId, path: slot.path, alt_da: altDa, alt_en: "", width, height });
      if (!attached.ok) return fail(attached.error);

      setImages((current) => [
        ...current,
        {
          id: attached.id,
          src: publicMediaUrl(slot.path),
          path: slot.path,
          altDa,
          altEn: "",
          position: current.length + 1,
        },
      ]);
    } catch {
      fail("failed");
    } finally {
      setUploading(null);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    // Cleared so picking the same file again still fires a change.
    event.currentTarget.value = "";
    if (file) void upload(file);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    // Cancelled even when refused: an uncancelled drop makes the browser open the file, leaving the editor.
    event.preventDefault();
    const accepts = !busy && !full;
    event.dataTransfer.dropEffect = accepts ? "copy" : "none";
    setDrag(accepts ? "accept" : "refuse");
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDrag(null);
    const file = event.dataTransfer.files[0];
    if (file) void upload(file);
  }

  async function remove(image: MediaManagerImage) {
    if (busy || !window.confirm(labels.confirmRemove)) return;
    setRemoving(image.id);
    try {
      const result = await onDetach(image.id);
      if (result.ok) {
        setError(null);
        setImages((current) => current.filter((candidate) => candidate.id !== image.id));
      } else {
        setError({ code: shownError(result.error) });
      }
    } catch {
      setError({ code: "failed" });
    } finally {
      setRemoving(null);
    }
  }

  function move(index: number, to: number) {
    setImages((current) => {
      const image = current[index];
      if (!image || to < 0 || to >= current.length) return current;
      return current.toSpliced(index, 1).toSpliced(to, 0, image);
    });
  }

  function updateAlt(id: string, key: "altDa" | "altEn", value: string) {
    setImages((current) => current.map((image) => (image.id === id ? { ...image, [key]: value } : image)));
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-h3 font-semibold">
          {labels.heading}
        </h2>
        {itemId && <p className="text-small text-muted">{labels.countOf(images.length, MEDIA_MAX_PER_ITEM)}</p>}
      </div>

      {!itemId ? (
        <p className="rounded-card border border-dashed border-border-input bg-surface px-4 py-6 text-center text-muted">
          {labels.saveFirst}
        </p>
      ) : (
        <>
          <div
            onDragOver={handleDragOver}
            onDragLeave={() => setDrag(null)}
            onDrop={handleDrop}
            className={cx(
              "flex flex-col items-center gap-2 rounded-card border-2 border-dashed px-4 py-6 text-center transition-[background-color,border-color]",
              drag === "accept"
                ? "border-accent bg-accent/5"
                : drag === "refuse"
                  ? "border-error bg-error/5"
                  : "border-border-input bg-surface",
            )}
          >
            <p className="flex flex-wrap items-center justify-center gap-2 text-muted">
              {labels.dropHint && <span>{labels.dropHint}</span>}
              <Button
                variant="secondary"
                loading={uploading !== null}
                disabled={busy || full}
                onClick={() => fileInput.current?.click()}
              >
                {labels.addImage}
              </Button>
            </p>
            {labels.formats && <p className="text-small text-muted">{labels.formats}</p>}
            {(full || drag === "refuse") && (
              <p className={cx("text-small", drag === "refuse" ? "font-semibold text-error" : "text-muted")}>
                {full ? labels.errors["too-many-media"] : labels.busy}
              </p>
            )}
            {/* No `accept`: a refused type gets a message instead of silently vanishing from the picker. */}
            <input ref={fileInput} type="file" hidden disabled={busy || full} onChange={handleFileChange} />
          </div>

          {error && (
            <div role="alert" className="flex flex-col gap-1 rounded-input border border-error bg-error/5 px-3 py-control-y">
              <p className="text-small font-semibold text-error">{labels.errors[error.code]}</p>
              {error.fileName && <p className="text-small break-all text-muted">{error.fileName}</p>}
            </div>
          )}

          {images.length === 0 && uploading === null ? (
            <p className="text-muted">{labels.empty}</p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {images.map((image, index) => (
                <li key={image.id} className="flex flex-col overflow-hidden rounded-card border border-border bg-bg">
                  <input type="hidden" name="media.order" value={image.id} />
                  <div className="relative h-32 bg-surface">
                    <Image src={image.src} alt="" fill sizes="(min-width: 640px) 320px, 100vw" className="object-cover" />
                  </div>
                  <div className="flex flex-col gap-3 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1 text-small text-muted">
                        <span aria-hidden="true">{index + 1}</span>
                        {labels.moveUp && labels.moveDown && (
                          <>
                            <MoveButton
                              label={`${labels.moveUp}: ${index + 1}`}
                              glyph="↑"
                              disabled={busy || index === 0}
                              onClick={() => move(index, index - 1)}
                            />
                            <MoveButton
                              label={`${labels.moveDown}: ${index + 1}`}
                              glyph="↓"
                              disabled={busy || index === images.length - 1}
                              onClick={() => move(index, index + 1)}
                            />
                          </>
                        )}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        aria-busy={removing === image.id || undefined}
                        onClick={() => void remove(image)}
                        className="inline-flex min-h-11 cursor-pointer items-center rounded-btn px-2 text-small font-semibold text-error transition-[background-color] not-disabled:hover:bg-error/5 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {labels.remove}
                      </button>
                    </div>
                    <Field
                      label={labels.altDaLabel}
                      aria-label={`${labels.altDaLabel}, ${labels.image} ${index + 1}`}
                      name={`media.${image.id}.alt_da`}
                      value={image.altDa}
                      onChange={(event) => updateAlt(image.id, "altDa", event.currentTarget.value)}
                      maxLength={MEDIA_ALT_MAX}
                      required
                      autoComplete="off"
                      error={showAltErrors && image.altDa.trim() === "" ? labels.errors["alt-required"] : undefined}
                    />
                    <Field
                      label={labels.altEnLabel}
                      aria-label={`${labels.altEnLabel}, ${labels.image} ${index + 1}`}
                      name={`media.${image.id}.alt_en`}
                      value={image.altEn}
                      onChange={(event) => updateAlt(image.id, "altEn", event.currentTarget.value)}
                      maxLength={MEDIA_ALT_MAX}
                      autoComplete="off"
                    />
                  </div>
                </li>
              ))}
              {uploading !== null && (
                <li className="flex flex-col overflow-hidden rounded-card border border-accent/40 bg-accent/5">
                  <div className="flex h-32 items-center justify-center">
                    <span
                      aria-hidden="true"
                      className="size-6 animate-spin rounded-pill border-2 border-accent border-t-transparent motion-reduce:animate-none"
                    />
                  </div>
                  <div role="status" className="flex flex-col gap-1 p-3">
                    <p className="text-small font-semibold text-accent">{labels.uploading}</p>
                    <p className="text-small break-all text-muted">{uploading}</p>
                  </div>
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Small arrow button that moves an image one place (name from `label`, the arrow is decorative). */
function MoveButton({
  label,
  glyph,
  disabled,
  onClick,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-11 cursor-pointer items-center justify-center rounded-btn transition-[background-color,color] not-disabled:hover:bg-surface not-disabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only">{label}</span>
    </button>
  );
}
