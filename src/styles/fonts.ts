import { Inter } from "next/font/google";

/**
 * Inter, self-hosted at build time by next/font (no runtime request to
 * Google). Its CSS variable feeds `--font-sans` in `src/styles/globals.css`;
 * both document roots (`app/[locale]/layout.tsx`, `app/not-found.tsx`) put
 * `inter.variable` on `<html>`.
 */
export const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
