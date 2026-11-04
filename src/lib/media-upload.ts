import {
  MEDIA_BUCKET,
  MEDIA_MAX_BYTES,
  MEDIA_MAX_DIMENSION,
  MEDIA_MIME_TYPES,
  MEDIA_WEBP_QUALITY,
  type MediaMimeType,
} from "@/config/catalog";
import { getPublicClient } from "@/lib/supabase/public";

/**
 * Browser side of a catalog image upload (admin MediaManager): check the
 * picked file, re-encode it (scaled, metadata dropped), and PUT it to the
 * signed upload URL that `createMediaUpload` minted under the admin's
 * session. Browser-only: uses `createImageBitmap` and a canvas.
 */

/** Why a picked file is refused before anything is uploaded. */
export type MediaFileError = "too-large" | "unsupported-type";

/**
 * The picked file checked against the bucket's rules: one of
 * {@link MEDIA_MIME_TYPES} (an empty file is no image either) and at most
 * {@link MEDIA_MAX_BYTES}. The bucket and `createMediaUpload` check both again.
 */
export function checkMediaFile(file: File): { ok: true; type: MediaMimeType } | { ok: false; error: MediaFileError } {
  const type = MEDIA_MIME_TYPES.find((candidate) => candidate === file.type);
  if (!type || file.size === 0) return { ok: false, error: "unsupported-type" };
  if (file.size > MEDIA_MAX_BYTES) return { ok: false, error: "too-large" };
  return { ok: true, type };
}

/** Per type: whether this browser decodes images to a canvas and encodes the canvas as that type. */
const canvasEncodes = new Map<MediaMimeType, boolean>();

function encodes(type: MediaMimeType): boolean {
  let known = canvasEncodes.get(type);
  if (known === undefined) {
    // `toDataURL` falls back to PNG for a type it cannot encode.
    known =
      typeof createImageBitmap === "function" &&
      document.createElement("canvas").toDataURL(type).startsWith(`data:${type}`);
    canvasEncodes.set(type, known);
  }
  return known;
}

/**
 * The type an image of `type` is uploaded as, one this browser's canvas
 * encodes (every upload is re-encoded, see {@link prepareImage}): WebP where
 * it can, else the file's own type, else PNG (every canvas encodes PNG, and
 * it keeps transparency). The object name's extension follows it, so it is
 * fixed before the upload URL is requested.
 */
export function uploadTypeFor(type: MediaMimeType): MediaMimeType {
  if (encodes("image/webp")) return "image/webp";
  return encodes(type) ? type : "image/png";
}

/** An image ready to upload, with the pixel size `admin_attach_media` records. */
export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Decodes `file` (EXIF orientation applied) and re-encodes it as `type`
 * (from {@link uploadTypeFor}), scaled down to at most
 * {@link MEDIA_MAX_DIMENSION} on its longest side. It is re-encoded at full
 * size too: a canvas encodes pixels only, so the original's EXIF (camera,
 * GPS position) and other metadata never reach the public bucket. A file
 * that does not decode is `unsupported-type`; an encoder that does not
 * produce `type` is `failed` (the original is never uploaded as it is).
 */
export async function prepareImage(
  file: File,
  type: MediaMimeType,
): Promise<{ ok: true; image: PreparedImage } | { ok: false; error: "unsupported-type" | "failed" }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, error: "unsupported-type" };
  }

  try {
    const scale = Math.min(1, MEDIA_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const encoded = Promise.withResolvers<Blob | null>();
    if (context) {
      context.drawImage(bitmap, 0, 0, width, height);
      canvas.toBlob(encoded.resolve, type, MEDIA_WEBP_QUALITY);
    } else {
      encoded.resolve(null);
    }
    const blob = await encoded.promise;
    return blob?.type === type ? { ok: true, image: { blob, width, height } } : { ok: false, error: "failed" };
  } finally {
    bitmap.close();
  }
}

/**
 * PUTs `blob` to the signed upload URL of `path` (Storage API
 * `upload/sign`, no session needed: the token is the authorisation). The
 * CSP's `connect-src` allows exactly that endpoint of the media bucket.
 *
 * @returns whether the object was stored.
 */
export async function putSignedUpload(path: string, token: string, blob: Blob, type: MediaMimeType): Promise<boolean> {
  const { error } = await getPublicClient()
    .storage.from(MEDIA_BUCKET)
    .uploadToSignedUrl(path, token, blob, { contentType: type, upsert: false });
  return !error;
}
