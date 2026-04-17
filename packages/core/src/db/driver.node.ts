// Node runtime driver for Lore's SQLite access.
//
// Selected via the `#db/driver` subpath import map when running under Node
// (Pi extension, future ACP server, and CI nodes that aren't Bun). `node:sqlite`
// has shipped in Node since 22.5 and stabilized (no flag) in Node 24.
//
// Bun deliberately does NOT implement `node:sqlite`, so src code that imports
// from this file must go through `#db/driver`. Never import `node:sqlite`
// directly outside this file — it will break `bun test` which runs against src.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";

/**
 * Per-database cache of prepared statements keyed by SQL string.
 *
 * `bun:sqlite` automatically caches prepared statements per-DB when using
 * `.query(sql)`; `node:sqlite` has only `.prepare(sql)` which recompiles on
 * every call. We add a thin `.query()` alias on top of `.prepare()` with
 * caching so every existing call site (`db().query(...).all(...)`) keeps
 * working identically.
 *
 * WeakMap: cache is tied to the Database instance lifetime, no manual cleanup.
 */
const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/**
 * Drop-in replacement for `bun:sqlite`'s `Database`.
 *
 * Adds a `.query()` method that caches the underlying `StatementSync`
 * per SQL string. All other methods (`.prepare()`, `.exec()`, `.run()`,
 * `.close()`, PRAGMAs, transactions) come from `DatabaseSync` unchanged.
 */
export class Database extends DatabaseSync {
  /** Cached prepared statement for this SQL. Compiled on first call. */
  query(sql: string): StatementSync {
    let map = statementCache.get(this);
    if (!map) {
      map = new Map<string, StatementSync>();
      statementCache.set(this, map);
    }
    let stmt = map.get(sql);
    if (!stmt) {
      stmt = this.prepare(sql);
      map.set(sql, stmt);
    }
    return stmt;
  }
}

/** Stable SHA-256 hex digest — replaces the Bun-only `Bun.CryptoHasher`. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
