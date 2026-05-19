import { describe, test, expect } from "bun:test";
import { extractUpstreamUrlHeader } from "../src/config";

// ---------------------------------------------------------------------------
// extractUpstreamUrlHeader
// ---------------------------------------------------------------------------

describe("extractUpstreamUrlHeader", () => {
  test("returns undefined when header is absent", () => {
    expect(extractUpstreamUrlHeader({})).toBeUndefined();
    expect(extractUpstreamUrlHeader({ "x-api-key": "sk-abc" })).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(extractUpstreamUrlHeader({ "x-lore-upstream-url": "" })).toBeUndefined();
  });

  test("returns undefined for whitespace-only string", () => {
    expect(extractUpstreamUrlHeader({ "x-lore-upstream-url": "   " })).toBeUndefined();
  });

  test("extracts valid http URL", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "http://localhost:8000" }),
    ).toBe("http://localhost:8000");
  });

  test("extracts valid https URL", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "https://my-server.example.com:4000" }),
    ).toBe("https://my-server.example.com:4000");
  });

  test("preserves path component", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "http://localhost:8000/v1" }),
    ).toBe("http://localhost:8000/v1");
  });

  test("strips trailing slashes from path", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "http://localhost:8000/v1/" }),
    ).toBe("http://localhost:8000/v1");
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "http://localhost:8000/" }),
    ).toBe("http://localhost:8000");
  });

  test("strips multiple trailing slashes", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "http://localhost:8000///" }),
    ).toBe("http://localhost:8000");
  });

  test("trims surrounding whitespace", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "  http://localhost:8000  " }),
    ).toBe("http://localhost:8000");
  });

  test("rejects non-http protocol (ftp)", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "ftp://files.example.com" }),
    ).toBeUndefined();
  });

  test("rejects non-http protocol (file)", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "file:///etc/passwd" }),
    ).toBeUndefined();
  });

  test("rejects invalid URL", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "not a url" }),
    ).toBeUndefined();
  });

  test("strips control characters before validation", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "http://localhost:8000\x00\x1f" }),
    ).toBe("http://localhost:8000");
  });

  test("rejects oversized value (> 2048 chars)", () => {
    const longUrl = `http://localhost:8000/${"a".repeat(2048)}`;
    expect(extractUpstreamUrlHeader({ "x-lore-upstream-url": longUrl })).toBeUndefined();
  });

  test("accepts value at exactly 2048 chars", () => {
    // "http://localhost:8000/" = 22 chars, pad path to reach 2048 total
    const path = "a".repeat(2048 - "http://localhost:8000/".length);
    const url = `http://localhost:8000/${path}`;
    expect(url.length).toBe(2048);
    expect(extractUpstreamUrlHeader({ "x-lore-upstream-url": url })).toBeDefined();
  });

  test("does not strip query parameters (origin + pathname only)", () => {
    // URL constructor includes query/fragment in href but origin+pathname excludes them
    const result = extractUpstreamUrlHeader({
      "x-lore-upstream-url": "http://localhost:8000/v1?key=val",
    });
    expect(result).toBe("http://localhost:8000/v1");
  });
});
