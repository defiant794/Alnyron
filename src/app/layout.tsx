import type { Metadata } from "next";
import { Inter } from "next/font/google";
import SkipLink from "@/components/ui/SkipLink";
import "@/styles/globals.css";

// Self-hosted at build time by next/font (no runtime request to Google).
// The CSS variable feeds --font-sans in src/styles/globals.css.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Alnyron",
  description: "Moderne apps, hjemmesider og digitale ydelser.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="da" className={inter.variable}>
      <body>
        <SkipLink />
        {children}
      </body>
    </html>
  );
}
