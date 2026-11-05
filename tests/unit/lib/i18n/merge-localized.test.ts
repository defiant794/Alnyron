// Tests for AC-I18N-10 through AC-I18N-14
import { describe, it, expect } from "vitest";
import { mergeLocalized } from "@/lib/i18n/merge-localized";

describe("mergeLocalized — AC-I18N-11: EN non-blank leaf wins over DA", () => {
  it("uses the EN value when EN key is a non-blank string", () => {
    const da = { greeting: "Hej verden" };
    const en = { greeting: "Hello world" };
    const result = mergeLocalized(da, en);
    expect(result.greeting).toBe("Hello world");
  });
});

describe("mergeLocalized — AC-I18N-12: blank EN leaf falls back to DA", () => {
  it("uses the DA value when EN key is an empty string", () => {
    const da = { cta: "Kontakt os" };
    const en = { cta: "" };
    const result = mergeLocalized(da, en);
    expect(result.cta).toBe("Kontakt os");
  });
});

describe("mergeLocalized — AC-I18N-14: DA-only keys are preserved", () => {
  it("keeps DA value when the key is absent from EN", () => {
    const da = { nav: "Navigation", footer: "Sidefod" };
    const en = { nav: "Navigation" }; // 'footer' missing in EN
    const result = mergeLocalized(da, en);
    expect(result.footer).toBe("Sidefod");
  });

  it("keeps all DA keys even when EN is empty", () => {
    const da = { a: "Alpha", b: "Beta", c: "Gamma" };
    const en = {};
    const result = mergeLocalized(da, en);
    expect(result).toMatchObject({ a: "Alpha", b: "Beta", c: "Gamma" });
  });
});

describe("mergeLocalized — AC-I18N-13: recursive merge on nested objects", () => {
  it("recursively merges nested objects — EN non-blank leaf wins", () => {
    const da = { page: { title: "Forside", subtitle: "Velkommen" } };
    const en = { page: { title: "Home", subtitle: "" } };
    const result = mergeLocalized(da, en) as typeof da;
    // EN 'title' is non-blank → EN wins
    expect(result.page.title).toBe("Home");
    // EN 'subtitle' is blank → DA fallback
    expect(result.page.subtitle).toBe("Velkommen");
  });

  it("keeps DA-only nested keys when EN nested object omits them", () => {
    const da = { nav: { home: "Forside", contact: "Kontakt", about: "Om os" } };
    const en = { nav: { home: "Home", contact: "Contact" } }; // 'about' absent in EN
    const result = mergeLocalized(da, en) as typeof da;
    expect(result.nav.about).toBe("Om os");
  });

  it("handles three-level nesting — EN blank at deepest leaf falls back to DA", () => {
    const da = { forms: { contact: { submit: "Send besked" } } };
    const en = { forms: { contact: { submit: "" } } };
    const result = mergeLocalized(da, en) as typeof da;
    expect(result.forms.contact.submit).toBe("Send besked");
  });
});

describe("mergeLocalized — AC-I18N-10: unknown EN-only root keys are not injected", () => {
  it("does not add EN keys that have no DA counterpart", () => {
    const da = { known: "Kendt" };
    const en = { known: "Known", unknown: "Extra EN key" };
    const result = mergeLocalized(da, en);
    // Result shape follows DA structure; unknown EN-only keys are excluded
    expect("unknown" in result).toBe(false);
  });
});

describe("mergeLocalized — whitespace-only EN value is treated as blank", () => {
  it("falls back to DA when EN value is only whitespace", () => {
    const da = { label: "Indsend" };
    const en = { label: "   " };
    const result = mergeLocalized(da, en);
    expect(result.label).toBe("Indsend");
  });
});
