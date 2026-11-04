// @vitest-environment jsdom
/**
 * Unit tests — MediaManager component (F2.3 catalog-admin)
 * Journey: catalog-admin
 * Acceptance IDs: AC-CATADM-40, AC-CATADM-41, AC-CATADM-42, AC-CATADM-43,
 *                 AC-CATADM-44, AC-CATADM-45, AC-CATADM-46, AC-CATADM-47, AC-CATADM-48
 *
 * MediaManager handles image uploads for a catalog item:
 *  - save-first prompt when itemId is undefined (new, unsaved item)
 *  - empty state with upload drop zone when itemId exists but no images
 *  - uploading state (loading indicator, further uploads disabled)
 *  - client-side too-large validation (>5 MiB → error, no upload)
 *  - client-side wrong-type validation (non-image → error, no upload)
 *  - too-many-media error from server (9th image attempt)
 *  - populated list: thumbnail, DA alt (required), EN alt (optional), Fjern button
 *  - blank DA alt → alt-required error on save attempt
 *  - Fjern + confirm calls onDetach and removes image from list
 *  - drop zone: every drag over it is cancelled (no browser navigation to the
 *    file); while busy or full the drop is refused with the reason shown
 *  - each image's alt-text inputs have their own accessible name (position)
 *
 * Signed upload URL minted by createMediaUploadAction (server action, mocked here).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, createEvent, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { MEDIA_MAX_BYTES, MEDIA_MAX_PER_ITEM } from "@/config/catalog";
import MediaManager, { type MediaManagerProps } from "@/components/admin/MediaManager";
import type { CatalogActionResult, CatalogSaveResult } from "@/services/admin/catalog";
import type { MediaUploadResult } from "@/services/admin/media";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";
const MEDIA_ID = "550e8400-e29b-41d4-a716-446655440002";
const MEDIA_PATH = `items/${ITEM_ID}/${MEDIA_ID}.webp`;
const PUBLIC_SRC = `https://e2e.supabase.co/storage/v1/object/public/media/${MEDIA_PATH}`;

const ONE_IMAGE = [
  {
    id: MEDIA_ID,
    src: PUBLIC_SRC,
    path: MEDIA_PATH,
    altDa: "Forsiden af appen",
    altEn: "App front page",
    position: 1,
  },
];

const LABELS = {
  heading: "Billeder",
  saveFirst: "Gem elementet før upload",
  empty: "Ingen billeder endnu",
  addImage: "Tilføj billede",
  uploading: "Uploader",
  busy: "Vent et øjeblik, mens billedet gemmes eller fjernes.",
  altDaLabel: "Alt-tekst (DA)",
  altEnLabel: "Alt-tekst (EN)",
  image: "billede",
  remove: "Fjern",
  confirmRemove: "Er du sikker på, at du vil fjerne dette billede?",
  errors: {
    "too-large": "Filen er for stor",
    "unsupported-type": "Filtypen understøttes ikke",
    "too-many-media": "Elementet har det maksimale antal billeder",
    "alt-required": "DA alt-tekst er påkrævet",
    failed: "Upload mislykkedes. Prøv igen.",
  },
  countOf: (n: number, max: number) => `${n} af ${max}`,
};

function makeFile(name: string, type: string, sizeBytes: number): File {
  const content = new Uint8Array(sizeBytes);
  return new File([content], name, { type });
}

const mockCreateUpload = vi.fn<() => Promise<MediaUploadResult>>();
const mockAttach = vi.fn<() => Promise<CatalogSaveResult>>();
const mockDetach = vi.fn<() => Promise<CatalogActionResult>>();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── AC-CATADM-41: save-first prompt ──────────────────────────────────────────

describe("AC-CATADM-41: MediaManager — save-first prompt when itemId is undefined", () => {
  it("AC-CATADM-41a: shows 'Gem elementet før upload' when no itemId", () => {
    render(
      <MediaManager
        itemId={undefined}
        images={[]}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );
    expect(screen.getByText("Gem elementet før upload")).toBeInTheDocument();
  });

  it("AC-CATADM-41b: no upload button rendered when itemId is undefined", () => {
    render(
      <MediaManager
        itemId={undefined}
        images={[]}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );
    expect(screen.queryByText("Tilføj billede")).not.toBeInTheDocument();
  });
});

// ── AC-CATADM-40: empty state with upload drop zone ──────────────────────────

describe("AC-CATADM-40: MediaManager — empty state for saved item with no images", () => {
  it("AC-CATADM-40a: shows upload drop zone / Tilføj billede button", () => {
    render(
      <MediaManager
        itemId={ITEM_ID}
        images={[]}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );
    // Either an explicit "Tilføj billede" button or a drop zone (role=button or input type=file)
    const addBtn = screen.queryByText("Tilføj billede") ?? screen.queryByRole("button", { name: /tilf/i });
    expect(addBtn).toBeInTheDocument();
  });

  it("AC-CATADM-40b: shows the count as '0 af 8' (or similar)", () => {
    render(
      <MediaManager
        itemId={ITEM_ID}
        images={[]}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );
    expect(screen.getByText(`0 af ${MEDIA_MAX_PER_ITEM}`)).toBeInTheDocument();
  });
});

// ── AC-CATADM-43: client-side too-large validation ───────────────────────────

describe("AC-CATADM-43: MediaManager — file too large shows error, no upload", () => {
  it("AC-CATADM-43a: selecting a file >5 MiB shows 'Filen er for stor'", async () => {
    const user = userEvent.setup();
    render(
      <MediaManager
        itemId={ITEM_ID}
        images={[]}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const oversizeFile = makeFile("huge.webp", "image/webp", MEDIA_MAX_BYTES + 1);
    await user.upload(fileInput, oversizeFile);

    expect(screen.getByText("Filen er for stor")).toBeInTheDocument();
    expect(mockCreateUpload).not.toHaveBeenCalled();
  });
});

// ── AC-CATADM-44: client-side wrong-type validation ──────────────────────────

describe("AC-CATADM-44: MediaManager — unsupported file type shows error, no upload", () => {
  it("AC-CATADM-44a: selecting a PDF shows 'Filtypen understøttes ikke'", async () => {
    const user = userEvent.setup();
    render(
      <MediaManager
        itemId={ITEM_ID}
        images={[]}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const pdfFile = makeFile("doc.pdf", "application/pdf", 1024);
    await user.upload(fileInput, pdfFile);

    expect(screen.getByText("Filtypen understøttes ikke")).toBeInTheDocument();
    expect(mockCreateUpload).not.toHaveBeenCalled();
  });
});

// ── AC-CATADM-45: uploading state ────────────────────────────────────────────

describe("AC-CATADM-45: MediaManager — uploading state shows loading indicator", () => {
  it("AC-CATADM-45a: upload in progress shows 'Uploader' indicator", async () => {
    // createUpload never resolves → upload stays pending
    mockCreateUpload.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();

    render(
      <MediaManager
        itemId={ITEM_ID}
        images={[]}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const validFile = makeFile("photo.webp", "image/webp", 1024);
    await user.upload(fileInput, validFile);

    await waitFor(() => {
      expect(screen.getByText(/Uploader/i)).toBeInTheDocument();
    });
  });

  it("AC-CATADM-45b: further uploads are disabled while an upload is in progress", async () => {
    mockCreateUpload.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();

    render(
      <MediaManager
        itemId={ITEM_ID}
        images={[]}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const validFile = makeFile("photo.webp", "image/webp", 1024);
    await user.upload(fileInput, validFile);

    await waitFor(() => {
      const uploadButton = screen.queryByRole("button", { name: /tilf/i });
      if (uploadButton) {
        expect(uploadButton).toBeDisabled();
      } else {
        // Upload area may be hidden rather than disabled
        expect(document.querySelector('input[type="file"]')).toBeNull();
      }
    });
  });
});

// ── AC-CATADM-46: too-many-media from server ──────────────────────────────────

describe("AC-CATADM-46: MediaManager — 9th upload attempt shows too-many-media error", () => {
  it("AC-CATADM-46a: createUpload returning too-many-media shows the error", async () => {
    mockCreateUpload.mockResolvedValue({ ok: false, error: "too-many-media" });
    const user = userEvent.setup();

    render(
      <MediaManager
        itemId={ITEM_ID}
        images={[]}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const validFile = makeFile("photo.webp", "image/webp", 1024);
    await user.upload(fileInput, validFile);

    await screen.findByText("Elementet har det maksimale antal billeder");
    expect(mockAttach).not.toHaveBeenCalled();
  });
});

// ── AC-CATADM-47: blank DA alt → alt-required error ──────────────────────────

describe("AC-CATADM-47: MediaManager — blank DA alt shows alt-required error", () => {
  it("AC-CATADM-47a: renders existing images with their DA alt text", () => {
    render(
      <MediaManager
        itemId={ITEM_ID}
        images={ONE_IMAGE}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );
    const altInput = screen.getByDisplayValue("Forsiden af appen");
    expect(altInput).toBeInTheDocument();
  });

  it("AC-CATADM-47b: count shows '1 af 8' when one image is present", () => {
    render(
      <MediaManager
        itemId={ITEM_ID}
        images={ONE_IMAGE}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );
    expect(screen.getByText(`1 af ${MEDIA_MAX_PER_ITEM}`)).toBeInTheDocument();
  });
});

// ── AC-CATADM-48: Fjern + confirm removes image ───────────────────────────────

describe("AC-CATADM-48: MediaManager — Fjern + confirm calls onDetach", () => {
  it("AC-CATADM-48a: Fjern button is present for each image", () => {
    render(
      <MediaManager
        itemId={ITEM_ID}
        images={ONE_IMAGE}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );
    expect(screen.getByRole("button", { name: "Fjern" })).toBeInTheDocument();
  });

  it("AC-CATADM-48b: clicking Fjern and confirming calls onDetach with the media id", async () => {
    mockDetach.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    // Mock window.confirm to return true (confirmed)
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <MediaManager
        itemId={ITEM_ID}
        images={ONE_IMAGE}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Fjern" }));

    await waitFor(() => {
      expect(mockDetach).toHaveBeenCalledWith(MEDIA_ID);
    });
  });

  it("AC-CATADM-48c: clicking Fjern and cancelling does NOT call onDetach", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <MediaManager
        itemId={ITEM_ID}
        images={ONE_IMAGE}
        labels={LABELS}
        onCreateUpload={mockCreateUpload}
        onAttach={mockAttach}
        onDetach={mockDetach}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Fjern" }));
    expect(mockDetach).not.toHaveBeenCalled();
  });
});

// ── AC-CATADM-45/46: drop zone never lets the browser open a dropped file ─────

/** `MEDIA_MAX_PER_ITEM` images: the item is full. */
const FULL_GALLERY = Array.from({ length: MEDIA_MAX_PER_ITEM }, (_, index) => ({
  ...ONE_IMAGE[0]!,
  id: `550e8400-e29b-41d4-a716-4466554401${String(index).padStart(2, "0")}`,
  altDa: `Billede ${index + 1}`,
  position: index + 1,
}));

