// @vitest-environment jsdom
// Unit tests for F0.5 home-page — HomeView conditional rendering
// Acceptance IDs: AC-HOME-10, AC-HOME-10b, AC-HOME-11, AC-HOME-11b, AC-HOME-03
//
// HomeView is a pure JSX component (no async, no DB calls) that receives
// resolved content and publicCategories as props. This makes it fully unit-
// testable without any DB or ISR state.
//
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import HomeView from "@/components/site/HomeView";
import type { HomeViewProps } from "@/components/site/HomeView";
import type { PublicCategory } from "@/services/content/categories";

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const daContent: HomeViewProps["content"] = {
  whatWeDo: {
    eyebrow: "Hvad vi laver",
    title: "Én samarbejdspartner, flere muligheder",
    intro: "Vi arbejder blandt andet med:",
    note: "Offentlige områder vises automatisk, når de har indhold.",
  },
  ctaBand: {
    title: "Klar til at tale om dit projekt?",
    text: "Skriv til {email}, så vender vi hurtigt tilbage.",
  },
};

const appsCategory: PublicCategory = {
  id: "cat-apps-uuid",
  kind: "apps",
  navOrder: 10,
  title: "Apps",
  description: "Mobil- og webapps med fokus på brugeroplevelse.",
  href: "/apps",
  fallbackKeys: [],
};

const servicesCategory: PublicCategory = {
  id: "cat-services-uuid",
  kind: "services",
  navOrder: 30,
  title: "Ydelser",
  description: "Udvikling, AI og automatisering.",
  href: "/ydelser",
  fallbackKeys: [],
};

/** Renders HomeView with sane defaults; override via partial props. */
function renderHome(overrides: Partial<HomeViewProps> = {}) {
  const props: HomeViewProps = {
    locale: "da",
    title: "Moderne apps, hjemmesider og digitale ydelser.",
    lead: "Alnyron bygger gennemtænkte digitale produkter.",
    content: daContent,
    fallbackKeys: [],
    publicCategories: [appsCategory],
    contactEmail: "info@alnyron.dk",
    ...overrides,
  };
  return render(<HomeView {...props} />);
}

// ── AC-HOME-01: hero section always renders ───────────────────────────────────

describe("AC-HOME-01: HomeView — hero title and lead always render", () => {
  it("renders the page title in a heading", () => {
    renderHome();
    expect(
      screen.getByRole("heading", {
        name: /Moderne apps, hjemmesider og digitale ydelser\./i,
      }),
    ).toBeInTheDocument();
  });

  it("renders the lead text", () => {
    renderHome();
    expect(
      screen.getByText(/Alnyron bygger gennemtænkte digitale produkter\./),
    ).toBeInTheDocument();
  });
});

// ── AC-HOME-10: "Hvad vi laver" section visible with categories ───────────────

describe('AC-HOME-10: HomeView — "Hvad vi laver" section visible when publicCategories is non-empty', () => {
  it('renders the "Hvad vi laver" eyebrow text', () => {
    renderHome({ publicCategories: [appsCategory] });
    expect(screen.getByText("Hvad vi laver")).toBeInTheDocument();
  });

  it("renders the whatWeDo section title", () => {
    renderHome({ publicCategories: [appsCategory] });
    expect(
      screen.getByText("Én samarbejdspartner, flere muligheder"),
    ).toBeInTheDocument();
  });

  it("renders a category link for each provided category", () => {
    renderHome({ publicCategories: [appsCategory, servicesCategory] });
    expect(screen.getByRole("link", { name: /Apps/i })).toBeInTheDocument();
    // Exact name: the "Se ydelser" button (also rendered here) matches /Ydelser/i too.
    expect(screen.getByRole("link", { name: "Ydelser" })).toBeInTheDocument();
  });

  it("category link href matches the category's href", () => {
    renderHome({ publicCategories: [appsCategory] });
    const link = screen.getByRole("link", { name: /Apps/i });
    expect(link).toHaveAttribute("href", "/apps");
  });
});

