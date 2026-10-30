// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import Page from '@/app/page';

// AC-20: The default-export server component (src/app/page.tsx) must render
// an <h1> with accessible name "Alnyron".
// This test will FAIL until web-developer creates src/app/page.tsx.

describe('Home Page (AC-20)', () => {
  afterEach(cleanup);

  it('AC-20: renders a level-1 heading with accessible name "Alnyron"', () => {
    render(<Page />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Alnyron' }),
    ).toBeInTheDocument();
  });
});