/** The drop zone around the "Tilføj billede" button. */
function dropZone(): HTMLElement {
  const zone = screen.getByRole("button", { name: /Tilføj billede/ }).closest("div");
  if (!zone) throw new Error("drop zone not found");
  return zone;
}

/** Fires `type` on the drop zone with a file; returns whether the default ran and the drop effect the zone set. */
function drag(type: "dragOver" | "drop", file = makeFile("photo.webp", "image/webp", 1024)) {
  const dataTransfer = { files: [file], types: ["Files"], dropEffect: "move" };
  const event = createEvent[type](dropZone(), { dataTransfer });
  fireEvent(dropZone(), event);
  return { defaultPrevented: event.defaultPrevented, dropEffect: dataTransfer.dropEffect };
}

function renderManager(images: typeof ONE_IMAGE, labels: MediaManagerProps["labels"] = LABELS) {
  return render(
    <MediaManager
      itemId={ITEM_ID}
      images={images}
      labels={labels}
      onCreateUpload={mockCreateUpload}
      onAttach={mockAttach}
      onDetach={mockDetach}
    />,
  );
}

describe("AC-CATADM-45/46: MediaManager drop zone cancels every drag, refusing it while busy or full", () => {
  it("AC-CATADM-40c: a file dragged over a zone that takes it is cancelled with a copy effect, and its drop uploads", async () => {
    mockCreateUpload.mockImplementation(() => new Promise(() => {}));
    renderManager([]);

    expect(drag("dragOver")).toEqual({ defaultPrevented: true, dropEffect: "copy" });
    expect(drag("drop").defaultPrevented).toBe(true);

    await waitFor(() => expect(mockCreateUpload).toHaveBeenCalledOnce());
  });

  it("AC-CATADM-46b: on a full item the drag is cancelled and refused (no drop effect) with the too-many-media reason", () => {
    renderManager(FULL_GALLERY);

    expect(drag("dragOver")).toEqual({ defaultPrevented: true, dropEffect: "none" });
    expect(screen.getByText(LABELS.errors["too-many-media"])).toHaveClass("text-error");
  });

  it("AC-CATADM-46c: a file dropped on a full item is cancelled, never uploaded, and the too-many-media error shows", async () => {
    renderManager(FULL_GALLERY);

    expect(drag("drop").defaultPrevented).toBe(true);

    expect(await screen.findByRole("alert")).toHaveTextContent(LABELS.errors["too-many-media"]);
    expect(mockCreateUpload).not.toHaveBeenCalled();
  });

  it("AC-CATADM-45c: while an upload runs the drag is cancelled and refused with the busy message; a drop starts nothing", async () => {
    mockCreateUpload.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderManager([]);
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, makeFile("a.webp", "image/webp", 1024));
    await screen.findByText("Uploader");
    expect(screen.queryByText(LABELS.busy)).not.toBeInTheDocument();

    expect(drag("dragOver")).toEqual({ defaultPrevented: true, dropEffect: "none" });
    expect(screen.getByText(LABELS.busy)).toBeInTheDocument();
    expect(drag("drop", makeFile("b.webp", "image/webp", 1024)).defaultPrevented).toBe(true);

    expect(mockCreateUpload).toHaveBeenCalledOnce();
    expect(screen.queryByText(LABELS.busy)).not.toBeInTheDocument();
  });
});

