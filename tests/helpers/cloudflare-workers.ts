/**
 * Test stand-in for the Workers runtime module `cloudflare:workers`, which
 * only exists inside workerd: vitest.config.ts aliases the specifier here, so
 * every test that imports workers/payments/index.ts or withdrawal-service.ts
 * loads in Node. Only what the payments Worker uses: a named entrypoint's base
 * class, holding the invocation context and the Worker's env like the
 * runtime's. The Worker bundle (wrangler) keeps the real module.
 */
export abstract class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
