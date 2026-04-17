// Bun runtime driver for Lore's SQLite access.
//
// Selected automatically via the `#db/driver` subpath import map when running
// under Bun (OpenCode plugin, `bun test`).
//
// The `Database` class is re-exported as-is; `bun:sqlite`'s API already matches
// everything Lore uses: `.query(sql)` with cached prepared statements, `.run()`,
// `.all()`, `.get()`, transactions, PRAGMAs, BLOB columns, and FTS5.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export { Database };

/** Stable SHA-256 hex digest — replaces the Bun-only `Bun.CryptoHasher`. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
