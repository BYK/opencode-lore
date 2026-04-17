import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterAll } from "bun:test";
import { close } from "../src/db";

// Create an isolated temporary database for the entire test run.
// This prevents test fixtures from leaking into the live lore DB
// at ~/.local/share/opencode-lore/lore.db.
const tmp = mkdtempSync(join(tmpdir(), "lore-test-"));
process.env.LORE_DB_PATH = join(tmp, "test.db");

afterAll(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});
