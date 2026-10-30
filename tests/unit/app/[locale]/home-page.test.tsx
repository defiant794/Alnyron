// @vitest-environment jsdom
// Home page route (src/app/[locale]/page.tsx). Since F0.5 (home-page) it renders
// DB content: the content services are mocked here, so these tests check the
// wiring (route locale in, resolved content out to HomeView) and the static/ISR
// contract. Service logic: tests/unit/services/content/*; HomeView rendering:
// tests/unit/components/site/HomeView.test.tsx; real DB: tests/e2e/home-page.spec.ts.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Real messages/*.json behind getTranslations; setRequestLocale is a no-op.
vi.mock('next-intl/server', async () =>
  (await import('../../../helpers/next-intl-server')).nextIntlServerMock(),
);
vi.mock('@/services/content/pages', () => ({ getHomePage: vi.fn() }));
vi.mock('@/services/content/categories', () => ({ getPublicCategories: vi.fn() }));
vi.mock('@/services/content/settings', () => ({ getSiteSettings: vi.fn() }));

import { setRequestLocale } from 'next-intl/server';
import Page, { revalidate } from '@/app/[locale]/page';
import { getPublicCategories, type PublicCategory } from '@/services/content/categories';
import { getHomePage, type HomePageTranslation } from '@/services/content/pages';
import { getSiteSettings } from '@/services/content/settings';

const DA_TITLE = 'Moderne apps, hjemmesider og digitale ydelser.';

const daHome: HomePageTranslation = {
  title: DA_TITLE,
  lead: 'Alnyron bygger gennemtænkte digitale produkter.',
  content: {
    whatWeDo: {
      eyebrow: 'Hvad vi laver',
      title: 'Én samarbejdspartner, flere muligheder',
      intro: 'Vi arbejder blandt andet med:',
      note: 'Offentlige områder vises automatisk, når de har indhold.',
    },
    ctaBand: {
      title: 'Klar til at tale om dit projekt?',
      text: 'Skriv til {email}, så vender vi hurtigt tilbage.',
    },
  },
};

const apps: PublicCategory = {
  id: 'cat-apps-uuid',
  kind: 'apps',
  navOrder: 10,
  title: 'Apps',
  description: 'Mobil- og webapps med fokus på brugeroplevelse.',
  href: '/apps',
  fallbackKeys: [],
};

// The page is an async server component: params is a Promise (Next.js 15).
async function renderHome(locale: string) {
  render(await Page({ params: Promise.resolve({ locale }) }));
}

beforeEach(() => {
  vi.mocked(getHomePage).mockImplementation(async (locale) => ({
    value: daHome,
    // EN rows are blank in the seed: every field falls back to Danish.
    fallbackKeys: locale === 'da' ? [] : ['title', 'lead'],
  }));
  vi.mocked(getPublicCategories).mockResolvedValue([apps]);
  vi.mocked(getSiteSettings).mockResolvedValue({
    companyName: 'Alnyron',
    contactEmail: 'info@alnyron.dk',
  });
});

afterEach(cleanup);

describe('AC-HOME-01: home page renders the DB home content', () => {
  it('renders the DA title from getHomePage as the level-1 heading', async () => {
    await renderHome('da');
    expect(screen.getByRole('heading', { level: 1, name: DA_TITLE })).toBeInTheDocument();
  });

  it('fetches the home page and the public categories for the route locale', async () => {
    await renderHome('en');
    expect(getHomePage).toHaveBeenCalledWith('en');
    expect(getPublicCategories).toHaveBeenCalledWith('en');
  });

  it('passes the public categories on ("Hvad vi laver" with the Apps card)', async () => {
    await renderHome('da');
    expect(screen.getByText('Hvad vi laver')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apps' })).toHaveAttribute('href', '/apps');
  });

  it('links {email} in the contact band to site_settings.contact_email', async () => {
    await renderHome('da');
    expect(screen.getByRole('link', { name: 'info@alnyron.dk' })).toHaveAttribute(
      'href',
      'mailto:info@alnyron.dk',
    );
  });
});

describe('AC-HOME-02/03: EN home passes the DA fallback keys on', () => {
  it('marks the DA-fallback title with lang="da" on /en', async () => {
    await renderHome('en');
    expect(screen.getByRole('heading', { level: 1, name: DA_TITLE })).toHaveAttribute('lang', 'da');
  });

  it('AC-I18N-04: EN home shows English UI copy around the DB content', async () => {
    await renderHome('en');
    expect(screen.getByRole('link', { name: 'Get in touch' })).toHaveAttribute('href', '/en/contact');
  });

  it('AC-I18N-01: DA home shows Danish UI copy', async () => {
    await renderHome('da');
    expect(screen.getByRole('link', { name: 'Kom i kontakt' })).toHaveAttribute('href', '/kontakt');
  });
});

// Static rendering contract: without setRequestLocale the page still renders
// but Next renders it dynamically. Vitest 5 clears mock calls before each test.
describe('AC-HOME-12: home page is static with an hourly ISR fallback', () => {
  it('exports revalidate = 3600', () => {
    expect(revalidate).toBe(3600);
  });

  it('AC-I18N-01: DA home calls setRequestLocale("da")', async () => {
    await renderHome('da');
    expect(setRequestLocale).toHaveBeenCalledWith('da');
  });

  it('AC-I18N-04: EN home calls setRequestLocale("en")', async () => {
    await renderHome('en');
    expect(setRequestLocale).toHaveBeenCalledWith('en');
  });
});
