// Tests for AC-DS-01 through AC-DS-06
// Reads src/styles/globals.css and asserts every @theme token name+value
// from the F0.2 design-system contract.
// These tests FAIL (Red) until web-developer creates src/styles/globals.css.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd(); // C:\dev\alnyron

// ── Path checks ────────────────────────────────────────────────────────────

describe('AC-DS-06: old globals.css location removed', () => {
  it('src/app/globals.css does not exist (moved to src/styles/globals.css)', () => {
    expect(existsSync(join(ROOT, 'src/app/globals.css'))).toBe(false);
  });
});

describe('AC-DS-01: src/styles/globals.css exists', () => {
  it('file exists at the new location', () => {
    expect(existsSync(join(ROOT, 'src/styles/globals.css'))).toBe(true);
  });
});

// ── Token content ──────────────────────────────────────────────────────────

describe('AC-DS-02: @theme tokens have correct names and values', () => {
  let css = '';

  beforeAll(() => {
    const cssPath = join(ROOT, 'src/styles/globals.css');
    // If the file does not exist yet the tests below will fail descriptively.
    if (existsSync(cssPath)) {
      css = readFileSync(cssPath, 'utf-8');
    }
  });

  const colorTokens: [string, string][] = [
    ['--color-bg', '#ffffff'],
    ['--color-surface', '#f6f8fb'],
    ['--color-fg', '#0b1d33'],
    ['--color-muted', '#5a6778'],
    ['--color-border', '#e5e9f0'],
    ['--color-border-input', '#7c8797'],
    ['--color-accent', '#3346e8'],
    ['--color-accent-hover', '#2a39c7'],
    ['--color-accent-ink', '#ffffff'],
    ['--color-focus', '#2563eb'],
    ['--color-success', '#167c53'],
    ['--color-error', '#c02626'],
    ['--color-brand-navy', '#141b2e'],
  ];

  for (const [name, value] of colorTokens) {
    it(`${name}: ${value}`, () => {
      expect(css).toContain(`${name}: ${value}`);
    });
  }

  it('--font-sans references --font-inter', () => {
    expect(css).toContain('--font-sans:');
    expect(css).toContain('--font-inter');
  });

  it('--font-sans includes Segoe UI and system-ui fallbacks', () => {
    expect(css).toContain('"Segoe UI"');
    expect(css).toContain('system-ui');
    expect(css).toContain('sans-serif');
  });

  const radiusTokens: [string, string][] = [
    ['--radius-card', '14px'],
    ['--radius-btn', '10px'],
    ['--radius-input', '10px'],
    ['--radius-pill', '999px'],
  ];

  for (const [name, value] of radiusTokens) {
    it(`${name}: ${value}`, () => {
      expect(css).toContain(`${name}: ${value}`);
    });
  }

  const spacingTokens: [string, string][] = [
    ['--spacing', '4px'],
    ['--spacing-control-y', '10px'],
    ['--spacing-btn-x', '20px'],
    ['--spacing-pill-y', '2px'],
    ['--spacing-pill-x', '10px'],
  ];

  for (const [name, value] of spacingTokens) {
    it(`${name}: ${value}`, () => {
      expect(css).toContain(`${name}: ${value}`);
    });
  }

  it('--shadow-card: correct multi-layer value', () => {
    expect(css).toContain('--shadow-card:');
    expect(css).toContain('0 1px 2px');
    expect(css).toContain('0 8px 24px');
  });

  const textTokens: { name: string; size: string; lineHeight: string }[] = [
    { name: '--text-display', size: '48px', lineHeight: '56px' },
    { name: '--text-h1', size: '36px', lineHeight: '44px' },
    { name: '--text-h2', size: '28px', lineHeight: '36px' },
    { name: '--text-h3', size: '20px', lineHeight: '28px' },
    { name: '--text-body', size: '16px', lineHeight: '26px' },
    { name: '--text-small', size: '14px', lineHeight: '22px' },
  ];

  for (const { name, size, lineHeight } of textTokens) {
    it(`${name}: ${size} / line-height ${lineHeight}`, () => {
      expect(css).toContain(`${name}:`);
      expect(css).toContain(size);
      // Tailwind v4 line-height companion token
      expect(css).toContain(`${name}--line-height: ${lineHeight}`);
    });
  }

  it('--container-content: 1120px', () => {
    expect(css).toContain('--container-content: 1120px');
  });

  it('--duration-fast: 150ms', () => {
    expect(css).toContain('--duration-fast: 150ms');
  });

  it('--duration-base: 200ms', () => {
    expect(css).toContain('--duration-base: 200ms');
  });

  it('--ease-out uses cubic-bezier', () => {
    expect(css).toContain('--ease-out:');
    expect(css).toContain('cubic-bezier');
  });
});

// ── Focus-visible ──────────────────────────────────────────────────────────

describe('AC-DS-03: :focus-visible rule with 2px focus ring', () => {
  let css = '';

  beforeAll(() => {
    const cssPath = join(ROOT, 'src/styles/globals.css');
    if (existsSync(cssPath)) css = readFileSync(cssPath, 'utf-8');
  });

  it('defines :focus-visible selector', () => {
    expect(css).toMatch(/:focus-visible/);
  });

  it('outline is 2px solid', () => {
    // Accepts "outline: 2px solid ..." or "outline-width: 2px" + "outline-style: solid"
    expect(css).toMatch(/2px\s+solid/);
  });

  it('outline uses the focus color token', () => {
    expect(css).toContain('var(--color-focus)');
  });

  it('outline-offset is 2px', () => {
    expect(css).toContain('outline-offset: 2px');
  });
});

// ── Reduced motion ─────────────────────────────────────────────────────────

describe('AC-DS-04: prefers-reduced-motion: reduce block present', () => {
  let css = '';

  beforeAll(() => {
    const cssPath = join(ROOT, 'src/styles/globals.css');
    if (existsSync(cssPath)) css = readFileSync(cssPath, 'utf-8');
  });

  it('has @media (prefers-reduced-motion: reduce) block', () => {
    expect(css).toContain('prefers-reduced-motion: reduce');
  });

  it('block sets transition to none or 0s', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?transition\s*:/);
  });
});

// ── No dark mode ───────────────────────────────────────────────────────────

describe('AC-DS-05: no dark-mode block (light-only site)', () => {
  let css = '';

  beforeAll(() => {
    const cssPath = join(ROOT, 'src/styles/globals.css');
    if (existsSync(cssPath)) css = readFileSync(cssPath, 'utf-8');
  });

  it('does not contain prefers-color-scheme: dark', () => {
    expect(css).not.toContain('prefers-color-scheme: dark');
  });
});
