// @vitest-environment jsdom
/**
 * Unit tests: browser image preparation before upload (F2.3 catalog-admin)
 * Journey: catalog-admin
 * Acceptance IDs: AC-CATADM-42
 *
 * Every picked image is re-encoded through a canvas, also when it needs no
 * scaling, so the original's EXIF (camera, GPS position) never reaches the
 * public media bucket. The upload type is always one the canvas encodes.
 *
 * jsdom has no image decoder or canvas encoder: `createImageBitmap` and the
 * canvas methods are stubbed, and the stub encoder writes bytes of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_MAX_DIMENSION, type MediaMimeType } from "@/config/catalog";

vi.mock("@/lib/supabase/public", () => ({ getPublicClient: vi.fn() }));

/** A JPEG whose APP1 segment holds EXIF with a GPS position. */
const EXIF_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x1c,
  ...new TextEncoder().encode("Exif\0\0GPSLatitude 55.6761"),
  0xff, 0xd9,
]);

/** What the stub canvas encoder writes: pixels only, no metadata segment. */
const ENCODED_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]);

const drawImage = vi.fn();
const close = vi.fn();

/**
 * Stubs the decoder (a bitmap of `width` x `height`) and the canvas. The
 * encoder answers with `encodedType` when given, else the requested type;
 * `toDataURL` reports `encodable` types as encodable and falls back to PNG.
 */
function stubCanvas({
  width,
  height,
  encodedType,
  encodable = ["image/png", "image/jpeg", "image/webp"],
}: {
  width: number;
  height: number;
  encodedType?: string;
  encodable?: readonly string[];
}) {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ drawImage }) as never);
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback, type) => callback(new Blob([ENCODED_BYTES], { type: encodedType ?? type })));
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation((type = "image/png") =>
    encodable.includes(type) ? `data:${type};base64,` : "data:image/png;base64,",
  );
  return { toBlob };
}

/** A fresh module: `uploadTypeFor` remembers what the canvas encodes. */
async function loadMediaUpload() {
  vi.resetModules();
  return import("@/lib/media-upload");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AC-CATADM-42: prepareImage re-encodes every image, metadata dropped", () => {
  it("AC-CATADM-42a: a JPEG that needs no scaling is re-encoded, not uploaded as the original with its EXIF/GPS", async () => {
    const { toBlob } = stubCanvas({ width: 800, height: 600 });
    const { prepareImage } = await loadMediaUpload();
    const file = new File([EXIF_JPEG_BYTES], "photo.jpg", { type: "image/jpeg" });

    const result = await prepareImage(file, "image/jpeg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.blob).not.toBe(file);
    expect(result.image).toMatchObject({ width: 800, height: 600 });
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ width: 800 }), 0, 0, 800, 600);
    expect(toBlob).toHaveBeenCalledExactlyOnceWith(expect.any(Function), "image/jpeg", expect.any(Number));
    const uploaded = await result.image.blob.text();
    expect(uploaded).not.toContain("Exif");
    expect(uploaded).not.toContain("GPS");
    expect(new Uint8Array(await result.image.blob.arrayBuffer())).toEqual(ENCODED_BYTES);
    expect(close).toHaveBeenCalledOnce();
  });

  it("AC-CATADM-42b: a same-type WebP and PNG within the size are re-encoded too", async () => {
    for (const type of ["image/webp", "image/png"] as const satisfies readonly MediaMimeType[]) {
      stubCanvas({ width: 1200, height: 900 });
      const { prepareImage } = await loadMediaUpload();
      const file = new File([EXIF_JPEG_BYTES], "image", { type });

      const result = await prepareImage(file, type);

      expect(result.ok && result.image.blob !== file && result.image.blob.type === type).toBe(true);
    }
  });

  it("AC-CATADM-42c: the longest side is scaled down to MEDIA_MAX_DIMENSION", async () => {
    stubCanvas({ width: MEDIA_MAX_DIMENSION * 2, height: MEDIA_MAX_DIMENSION });
    const { prepareImage } = await loadMediaUpload();

    const result = await prepareImage(new File([EXIF_JPEG_BYTES], "big.jpg", { type: "image/jpeg" }), "image/webp");

    expect(result).toMatchObject({ ok: true, image: { width: MEDIA_MAX_DIMENSION, height: MEDIA_MAX_DIMENSION / 2 } });
  });

  it("AC-CATADM-42d: an encoder that cannot produce the type fails instead of uploading the original", async () => {
    stubCanvas({ width: 800, height: 600, encodedType: "image/png" });
    const { prepareImage } = await loadMediaUpload();
    const file = new File([EXIF_JPEG_BYTES], "photo.avif", { type: "image/avif" });

    expect(await prepareImage(file, "image/avif")).toEqual({ ok: false, error: "failed" });
  });

  it("AC-CATADM-42e: a file that does not decode is unsupported-type", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new DOMException("undecodable", "InvalidStateError");
      }),
    );
    const { prepareImage } = await loadMediaUpload();

    expect(await prepareImage(new File(["x"], "x.jpg", { type: "image/jpeg" }), "image/jpeg")).toEqual({
      ok: false,
      error: "unsupported-type",
    });
  });
});

describe("AC-CATADM-42: uploadTypeFor picks a type the canvas encodes", () => {
  it("AC-CATADM-42f: WebP wherever the canvas encodes WebP", async () => {
    stubCanvas({ width: 1, height: 1 });
    const { uploadTypeFor } = await loadMediaUpload();

    expect(uploadTypeFor("image/jpeg")).toBe("image/webp");
    expect(uploadTypeFor("image/avif")).toBe("image/webp");
  });

  it("AC-CATADM-42g: without WebP encoding, the file's own type when encodable, else PNG", async () => {
    stubCanvas({ width: 1, height: 1, encodable: ["image/png", "image/jpeg"] });
    const { uploadTypeFor } = await loadMediaUpload();

    expect(uploadTypeFor("image/jpeg")).toBe("image/jpeg");
    expect(uploadTypeFor("image/png")).toBe("image/png");
    expect(uploadTypeFor("image/webp")).toBe("image/png");
    expect(uploadTypeFor("image/avif")).toBe("image/png");
  });
});
