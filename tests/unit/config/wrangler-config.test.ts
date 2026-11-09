/**
 * Unit tests: wrangler.jsonc satisfies the Cloudflare Workers contract.
 *
 * Foundation-toolchain: AC-16..AC-19 (KV ISR cache, name, main, assets, compat).
 * F2.0 cache-infra:     AC-CACHE-13..AC-CACHE-18 (D1 tag cache, DO queue,
 *                       migrations, WORKER_SELF_REFERENCE, no env block,
 *                       preserved KV/flags/vars).
 * monitor-engine:       ENG-AC7 (workers/monitor-cron/wrangler.jsonc: Free-plan
 *                       cron config, no routes/limits, vars, MAIL_FROM parity).
 *
 * Package-script assertions (AC-CACHE-19, ENG-AC7) live in package-scripts.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parse, type ParseError } from 'jsonc-parser';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

type KvNamespace = { binding: string; id: string };
type AssetsConfig = { directory: string; binding: string };
type D1Database = { binding: string; database_name: string; database_id: string };
type DurableObjectBinding = { name: string; class_name: string };
type ServiceBinding = { binding: string; service: string };
type Migration = { tag: string; new_sqlite_classes?: string[] };
type WranglerConfig = {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  assets?: AssetsConfig;
  kv_namespaces?: KvNamespace[];
  r2_buckets?: unknown[];
  d1_databases?: D1Database[];
  durable_objects?: { bindings?: DurableObjectBinding[] };
  migrations?: Migration[];
  services?: ServiceBinding[];
  vars?: Record<string, string>;
  env?: unknown;
};

// ── Module-scope parse ────────────────────────────────────────────────────────
// Parsed once; all describe blocks share the same object.
// ENOENT → readFileSync throws and every test fails clearly.

let config!: WranglerConfig;
let parseErrors!: ParseError[];

beforeAll(() => {
  const wranglerPath = path.resolve(process.cwd(), 'wrangler.jsonc');
  const raw = fs.readFileSync(wranglerPath, 'utf-8');
  parseErrors = [];
  config = parse(raw, parseErrors, { allowTrailingComma: true }) as WranglerConfig;
});

// ── Foundation-toolchain (AC-16..AC-19) ──────────────────────────────────────

describe('wrangler.jsonc (AC-16, AC-17, AC-18, AC-19)', () => {
  it('AC-19: wrangler.jsonc parses without JSONC syntax errors', () => {
    expect(parseErrors).toEqual([]);
  });

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

  it('AC-17: compatibility_flags includes "nodejs_compat"', () => {
    expect(config.compatibility_flags).toContain('nodejs_compat');
  });

  it('AC-18: compatibility_date is defined and >= 2024-09-23', () => {
    expect(config.compatibility_date).toBeDefined();
    const actual = new Date(config.compatibility_date!).getTime();
    const minimum = new Date('2024-09-23').getTime();
    expect(actual).toBeGreaterThanOrEqual(minimum);
  });

  it('AC-16: kv_namespaces contains an entry with binding "NEXT_INC_CACHE_KV" (ISR cache is KV)', () => {
    expect(config.kv_namespaces).toBeDefined();
    const hasKvBinding = config.kv_namespaces!.some(
      (ns) => ns.binding === 'NEXT_INC_CACHE_KV',
    );
    expect(hasKvBinding).toBe(true);
  });

  it('AC-16: does not contain r2_buckets (ISR cache is KV, not R2)', () => {
    expect(config.r2_buckets).toBeUndefined();
  });
});

// ── F2.0 cache-infra: D1 tag cache (AC-CACHE-13) ─────────────────────────────

describe('wrangler.jsonc F2.0 top-level: D1 tag cache (AC-CACHE-13)', () => {
  it('AC-CACHE-13: d1_databases entry has binding "NEXT_TAG_CACHE_D1"', () => {
    const entry = config.d1_databases?.find((d) => d.binding === 'NEXT_TAG_CACHE_D1');
    expect(entry).toBeDefined();
  });

  it('AC-CACHE-13: NEXT_TAG_CACHE_D1 database_name is "alnyron-web-tag-cache"', () => {
    const entry = config.d1_databases?.find((d) => d.binding === 'NEXT_TAG_CACHE_D1');
    expect(entry?.database_name).toBe('alnyron-web-tag-cache');
  });

  it('AC-CACHE-13: NEXT_TAG_CACHE_D1 database_id is a non-empty string', () => {
    const entry = config.d1_databases?.find((d) => d.binding === 'NEXT_TAG_CACHE_D1');
    expect(typeof entry?.database_id).toBe('string');
    expect((entry?.database_id ?? '').length).toBeGreaterThan(0);
  });
});

// ── F2.0 cache-infra: DO revalidation queue (AC-CACHE-14) ────────────────────

describe('wrangler.jsonc F2.0 top-level: DO revalidation queue (AC-CACHE-14)', () => {
  it('AC-CACHE-14: durable_objects.bindings has entry name "NEXT_CACHE_DO_QUEUE"', () => {
    const entry = config.durable_objects?.bindings?.find((b) => b.name === 'NEXT_CACHE_DO_QUEUE');
    expect(entry).toBeDefined();
  });

  it('AC-CACHE-14: NEXT_CACHE_DO_QUEUE class_name is "DOQueueHandler"', () => {
    const entry = config.durable_objects?.bindings?.find((b) => b.name === 'NEXT_CACHE_DO_QUEUE');
    expect(entry?.class_name).toBe('DOQueueHandler');
  });
});

// ── F2.0 cache-infra: DO SQLite migration (AC-CACHE-15) ─────────────────────

describe('wrangler.jsonc F2.0 top-level: DO SQLite migration (AC-CACHE-15)', () => {
  it('AC-CACHE-15: migrations contains entry with tag "v1"', () => {
    const entry = config.migrations?.find((m) => m.tag === 'v1');
    expect(entry).toBeDefined();
  });

  it('AC-CACHE-15: migrations v1 has new_sqlite_classes: ["DOQueueHandler"]', () => {
    const entry = config.migrations?.find((m) => m.tag === 'v1');
    expect(entry?.new_sqlite_classes).toEqual(['DOQueueHandler']);
  });
});

// ── F2.0 cache-infra: WORKER_SELF_REFERENCE service binding (AC-CACHE-16) ────

describe('wrangler.jsonc F2.0 top-level: WORKER_SELF_REFERENCE service binding (AC-CACHE-16)', () => {
  it('AC-CACHE-16: services has WORKER_SELF_REFERENCE binding', () => {
    const entry = config.services?.find((s) => s.binding === 'WORKER_SELF_REFERENCE');
    expect(entry).toBeDefined();
  });

  it('AC-CACHE-16: WORKER_SELF_REFERENCE service is "alnyron-web"', () => {
    const entry = config.services?.find((s) => s.binding === 'WORKER_SELF_REFERENCE');
    expect(entry?.service).toBe('alnyron-web');
  });
});

// ── F2.0 cache-infra: no env block — straight to prod (AC-CACHE-17) ──────────

describe('wrangler.jsonc F2.0: no env block (AC-CACHE-17)', () => {
  it('AC-CACHE-17: wrangler.jsonc has no top-level "env" key (no preview Worker, straight to prod)', () => {
    // The "env" key must be absent entirely — not an empty object.
    // Its presence would create a named environment (e.g. env.preview) which
    // the F2.0 design dropped: straight to prod only.
    expect(config.env).toBeUndefined();
  });
});

// ── F2.0 cache-infra: existing bindings/flags/vars preserved (AC-CACHE-18) ───

describe('wrangler.jsonc F2.0: existing KV binding, compat flags, and vars preserved (AC-CACHE-18)', () => {
  it('AC-CACHE-18: NEXT_INC_CACHE_KV id is still "4a4c256304c143dc89b8685b5a835c3a"', () => {
    const kv = config.kv_namespaces?.find((ns) => ns.binding === 'NEXT_INC_CACHE_KV');
    expect(kv?.id).toBe('4a4c256304c143dc89b8685b5a835c3a');
  });

  it('AC-CACHE-18: compatibility_flags still include "nodejs_compat" and "global_fetch_strictly_public"', () => {
    expect(config.compatibility_flags).toContain('nodejs_compat');
    expect(config.compatibility_flags).toContain('global_fetch_strictly_public');
  });

  it('AC-CACHE-18: vars.MAIL_FROM is still defined', () => {
    expect(config.vars?.MAIL_FROM).toBeDefined();
    expect(typeof config.vars?.MAIL_FROM).toBe('string');
    expect((config.vars?.MAIL_FROM ?? '').length).toBeGreaterThan(0);
  });
});

// ── monitor-cron wrangler config (ENG-AC7) ───────────────────────────────────

type CronWranglerConfig = {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  workers_dev?: boolean;
  preview_urls?: boolean;
  observability?: { enabled?: boolean };
  triggers?: { crons?: string[] };
  limits?: unknown;
  routes?: unknown;
  route?: unknown;
  vars?: Record<string, string>;
};

describe('workers/monitor-cron/wrangler.jsonc — ENG-AC7: Free-plan config', () => {
  let cronConfig!: CronWranglerConfig;
  let cronParseErrors!: ParseError[];

  beforeAll(() => {
    const cronPath = path.resolve(process.cwd(), 'workers/monitor-cron/wrangler.jsonc');
    const raw = fs.readFileSync(cronPath, 'utf-8');
    cronParseErrors = [];
    cronConfig = parse(raw, cronParseErrors, { allowTrailingComma: true }) as CronWranglerConfig;
  });

  it('ENG-AC7wc1: parses without JSONC syntax errors', () => {
    expect(cronParseErrors).toEqual([]);
  });

  it('ENG-AC7wc2: name is "alnyron-monitor-cron"', () => {
    expect(cronConfig.name).toBe('alnyron-monitor-cron');
  });

  it('ENG-AC7wc3: main is "./index.ts"', () => {
    expect(cronConfig.main).toBe('./index.ts');
  });

  it('ENG-AC7wc4: compatibility_date is "2026-10-23"', () => {
    expect(cronConfig.compatibility_date).toBe('2026-10-23');
  });

  it('ENG-AC7wc5: compatibility_flags is exactly ["nodejs_compat","global_fetch_strictly_public"]', () => {
    expect(cronConfig.compatibility_flags).toEqual(['nodejs_compat', 'global_fetch_strictly_public']);
  });

  it('ENG-AC7wc6: workers_dev is false', () => {
    expect(cronConfig.workers_dev).toBe(false);
  });

  it('ENG-AC7wc7: preview_urls is false', () => {
    expect(cronConfig.preview_urls).toBe(false);
  });

  it('ENG-AC7wc8: observability.enabled is true', () => {
    expect(cronConfig.observability?.enabled).toBe(true);
  });

  it('ENG-AC7wc9: triggers.crons is exactly ["* * * * *"] (every-minute Free-plan schedule)', () => {
    expect(cronConfig.triggers?.crons).toEqual(['* * * * *']);
  });

  it('ENG-AC7wc10: no limits field (Free plan — cpu_ms lives under limits, not at top level)', () => {
    expect(cronConfig.limits).toBeUndefined();
  });

  it('ENG-AC7wc11: no routes or route field (cron only, no HTTP ingress)', () => {
    expect(cronConfig.routes).toBeUndefined();
    expect(cronConfig.route).toBeUndefined();
  });

  it('ENG-AC7wc12: vars.MONITOR_BATCH_SIZE is "2"', () => {
    expect(cronConfig.vars?.['MONITOR_BATCH_SIZE']).toBe('2');
  });

  it('ENG-AC7wc13: vars.MONITOR_SUBREQUEST_LIMIT is "50"', () => {
    expect(cronConfig.vars?.['MONITOR_SUBREQUEST_LIMIT']).toBe('50');
  });

  it('ENG-AC7wc14: vars.MONITOR_SITE_URL is "https://monitor.alnyron.dk"', () => {
    expect(cronConfig.vars?.['MONITOR_SITE_URL']).toBe('https://monitor.alnyron.dk');
  });

  it('ENG-AC7wc15: vars.SUPABASE_URL is "https://xmgpixhxecamtryohgmk.supabase.co"', () => {
    expect(cronConfig.vars?.['SUPABASE_URL']).toBe('https://xmgpixhxecamtryohgmk.supabase.co');
  });

  it('ENG-AC7wc16: vars.MAIL_FROM matches root wrangler.jsonc vars.MAIL_FROM', () => {
    expect(cronConfig.vars?.['MAIL_FROM']).toBe(config.vars?.['MAIL_FROM']);
    expect(cronConfig.vars?.['MAIL_FROM']).toBeDefined();
  });
});
