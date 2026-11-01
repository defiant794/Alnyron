// @vitest-environment jsdom
/**
 * Unit tests: /mylife/layout.tsx, the MyLife document root.
 * Journey: mylife-login  ML-AC19 (lang=da, robots noindex)
 */
import { describe, it, expect, vi } from "vitest";
import type * as NextIntl from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";

// next/font/google only exists under Next's compiler (the package entry is
// empty), so a document-root layout that puts Inter on <html> (as the admin
// and [locale] layouts do) needs the same stand-in as their tests.
vi.mock("next/font/google", () => ({
  Inter: vi.fn(() => ({ variable: "--font-inter", className: "font-inter" })),
}));

// Real messages/*.json behind getTranslations (no request context here).
// vi.mock is hoisted above the imports, so the shared factory is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);

// The client provider is a passthrough (no request config here).
vi.mock("next-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof NextIntl>()),
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import MyLifeRootLayout, { generateMetadata } from "@/app/mylife/layout";
import { loadMessages } from "@/i18n/messages";

const { Auth, MyLife } = loadMessages("da");

describe("MyLife layout: ML-AC19 lang=da, robots noindex", () => {
  it("ML-AC19a: generateMetadata never lets the area be indexed or its links followed", async () => {
    const meta = await generateMetadata();
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('ML-AC19b: renders <html lang="da"> around the MyLife frame', async () => {
    const markup = renderToStaticMarkup(await MyLifeRootLayout({ children: <p>content</p> }));
    const doc = new DOMParser().parseFromString(markup, "text/html");

    expect(doc.documentElement.getAttribute("lang")).toBe("da");
    expect(doc.querySelector("main#main")?.textContent).toContain("content");
  });
});

describe("MyLife layout: full page titles (design review 2026-11-01)", () => {
  const fullTitle = async (pageTitle: string) => {
    const { title } = await generateMetadata();
    const template = typeof title === "object" && title !== null && "template" in title ? title.template : null;
    if (typeof template !== "string") throw new Error("the MyLife layout must set a title template");
    return template.replace("%s", pageTitle);
  };

  it("ML-AC2g: the landing reads 'Kommer snart | MyLife'", async () => {
    expect(await fullTitle(MyLife.home.metaTitle)).toBe(`${MyLife.home.metaTitle} | ${MyLife.name}`);
  });

  it("ML-AC1aa: the login with error=link_invalid reads 'Fejl: Log ind | MyLife'", async () => {
    const errorTitle = Auth.login.errorTitle.replace("{title}", Auth.login.title);
    expect(await fullTitle(errorTitle)).toBe(`${errorTitle} | ${MyLife.name}`);
    expect(await fullTitle(errorTitle)).toMatch(/^Fejl: /);
  });
});

describe("MyLife frame: the approved login mock's card (design review 2026-11-01)", () => {
  it("ML-AC1ab: a 400px card with 16px radius, 36px block padding from 640px and an 80px mark", async () => {
    const markup = renderToStaticMarkup(await MyLifeRootLayout({ children: <p>content</p> }));
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const main = doc.querySelector("main#main");
    const card = main?.firstElementChild;

    expect(main?.classList.contains("max-w-100")).toBe(true);
    expect(card?.className).toMatch(/\brounded-2xl\b/);
    expect(card?.className).toMatch(/\bsm:py-9\b/);
    expect(card?.querySelector("img")?.parentElement?.className).toMatch(/\[&_img\]:w-20/);
  });
});
