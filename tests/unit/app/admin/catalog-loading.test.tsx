// @vitest-environment jsdom
/**
 * Unit tests — catalog loading state (src/app/admin/(panel)/catalog/loading.tsx)
 * Journey: catalog-section-fix
 * Acceptance ID: AC-CATSEC-15 (design review catalog-section-fix-design-1, F5)
 *
 * When a navigation's prefetch has already arrived, the catalog boundary's
 * fallback replaces the outgoing page. A live region that mounts with its
 * text already in it may not be announced, so the fallback has no region of
 * its own: the admin shell's always present status region gets the text.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import CatalogLoading from "@/app/admin/(panel)/catalog/loading";
import NavigationPendingContent, { NavigationPendingProvider } from "@/components/admin/NavigationPending";
import { loadMessages } from "@/i18n/messages";

afterEach(cleanup);

const LABEL = loadMessages("da").Admin.loading;

describe("AC-CATSEC-15 (design F5): the catalog loading state is announced by the admin shell's status region", () => {
  it("AC-CATSEC-15u-p: inside the shell, the shell's region carries 'Indlæser siden …' and the fallback is no region and hides its copy", () => {
    render(
      <NavigationPendingProvider>
        <main tabIndex={-1}>
          <NavigationPendingContent label={LABEL}>
            <CatalogLoading />
          </NavigationPendingContent>
        </main>
      </NavigationPendingProvider>,
    );

    const [status, ...others] = screen.getAllByRole("status");
    expect(others).toHaveLength(0);
    expect(status).toHaveTextContent("Indlæser siden …");
    const copies = screen.getAllByText("Indlæser siden …").filter((element) => !status!.contains(element));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toHaveAttribute("aria-hidden", "true");
  });
});
