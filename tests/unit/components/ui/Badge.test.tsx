// @vitest-environment jsdom
// Tests for AC-DS-21 (every tone), the MyLife login's accent badge (ML-AC1) and
// the Monitor-brugere "Afventer bekræftelse" info badge (AMC-19).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import Badge, { type BadgeTone } from '@/components/ui/Badge';

afterEach(cleanup);

// ── AC-DS-21: Badge renders text for every tone ────────────────────────────

describe('AC-DS-21: Badge renders text for all tone values', () => {
  const cases: { tone: BadgeTone; label: string }[] = [
    { tone: 'draft', label: 'Kladde' },
    { tone: 'published', label: 'Udgivet' },
    { tone: 'neutral', label: 'Neutral' },
    { tone: 'success', label: 'Gennemfort' },
    { tone: 'error', label: 'Fejl' },
    { tone: 'accent', label: 'Kun for godkendte brugere' },
    { tone: 'info', label: 'Afventer bekræftelse' },
  ];

  for (const { tone, label } of cases) {
    it(`tone="${tone}" renders its label text`, () => {
      render(<Badge tone={tone}>{label}</Badge>);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  }
});

// ── ML-AC1: the MyLife login badge uses the accent tint ────────────────────

describe('ML-AC1: Badge accent tone (MyLife login "Kun for godkendte brugere")', () => {
  it('tone="accent" uses the accent text on an 8% accent tint', () => {
    render(<Badge tone="accent">Kun for godkendte brugere</Badge>);
    expect(screen.getByText('Kun for godkendte brugere')).toHaveClass('bg-accent/8', 'text-accent');
  });

  it("tone=\"accent\" uses the MyLife mock's 12px type; the status tones keep the small text style", () => {
    render(
      <>
        <Badge tone="accent">Kun for godkendte brugere</Badge>
        <Badge tone="draft">Kladde</Badge>
        <Badge>Neutral</Badge>
      </>,
    );
    const accent = screen.getByText('Kun for godkendte brugere');
    expect(accent).toHaveClass('text-xs');
    expect(accent).not.toHaveClass('text-small');
    expect(screen.getByText('Kladde')).toHaveClass('text-small');
    expect(screen.getByText('Neutral')).toHaveClass('text-small');
  });
});

// ── AMC-19: the info tone is a status tone in the small text style ─────────

describe('AMC-19: Badge info tone ("Afventer bekræftelse")', () => {
  it('tone="info" uses the accent tint in the small text style of the other status tones', () => {
    render(<Badge tone="info">Afventer bekræftelse</Badge>);
    const badge = screen.getByText('Afventer bekræftelse');
    expect(badge).toHaveClass('text-small', 'bg-accent/8', 'text-accent');
    expect(badge).not.toHaveClass('text-xs');
  });
});
