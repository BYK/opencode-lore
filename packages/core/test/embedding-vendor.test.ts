/**
 * Tests for the vendor-registration module used by the standalone Lore
 * binary. Now that fastembed + native bindings are bundled directly into
 * the binary by Bun's compiler (rather than extracted from a tarball at
 * runtime), the runtime module is intentionally tiny — it just exposes
 * the model-path registration set by the binary's wrapper. These tests
 * verify the binary-mode / npm-mode contract that the LocalProvider
 * relies on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  isVendoredBinary,
  vendorModelInfo,
  vendorRegistration,
  _setVendorRegistration,
} from "../src/embedding-vendor";

afterEach(() => {
  _setVendorRegistration(null);
});

describe("npm mode (no registration)", () => {
  test("isVendoredBinary returns false", () => {
    expect(isVendoredBinary()).toBe(false);
  });

  test("vendorRegistration returns null", () => {
    expect(vendorRegistration()).toBeNull();
  });

  test("vendorModelInfo returns null", () => {
    expect(vendorModelInfo()).toBeNull();
  });
});

describe("binary mode (registration set)", () => {
  test("isVendoredBinary returns true once registration is set", () => {
    _setVendorRegistration({
      modelAbsoluteDirPath: "/some/abs/dir/bge-small-en-v1.5",
      modelName: "model_quantized.onnx",
      target: "linux-x64",
      version: "9.9.9",
    });
    expect(isVendoredBinary()).toBe(true);
  });

  test("vendorRegistration returns the full record (for diagnostics)", () => {
    const reg = {
      modelAbsoluteDirPath: "/some/abs/dir/bge-small-en-v1.5",
      modelName: "model_quantized.onnx",
      target: "darwin-arm64",
      version: "0.16.0",
    };
    _setVendorRegistration(reg);
    expect(vendorRegistration()).toEqual(reg);
  });

  test("vendorModelInfo strips diagnostic fields", () => {
    _setVendorRegistration({
      modelAbsoluteDirPath: "/some/abs/dir/bge-small-en-v1.5",
      modelName: "model_quantized.onnx",
      target: "linux-x64",
      version: "9.9.9",
    });
    const info = vendorModelInfo();
    expect(info).toEqual({
      modelAbsoluteDirPath: "/some/abs/dir/bge-small-en-v1.5",
      modelName: "model_quantized.onnx",
    });
    // The full type isn't leaked through vendorModelInfo — target /
    // version are diagnostic-only and shouldn't make it into the
    // fastembed init args.
    expect(info).not.toHaveProperty("target");
    expect(info).not.toHaveProperty("version");
  });

  test("clearing the registration reverts to npm-mode behaviour", () => {
    _setVendorRegistration({
      modelAbsoluteDirPath: "/x",
      modelName: "x.onnx",
      target: "linux-x64",
      version: "0",
    });
    expect(isVendoredBinary()).toBe(true);
    _setVendorRegistration(null);
    expect(isVendoredBinary()).toBe(false);
    expect(vendorModelInfo()).toBeNull();
  });
});
