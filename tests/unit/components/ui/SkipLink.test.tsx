// @vitest-environment jsdom
// Tests for AC-DS-10 (standalone SkipLink component)
// These tests FAIL (Red) until web-developer creates src/components/ui/SkipLink.tsx.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SkipLink from '@/components/ui/SkipLink';

afterEach(cleanup);

// ── AC-DS-10: SkipLink href and accessible name ────────────────────────────

describe('AC-DS-10: SkipLink component', () => {
  it('renders a link in the document', () => {
    render(<SkipLink />);
    expect(screen.getByRole('link')).toBeInTheDocument();
  });

  it('has href="#main"', () => {
    render(<SkipLink />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '#main');
  });

  it('accessible name is "Spring til indhold" (Danish, no em-dash)', () => {
    render(<SkipLink />);
    // Verify the label is exactly the Danish phrase per writing-style.md
    expect(screen.getByRole('link', { name: 'Spring til indhold' })).toBeInTheDocument();
  });

  it('label text does not contain an em-dash (writing-style.md hard rule)', () => {
    render(<SkipLink />);
    const link = screen.getByRole('link');
    expect(link.textContent).not.toContain('\u2014');
  });
});