// ── AC-HOME-10b: "Hvad vi laver" section hidden with no categories ────────────

describe('AC-HOME-10b: HomeView — "Hvad vi laver" section hidden when publicCategories is empty', () => {
  it('does not render the "Hvad vi laver" eyebrow when publicCategories=[]', () => {
    renderHome({ publicCategories: [] });
    expect(screen.queryByText("Hvad vi laver")).not.toBeInTheDocument();
  });

  it("does not render the whatWeDo section title when publicCategories=[]", () => {
    renderHome({ publicCategories: [] });
    expect(
      screen.queryByText("Én samarbejdspartner, flere muligheder"),
    ).not.toBeInTheDocument();
  });

  it("hero title still renders when publicCategories=[]", () => {
    renderHome({ publicCategories: [] });
    expect(
      screen.getByRole("heading", {
        name: /Moderne apps, hjemmesider og digitale ydelser\./i,
      }),
    ).toBeInTheDocument();
  });
});

// ── AC-HOME-11: "Se ydelser" button absent without services category ──────────

describe('AC-HOME-11: HomeView — "Se ydelser" absent when services category not in list', () => {
  it('does not render a "Se ydelser" link when no services category', () => {
    // Only apps category — no services
    renderHome({ publicCategories: [appsCategory] });
    expect(
      screen.queryByRole("link", { name: /Se ydelser/i }),
    ).not.toBeInTheDocument();
  });

  it('does not render "Se ydelser" when publicCategories is empty', () => {
    renderHome({ publicCategories: [] });
    expect(
      screen.queryByRole("link", { name: /Se ydelser/i }),
    ).not.toBeInTheDocument();
  });
});

// ── AC-HOME-11b: "Se ydelser" button present with services category ───────────

describe('AC-HOME-11b: HomeView — "Se ydelser" visible when services category is in list', () => {
  it('renders a "Se ydelser" link when services category is present', () => {
    renderHome({ publicCategories: [appsCategory, servicesCategory] });
    expect(
      screen.getByRole("link", { name: /Se ydelser/i }),
    ).toBeInTheDocument();
  });

  it('"Se ydelser" link href points to the services category href', () => {
    renderHome({ publicCategories: [appsCategory, servicesCategory] });
    const btn = screen.getByRole("link", { name: /Se ydelser/i });
    expect(btn).toHaveAttribute("href", "/ydelser");
  });
});

// ── AC-HOME-03: lang="da" on fallback text ────────────────────────────────────

