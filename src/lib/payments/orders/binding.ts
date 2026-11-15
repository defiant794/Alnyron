import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  parseOrderServiceResult,
  type OrderServiceMethod,
  type OrderServiceResult,
} from "@/lib/payments/orders/service-contract";

/** The payments Worker's `OrderService` as the `ORDERS` service binding exposes it. */
export type OrdersBinding = NonNullable<CloudflareEnv["ORDERS"]>;

/**
 * Calls the payments Worker's `OrderService` over the `ORDERS` service
 * binding (`call` invokes `method` on it) and checks the answer with the
 * shared contract (`parseOrderServiceResult`), never trusting its shape.
 *
 * Null stands for `unavailable`: there is no Cloudflare context or no
 * `ORDERS` binding (a Worker or dev proxy without it), the call throws (a
 * Worker error, or locally while no payments Worker runs), or the answer has
 * another shape.
 */
export async function callOrderService<M extends OrderServiceMethod>(
  method: M,
  call: (orders: OrdersBinding) => Promise<unknown>,
): Promise<OrderServiceResult<M> | null> {
  let orders: OrdersBinding | undefined;
  try {
    orders = getCloudflareContext().env.ORDERS;
  } catch {
    return null;
  }
  if (orders === undefined) return null;
  let answer: unknown;
  try {
    answer = await call(orders);
  } catch {
    return null;
  }
  return parseOrderServiceResult(method, answer);
}
