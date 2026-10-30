// Tests for AC-DS-24 through AC-DS-27
// Asserts icon.png, apple-icon.png, favicon replacement, and SVG removal.
// These tests FAIL (Red) until web-developer creates the icon files and removes scaffolding.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const ROOT = process.cwd(); // C:\dev\alnyron

// SHA-256 of the create-next-app default favicon.ico (computed from the committed file).
const CNA_FAVICON_SHA256 = '2b8ad2d33455a8f736fc3a8ebf8f0bdea8848ad4c0db48a2833bd0f9cd775932';

// PNG file signature: 8 bytes — 137 80 78 71 13 10 26 10
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf: Buffer): boolean {
  return buf.slice(0, 8).equals(PNG_MAGIC);
}

function pngDimensions(buf: Buffer): { width: number; height: number } {
  // PNG IHDR chunk: signature(8) + chunk-length(4) + "IHDR"(4) + width(4) + height(4)
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

// ── AC-DS-24: src/app/icon.png ─────────────────────────────────────────────

describe('AC-DS-24: src/app/icon.png exists and is a valid PNG', () => {
  it('file exists', () => {
    expect(existsSync(join(ROOT, 'src/app/icon.png'))).toBe(true);
  });

  it('has PNG magic bytes', () => {
    const buf = readFileSync(join(ROOT, 'src/app/icon.png'));
    expect(isPng(buf)).toBe(true);
  });
});

// ── AC-DS-25: src/app/apple-icon.png ──────────────────────────────────────

describe('AC-DS-25: src/app/apple-icon.png exists, is valid PNG, and is 180×180', () => {
  it('file exists', () => {
    expect(existsSync(join(ROOT, 'src/app/apple-icon.png'))).toBe(true);
  });

  it('has PNG magic bytes', () => {
    const buf = readFileSync(join(ROOT, 'src/app/apple-icon.png'));
    expect(isPng(buf)).toBe(true);
  });

  it('IHDR width is 180', () => {
    const buf = readFileSync(join(ROOT, 'src/app/apple-icon.png'));
    expect(pngDimensions(buf).width).toBe(180);
  });

  it('IHDR height is 180', () => {
    const buf = readFileSync(join(ROOT, 'src/app/apple-icon.png'));
    expect(pngDimensions(buf).height).toBe(180);
  });
});

// ── AC-DS-26: favicon.ico replaced ────────────────────────────────────────

describe('AC-DS-26: src/app/favicon.ico is absent or differs from create-next-app default', () => {
  it('favicon is gone or has a custom A-mark content', () => {
    const faviconPath = join(ROOT, 'src/app/favicon.ico');
    if (!existsSync(faviconPath)) {
      // Acceptable: Next.js will fall back to icon.png for the favicon.
      expect(true).toBe(true);
      return;
    }
    const hash = createHash('sha256').update(readFileSync(faviconPath)).digest('hex');
    expect(hash).not.toBe(CNA_FAVICON_SHA256);
  });
});

// ── AC-DS-27: create-next-app scaffold SVGs removed ────────────────────────

describe('AC-DS-27: create-next-app SVGs removed from public/', () => {
  const cnaAssets = ['file.svg', 'globe.svg', 'next.svg', 'vercel.svg', 'window.svg'];

  for (const asset of cnaAssets) {
    it(`public/${asset} is removed`, () => {
      expect(existsSync(join(ROOT, 'public', asset))).toBe(false);
    });
  }
});
