/**
 * Guard for tests that run a migration file inside withTx: a transaction-control statement in
 * the file would end withTx's transaction, so the migration (and anything seeded with it) would
 * persist on the target DB instead of rolling back.
 */

/** Statement keywords that start, end or nest a transaction. */
const TRANSACTION_CONTROL = /^(begin|start\s+transaction|commit|end|abort|rollback|savepoint|release|prepare\s+transaction)\b/i;

/**
 * The statements of `sql` that control the transaction. Comments and dollar-quoted bodies are
 * removed first, so neither a `-- commit` remark nor a function's `end;` counts.
 */
export function transactionControlStatements(sql: string): string[] {
  return sql
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => TRANSACTION_CONTROL.test(statement));
}
