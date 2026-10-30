import { describe, it, expect, beforeAll } from 'vitest';
import { parse, type ParseError } from 'jsonc-parser';
import * as fs from 'node:fs';
import * as path from 'node:path';

// AC-16..AC-19: Verify wrangler.jsonc at the repo root satisfies the
// Cloudflare Workers + KV ISR-cache contract.
// These tests will FAIL until web-developer creates wrangler.jsonc.

type KvNamespace = { binding: string; id: string };
type AssetsConfig = { directory: string; binding: string };
type WranglerConfig = {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  assets?: AssetsConfig;
  kv_namespaces?: KvNamespace[];
  r2_buckets?: unknown[];
  [key: string]: unknown;
};

describe('wrangler.jsonc (AC-16, AC-17, AC-18, AC-19)', () => {
  let config!: WranglerConfig;
  let parseErrors!: ParseError[];

  beforeAll(() => {
    // Resolve relative to the repo root (process.cwd() = project root under vitest).
    const wranglerPath = path.resolve(process.cwd(), 'wrangler.jsonc');
    const raw = fs.readFileSync(wranglerPath, 'utf-8'); // throws if file absent
    parseErrors = [];
    config = parse(raw, parseErrors, { allowTrailingComma: true }) as WranglerConfig;
  });

  it('AC-19: wrangler.jsonc parses without JSONC syntax errors', () => {
    expect(parseErrors).toEqual([]);
  });

  // AC-19 ------------------------------------------------------------------

  it('AC-19: name is "alnyron-web"', () => {
    expect(config.name).toBe('alnyron-web');
  });

  it('AC-19: main points to ".open-next/worker.js"', () => {
    expect(config.main).toBe('.open-next/worker.js');
  });

  it('AC-19: assets.directory is ".open-next/assets"', () => {
    expect(config.assets?.directory).toBe('.open-next/assets');
  });

  it('AC-19: assets.binding is "ASSETS"', () => {
    expect(config.assets?.binding).toBe('ASSETS');
  });

  // AC-17 ------------------------------------------------------------------

  it('AC-17: compatibility_flags includes "nodejs_compat"', () => {
    expect(config.compatibility_flags).toContain('nodejs_compat');
  });

  // AC-18 ------------------------------------------------------------------

  it('AC-18: compatibility_date is defined and >= 2024-09-23', () => {
    expect(config.compatibility_date).toBeDefined();
    const actual = new Date(config.compatibility_date!).getTime();
    const minimum = new Date('2024-09-23').getTime();
    expect(actual).toBeGreaterThanOrEqual(minimum);
  });

  // AC-16 ------------------------------------------------------------------

  it('AC-16: kv_namespaces contains an entry with binding "NEXT_INC_CACHE_KV" (ISR cache is KV)', () => {
    expect(config.kv_namespaces).toBeDefined();
    const hasKvBinding = config.kv_namespaces!.some(
      (ns) => ns.binding === 'NEXT_INC_CACHE_KV',
    );
    expect(hasKvBinding).toBe(true);
  });

  it('AC-16: does not contain r2_buckets (ISR cache is KV, not R2)', () => {
    // Explicitly verify the KV decision: no R2 bucket config present.
    expect(config.r2_buckets).toBeUndefined();
  });
});
