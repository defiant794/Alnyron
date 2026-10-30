// Tests for the root layout after F0.3 (i18n-routing).
// The root layout is a passthrough: the document (<html lang>, Inter, SkipLink)
// moved to src/app/[locale]/layout.tsx, where AC-DS-07/08/09/10 are asserted
// (tests/unit/app/[locale]/layout.test.tsx). AC-DS-11 stays here and now also
// covers the files that took over the font setup.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import RootLayout from '@/app/layout';

// ── AC-DS-11: no Geist in source ───────────────────────────────────────────

describe('AC-DS-11: layout and font sources have no Geist reference', () => {
  const sources = ['src/app/layout.tsx', 'src/app/[locale]/layout.tsx', 'src/styles/fonts.ts'];

  for (const file of sources) {
    it(`${file} does not import or reference Geist`, () => {
      const src = readFileSync(join(process.cwd(), file), 'utf-8');
      expect(src).not.toMatch(/Geist/);
    });
  }
});

// ── F0.3: root layout is a passthrough ─────────────────────────────────────

describe('F0.3: root layout renders its children unchanged', () => {
  it('adds no markup around the children', () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main id="main">content</main>
      </RootLayout>,
    );
    expect(markup).toBe('<main id="main">content</main>');
  });
});