describe('AC-HOME-03: HomeView — lang="da" applied to elements whose key is in fallbackKeys', () => {
  it('wraps the title with lang="da" when "title" is in fallbackKeys', () => {
    renderHome({ fallbackKeys: ["title"] });
    const heading = screen.getByRole("heading", {
      name: /Moderne apps, hjemmesider og digitale ydelser\./i,
    });
    // The heading itself or its wrapper must carry lang="da"
    const langEl = heading.closest("[lang='da']") ?? heading.querySelector("[lang='da']") ?? heading;
    expect(langEl.getAttribute("lang") ?? heading.getAttribute("lang")).toBe("da");
  });

  it('wraps the lead with lang="da" when "lead" is in fallbackKeys', () => {
    renderHome({ fallbackKeys: ["lead"] });
    const lead = screen.getByText(/Alnyron bygger gennemtænkte digitale produkter\./);
    const langEl = lead.closest("[lang='da']") ?? lead;
    expect(langEl.getAttribute("lang")).toBe("da");
  });

  it('does not add lang="da" to title when "title" is NOT in fallbackKeys', () => {
    renderHome({ fallbackKeys: [] });
    const heading = screen.getByRole("heading", {
      name: /Moderne apps, hjemmesider og digitale ydelser\./i,
    });
    // Neither the heading nor any ancestor within the component should carry lang="da"
    // (the html element sets lang="da" for DA locale at the layout level — not tested here)
    expect(heading.getAttribute("lang")).toBeNull();
    // closest("[lang]") would find the html element; check only the component subtree
    const componentRoot = heading.closest("main") ?? heading.parentElement;
    if (componentRoot) {
      expect(componentRoot.getAttribute("lang")).toBeNull();
    }
  });

  // EN page with Danish content: each field is marked on its own element.
  it.each([
    ["content.whatWeDo.eyebrow", () => screen.getByText("Hvad vi laver")],
    [
      "content.whatWeDo.title",
      () => screen.getByRole("heading", { name: "Én samarbejdspartner, flere muligheder" }),
    ],
    ["content.whatWeDo.intro", () => screen.getByText("Vi arbejder blandt andet med:")],
    [
      "content.whatWeDo.note",
      () => screen.getByText("Offentlige områder vises automatisk, når de har indhold."),
    ],
    [
      "content.ctaBand.title",
      () => screen.getByRole("heading", { name: "Klar til at tale om dit projekt?" }),
    ],
    [
      "content.ctaBand.text",
      () => screen.getByRole("link", { name: "info@alnyron.dk" }).closest("p"),
    ],
  ])('%s carries lang="da" only when the key is in fallbackKeys', (key, find) => {
    const { unmount } = renderHome({ locale: "en", fallbackKeys: [key] });
    expect(find()).toHaveAttribute("lang", "da");
    unmount();

    renderHome({ locale: "en", fallbackKeys: [] });
    expect(find()).not.toHaveAttribute("lang");
  });

  it('category card title carries lang="da" when "title" is in the category fallbackKeys', () => {
    renderHome({ locale: "en", publicCategories: [{ ...appsCategory, fallbackKeys: ["title"] }] });
    expect(screen.getByRole("link", { name: "Apps" })).toHaveAttribute("lang", "da");
    expect(screen.getByText(appsCategory.description)).not.toHaveAttribute("lang");
  });

  it('category card description carries lang="da" when "description" is in the category fallbackKeys', () => {
    renderHome({
      locale: "en",
      publicCategories: [{ ...appsCategory, fallbackKeys: ["description"] }],
    });
    expect(screen.getByText(appsCategory.description)).toHaveAttribute("lang", "da");
    expect(screen.getByRole("link", { name: "Apps" })).not.toHaveAttribute("lang");
  });

  it("renders no lang attribute anywhere when nothing falls back", () => {
    const { container } = renderHome({
      locale: "en",
      publicCategories: [appsCategory, servicesCategory],
    });
    expect(container.querySelector("main [lang]")).toBeNull();
  });
});

// ── Blank DB fields are left out ──────────────────────────────────────────────

describe("HomeView — blank DB fields are left out, not rendered as empty elements", () => {
  const blankContent: HomeViewProps["content"] = {
    whatWeDo: { eyebrow: "", title: "   ", intro: "", note: " " },
    ctaBand: { title: "", text: "  " },
  };

  it("renders only the hero title and the card title when every optional field is blank", () => {
    const { container } = renderHome({
      lead: " ",
      content: blankContent,
      publicCategories: [{ ...appsCategory, description: "" }],
    });
    const textElements = [...container.querySelectorAll("main h1, main h2, main h3, main p")];
    expect(textElements.map((el) => el.tagName)).toEqual(["H1", "H3"]);
    for (const el of textElements) expect(el.textContent?.trim()).not.toBe("");
  });

  it("labels each section by its heading when the titles are set", () => {
    renderHome();
    expect(
      screen.getByRole("region", { name: "Én samarbejdspartner, flere muligheder" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Klar til at tale om dit projekt?" })).toBeInTheDocument();
  });

  it("drops aria-labelledby when a section title is blank (never points at a missing heading)", () => {
    const { container } = renderHome({ content: blankContent });
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    expect(container.querySelector("main section[aria-labelledby]")).toBeNull();
  });
});
