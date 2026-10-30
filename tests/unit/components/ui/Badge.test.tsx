// @vitest-environment jsdom
// Tests for AC-DS-21
// These tests FAIL (Red) until web-developer creates src/components/ui/Badge.tsx.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import Badge from '@/components/ui/Badge';

afterEach(cleanup);

// ── AC-DS-21: Badge renders text for every tone ────────────────────────────

describe('AC-DS-21: Badge renders text for all tone values', () => {
  const cases: { tone: 'draft' | 'published' | 'neutral' | 'success' | 'error'; label: string }[] =
    [
      { tone: 'draft', label: 'Kladde' },
      { tone: 'published', label: 'Udgivet' },
      { tone: 'neutral', label: 'Neutral' },
      { tone: 'success', label: 'Gennemfort' },
      { tone: 'error', label: 'Fejl' },
    ];

  for (const { tone, label } of cases) {
    it(`tone="${tone}" renders its label text`, () => {
      render(<Badge tone={tone}>{label}</Badge>);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  }
});
