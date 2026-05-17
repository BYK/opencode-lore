import { describe, it, expect } from "bun:test";
import { loadConfig, writeConfig } from "../src/config";
import { slugify } from "../src/utils";

describe("config", () => {
  it("returns null for missing config", () => {
    expect(loadConfig("/nonexistent")).toBeNull();
  });
});

describe("utils", () => {
  it("slugifies text", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("foo--bar")).toBe("foo-bar");
  });
});
