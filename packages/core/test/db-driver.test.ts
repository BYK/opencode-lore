import { test, expect } from "bun:test";
import { Database, sha256 } from "../src/db/driver.bun";

// Smoke tests for the db driver shim — confirms the API surface Lore relies on
// is identical between the bun and node drivers. The full Lore test suite
// exercises the rest via normal DB usage; this file exists mostly so failures
// surface at `bun test` time if we ever drift, and so we have something to
// audit when adding a future ffi-based driver.

test("Database.query() returns a cached prepared statement", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

  // Two query() calls with the same SQL should be able to run independently
  // (bun:sqlite and the node shim both achieve this via caching).
  const insert = db.query("INSERT INTO t (id, name) VALUES (?, ?)");
  insert.run(1, "foo");
  insert.run(2, "bar");

  const all = db.query("SELECT id, name FROM t ORDER BY id").all();
  expect(all).toEqual([
    { id: 1, name: "foo" },
    { id: 2, name: "bar" },
  ]);

  const get = db.query("SELECT id, name FROM t WHERE id = ?").get(1);
  expect(get).toEqual({ id: 1, name: "foo" });

  db.close();
});

test("FTS5 MATCH and bm25() work via the driver", () => {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE f USING fts5(content, tokenize='porter unicode61')");
  db.exec("INSERT INTO f (content) VALUES ('hello world'), ('goodbye moon')");
  const rows = db
    .query("SELECT content, bm25(f) AS score FROM f WHERE f MATCH ? ORDER BY score")
    .all("hello") as Array<{ content: string; score: number }>;
  expect(rows.length).toBe(1);
  expect(rows[0].content).toBe("hello world");
  expect(typeof rows[0].score).toBe("number");
  db.close();
});

test("DELETE...RETURNING works via the driver", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE q (id INTEGER PRIMARY KEY, data TEXT)");
  db.query("INSERT INTO q (id, data) VALUES (?, ?)").run(1, "alpha");
  const returned = db
    .query("DELETE FROM q WHERE id = ? RETURNING data")
    .all(1) as Array<{ data: string }>;
  expect(returned).toEqual([{ data: "alpha" }]);
  db.close();
});

test("sha256() returns a stable hex digest", () => {
  expect(sha256("hello")).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  expect(sha256("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
