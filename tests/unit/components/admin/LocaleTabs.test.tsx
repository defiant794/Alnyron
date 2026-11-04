// @vitest-environment jsdom
/**
 * Unit tests: LocaleTabs, the Dansk / Engelsk tabs of the admin editors
 * Journeys: catalog-admin (AC-CATADM-10, AC-CATADM-20), pages-editor (DA/EN tabs)
 *
 * The ARIA tab pattern: one tab stop (roving tabindex), ArrowLeft/ArrowRight
 * (wrapping), Home and End move the selection and the focus, `aria-selected`
 * marks the selected tab, and the editor's panels (wired with localePanelId /
 * localeTabId) show only the selected one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type { Locale } from "next-intl";
import { useState } from "react";

import LocaleTabs, { localePanelId, localeTabId } from "@/components/admin/LocaleTabs";
import { routing } from "@/i18n/routing";

const BASE_ID = "editor";
const NAMES: Record<Locale, string> = { da: "Dansk", en: "Engelsk" };

/** An editor in miniature: the tabs, a panel per locale and a control after them. */
function Editor({ onSelect }: { onSelect?: (locale: Locale) => void }) {
  const [selected, setSelected] = useState<Locale>(routing.defaultLocale);
  return (
    <>
      <LocaleTabs
        baseId={BASE_ID}
        label="Sprog"
        names={NAMES}
        selected={selected}
        onSelect={(locale) => {
          onSelect?.(locale);
          setSelected(locale);
        }}
      />
      {routing.locales.map((locale) => (
        <div
          key={locale}
          role="tabpanel"
          id={localePanelId(BASE_ID, locale)}
          aria-labelledby={localeTabId(BASE_ID, locale)}
          hidden={locale !== selected}
        >
          {`Felter (${locale})`}
        </div>
      ))}
      <button type="button">Gem</button>
    </>
  );
}

afterEach(cleanup);

/** Asserts `name` is the one selected tab, with the one tab stop, and its panel the one shown. */
function expectSelected(name: string) {
  for (const tab of screen.getAllByRole("tab")) {
    const isSelected = tab.textContent === name;
    expect(tab).toHaveAttribute("aria-selected", String(isSelected));
    expect(tab).toHaveAttribute("tabindex", isSelected ? "0" : "-1");
    const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    if (isSelected) expect(panel).toBeVisible();
    else expect(panel).not.toBeVisible();
  }
  expect(screen.getByRole("tabpanel", { name })).toBeVisible();
}

describe("LocaleTabs: ARIA tabs with roving tabindex", () => {
  it("renders a named tab list, Dansk selected, each tab controlling its panel", () => {
    render(<Editor />);

    expect(screen.getByRole("tablist", { name: "Sprog" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Dansk", "Engelsk"]);
    expect(screen.getByRole("tab", { name: "Engelsk" })).toHaveAttribute("aria-controls", localePanelId(BASE_ID, "en"));
    expectSelected("Dansk");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("clicking Engelsk selects it and shows its panel instead of the Danish one", async () => {
    const user = userEvent.setup();
    render(<Editor />);

    await user.click(screen.getByRole("tab", { name: "Engelsk" }));

    expectSelected("Engelsk");
    expect(screen.getByText("Felter (da)")).not.toBeVisible();
  });

  it("is one tab stop: Tab enters at the selected tab and leaves past the others", async () => {
    const user = userEvent.setup();
    render(<Editor />);

    await user.tab();
    expect(screen.getByRole("tab", { name: "Dansk" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Gem" })).toHaveFocus();
  });

  it("ArrowRight and ArrowLeft move the selection and focus, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.tab();

    await user.keyboard("{ArrowRight}");
    expectSelected("Engelsk");
    expect(screen.getByRole("tab", { name: "Engelsk" })).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expectSelected("Dansk");
    expect(screen.getByRole("tab", { name: "Dansk" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expectSelected("Engelsk");
    expect(screen.getByRole("tab", { name: "Engelsk" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expectSelected("Dansk");
    expect(screen.getByRole("tab", { name: "Dansk" })).toHaveFocus();
  });

  it("End selects and focuses the last tab, Home the first", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.tab();

    await user.keyboard("{End}");
    expectSelected("Engelsk");
    expect(screen.getByRole("tab", { name: "Engelsk" })).toHaveFocus();

    await user.keyboard("{Home}");
    expectSelected("Dansk");
    expect(screen.getByRole("tab", { name: "Dansk" })).toHaveFocus();
  });

  it("handled keys cancel their default (no page scroll); other keys change nothing", () => {
    const onSelect = vi.fn();
    render(<Editor onSelect={onSelect} />);
    const dansk = screen.getByRole("tab", { name: "Dansk" });

    expect(fireEvent.keyDown(dansk, { key: "a" })).toBe(true);
    expect(fireEvent.keyDown(dansk, { key: "ArrowDown" })).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    expectSelected("Dansk");

    expect(fireEvent.keyDown(dansk, { key: "End" })).toBe(false);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("en");
  });
});
