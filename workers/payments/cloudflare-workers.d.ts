// The part of the Workers runtime module `cloudflare:workers` the payments Worker uses, typed by
// hand: the repo type-checks with the DOM lib, not @cloudflare/workers-types (see index.ts). A
// class extending WorkerEntrypoint and exported from the Worker's main module is a named
// entrypoint: other Workers reach its public methods over a service binding (JS RPC), never over
// HTTP routes. Tests load tests/helpers/cloudflare-workers.ts instead (vitest.config.ts alias).
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    /** The invocation's ExecutionContext (waitUntil, passThroughOnException). */
    protected ctx: unknown;
    /** The Worker's bindings, vars and secrets. */
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
