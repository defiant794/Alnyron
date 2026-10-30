// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Real messages/*.json behind getTranslations; setRequestLocale is a no-op.
vi.mock('next-intl/server', async () =>
  (await import('../../../helpers/next-intl-server')).nextIntlServerMock(),
);

import { setRequestLocale } from 'next-intl/server';
import Page from '@/app/[locale]/page';

// The home page moved to src/app/[locale]/page.tsx in F0.3 (i18n-routing).
// It is an async server component: params is a Promise (Next.js 15).
async function renderHome(locale: string) {
  render(await Page({ params: Promise.resolve({ locale }) }));
}

describe('Home Page (AC-20)', () => {
  afterEach(cleanup);

  it('AC-20: renders a level-1 heading with accessible name "Alnyron"', async () => {
    await renderHome('da');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Alnyron' }),
    ).toBeInTheDocument();
  });

  it('AC-I18N-01: DA home shows Danish copy', async () => {
    await renderHome('da');
    expect(
      screen.getByText('Moderne apps, hjemmesider og digitale ydelser.'),
    ).toBeInTheDocument();
  });

  it('AC-I18N-04: EN home shows English copy', async () => {
    await renderHome('en');
    expect(
      screen.getByText('Modern apps, websites and digital services.'),
    ).toBeInTheDocument();
  });

  // Static rendering contract: without setRequestLocale the page still renders
  // (getTranslations gets the locale explicitly) but Next renders it
  // dynamically. Vitest 5 clears mock calls before each test.
  it('AC-I18N-01: DA home calls setRequestLocale("da")', async () => {
    await renderHome('da');
    expect(setRequestLocale).toHaveBeenCalledWith('da');
  });

  it('AC-I18N-04: EN home calls setRequestLocale("en")', async () => {
    await renderHome('en');
    expect(setRequestLocale).toHaveBeenCalledWith('en');
  });
});
