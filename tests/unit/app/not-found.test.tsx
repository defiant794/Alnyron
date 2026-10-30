// @vitest-environment jsdom
// Root 404 (src/app/not-found.tsx): renders unmatched paths under the
// passthrough root layout, so it owns the document like [locale]/layout does.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/font/google', () => ({
  Inter: vi.fn(() => ({ variable: '--font-inter', className: 'font-inter' })),
}));

vi.mock('next-intl/server', async () =>
  (await import('../../helpers/next-intl-server')).nextIntlServerMock(),
);

import RootNotFound from '@/app/not-found';

let doc: Document;

beforeAll(async () => {
  const markup = renderToStaticMarkup(await RootNotFound());
  doc = new DOMParser().parseFromString(markup, 'text/html');
});

describe('Root not-found document', () => {
  it('<html lang="da"> (default locale)', () => {
    expect(doc.documentElement.getAttribute('lang')).toBe('da');
  });

  it('applies the Inter variable class to <html>', () => {
    expect(doc.documentElement.className).toContain('--font-inter');
  });

  it('SkipLink "Spring til indhold" comes before #main', () => {
    const skipLink = doc.querySelector('a[href="#main"]');
    const main = doc.getElementById('main');
    expect(skipLink?.textContent?.trim()).toBe('Spring til indhold');
    expect(main).not.toBeNull();
    expect(skipLink!.compareDocumentPosition(main!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the Danish 404 heading and a link to the home page', () => {
    expect(doc.querySelector('h1')?.textContent).toBe('Siden findes ikke');
    const home = Array.from(doc.querySelectorAll('a')).find(
      (a) => a.textContent === 'Gå til forsiden',
    );
    expect(home?.getAttribute('href')).toBe('/');
  });
});
