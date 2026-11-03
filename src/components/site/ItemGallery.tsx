"use client";

import Image from "next/image";
import { useState } from "react";
import type { CatalogImage } from "@/services/content/catalog";

export interface ItemGalleryProps {
  /** The item's images in order; may be empty. */
  images: CatalogImage[];
  /** Decorative glyph of the item's kind, shown when it has no image. */
  glyph: string;
  /** Accessible name of the thumbnail list ("Billeder"). */
  label: string;
  /** Accessible name of each thumbnail button, by index ("Vis billede 2 af 3"). */
  thumbnailLabels: string[];
}

/**
 * Item page gallery (approved detail mock). No image: the kind's glyph on a
 * tinted panel (decorative). One image: that image. Several: the selected
 * image large, with a row of thumbnail buttons below that switch it; the
 * selected thumbnail is marked `aria-pressed` and outlined in the accent.
 * Without JavaScript the first image still shows.
 */
export default function ItemGallery({ images, glyph, label, thumbnailLabels }: ItemGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = images[selectedIndex];

  if (!selected) {
    return (
      <div
        aria-hidden="true"
        className="flex aspect-video items-center justify-center rounded-card bg-linear-135 from-accent/10 to-surface text-display text-accent/30"
      >
        {glyph}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Image
        src={selected.src}
        alt={selected.alt}
        lang={selected.lang}
        width={selected.width}
        height={selected.height}
        priority
        sizes="(min-width: 768px) 536px, 100vw"
        className="aspect-video h-auto w-full rounded-card border border-border bg-surface object-cover"
      />
      {images.length > 1 && (
        <ul aria-label={label} className="flex flex-wrap gap-3">
          {images.map((image, index) => (
            <li key={image.id}>
              <button
                type="button"
                aria-label={thumbnailLabels[index]}
                aria-pressed={index === selectedIndex}
                onClick={() => setSelectedIndex(index)}
                className="block h-16 w-20 cursor-pointer overflow-hidden rounded-btn border border-border bg-surface transition-[border-color,translate] hover:border-muted active:translate-y-px aria-pressed:border-accent aria-pressed:ring-1 aria-pressed:ring-accent"
              >
                <Image
                  src={image.src}
                  alt=""
                  width={image.width}
                  height={image.height}
                  sizes="80px"
                  className="size-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
