import { asRecord } from "@/lib/payments/webhook-mapping";

/**
 * Whether `error` is the database's business refusal `message` (SQLSTATE
 * P0001, e.g. `window_expired`): a `PaymentsRpcError` from rpc.ts, or any
 * error of that message and code. Kept apart from rpc.ts so a caller does
 * not depend on the client module for it.
 */
export function isDatabaseRefusal(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message && asRecord(error)?.code === "P0001";
}
