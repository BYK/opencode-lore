import { describe, test, expect, afterEach } from "bun:test";
import { writePortFile, readPortFile, removePortFile } from "../src/portfile";

// Clean up any port file we wrote during tests.
afterEach(() => {
  try {
    // Force-remove by writing a known value then removing with that value.
    writePortFile(99999);
    removePortFile(99999);
  } catch {
    /* best effort */
  }
});

describe("portfile", () => {
  test("readPortFile returns null when no file exists", () => {
    // Ensure no port file exists (afterEach from previous test handles this,
    // but also clean before first run).
    writePortFile(99999);
    removePortFile(99999);

    expect(readPortFile()).toBeNull();
  });

  test("writePortFile + readPortFile round-trips a port number", () => {
    writePortFile(3207);
    expect(readPortFile()).toBe(3207);
  });

  test("writePortFile overwrites an existing port file", () => {
    writePortFile(3207);
    writePortFile(5673);
    expect(readPortFile()).toBe(5673);
  });

  test("removePortFile deletes the file when port matches", () => {
    writePortFile(3207);
    removePortFile(3207);
    expect(readPortFile()).toBeNull();
  });

  test("removePortFile does NOT delete the file when port differs", () => {
    writePortFile(5673);
    removePortFile(3207); // wrong port — should not remove
    expect(readPortFile()).toBe(5673);
  });

  test("removePortFile is a no-op when no file exists", () => {
    // Should not throw.
    removePortFile(3207);
    expect(readPortFile()).toBeNull();
  });

  test("readPortFile rejects invalid content", () => {
    // Simulate corrupted file by writing a valid port, then we can't
    // easily write arbitrary content via the API — but we can verify
    // the validation logic by writing port 0 (invalid) and checking.
    // Actually writePortFile accepts any number, but readPortFile
    // validates port > 0 && port <= 65535.
    writePortFile(0);
    expect(readPortFile()).toBeNull();

    writePortFile(70000);
    expect(readPortFile()).toBeNull();
  });
});