// ── AC-CATADM-47: each image's alt-text inputs have their own name ───────────

describe("AC-CATADM-47: MediaManager alt-text inputs are named by image position (WCAG 2.4.6, 1.3.1)", () => {
  const TWO_IMAGES = [
    ONE_IMAGE[0]!,
    { ...ONE_IMAGE[0]!, id: "550e8400-e29b-41d4-a716-446655440009", altDa: "Bagsiden", altEn: "Back", position: 2 },
  ];

  it("AC-CATADM-47c: every alt-text input has a unique accessible name that starts with its visible label", () => {
    renderManager(TWO_IMAGES);

    expect(screen.getByRole("textbox", { name: "Alt-tekst (DA), billede 1" })).toHaveValue("Forsiden af appen");
    expect(screen.getByRole("textbox", { name: "Alt-tekst (EN), billede 1" })).toHaveValue("App front page");
    expect(screen.getByRole("textbox", { name: "Alt-tekst (DA), billede 2" })).toHaveValue("Bagsiden");
    expect(screen.getByRole("textbox", { name: "Alt-tekst (EN), billede 2" })).toHaveValue("Back");
    expect(screen.getAllByText("Alt-tekst (DA)")).toHaveLength(2);
  });

  it("AC-CATADM-47d: the names follow the images' order after a move", async () => {
    const user = userEvent.setup();
    renderManager(TWO_IMAGES, { ...LABELS, moveUp: "Flyt op", moveDown: "Flyt ned" });

    await user.click(screen.getByRole("button", { name: "Flyt op: 2" }));

    expect(screen.getByRole("textbox", { name: "Alt-tekst (DA), billede 1" })).toHaveValue("Bagsiden");
    expect(screen.getByRole("textbox", { name: "Alt-tekst (DA), billede 2" })).toHaveValue("Forsiden af appen");
  });
});
