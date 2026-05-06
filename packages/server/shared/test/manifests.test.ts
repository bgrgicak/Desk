import { describe, it, expect } from "vitest";
import {
  AppManifestSchema,
  FragmentManifestSchema,
  isOptionalParamKey,
  stripOptionalMarker,
} from "../src/manifests.js";

describe("AppManifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    const m = AppManifestSchema.parse({
      name: "todos",
      description: "A simple todo tracker.",
    });
    expect(m.name).toBe("todos");
    expect(m.description).toBe("A simple todo tracker.");
  });

  it("requires a non-empty description", () => {
    expect(() =>
      AppManifestSchema.parse({ name: "todos", description: "" }),
    ).toThrow(/description/i);
    expect(() =>
      AppManifestSchema.parse({ name: "todos" }),
    ).toThrow();
  });

  it("accepts the bespoke params shape", () => {
    const m = AppManifestSchema.parse({
      name: "notes",
      description: "Note editor app.",
      params: {
        "note_id": "string",
        "mode?": "edit | view",
      },
    });
    expect(m.params).toEqual({
      "note_id": "string",
      "mode?": "edit | view",
    });
  });

  it("rejects malformed param names and empty types", () => {
    expect(() =>
      AppManifestSchema.parse({
        name: "x",
        description: "x",
        params: { "1bad": "string" },
      }),
    ).toThrow();
    expect(() =>
      AppManifestSchema.parse({
        name: "x",
        description: "x",
        params: { good: "" },
      }),
    ).toThrow();
  });

  it("passes through unknown top-level keys (lenient)", () => {
    // Hand-authored manifests routinely grow ad-hoc keys (displayName,
    // version, tags…). Strict mode would silently lose them from the
    // search index, so we accept-and-ignore.
    const m = AppManifestSchema.parse({
      name: "x",
      description: "x",
      bogus: 1,
    });
    expect(m.name).toBe("x");
  });
});

describe("FragmentManifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    const m = FragmentManifestSchema.parse({
      name: "note-editor",
      description: "Inline note editor for a single note.",
    });
    expect(m.name).toBe("note-editor");
  });

  it("supports the params field on fragments", () => {
    const m = FragmentManifestSchema.parse({
      name: "note-editor",
      description: "Inline note editor.",
      params: { "note_id": "string" },
    });
    expect(m.params).toEqual({ "note_id": "string" });
  });

  it("requires description", () => {
    expect(() =>
      FragmentManifestSchema.parse({ name: "x", description: "" }),
    ).toThrow();
  });
});

describe("param key helpers", () => {
  it("isOptionalParamKey detects trailing ?", () => {
    expect(isOptionalParamKey("note_id")).toBe(false);
    expect(isOptionalParamKey("mode?")).toBe(true);
  });

  it("stripOptionalMarker removes the trailing ?", () => {
    expect(stripOptionalMarker("note_id")).toBe("note_id");
    expect(stripOptionalMarker("mode?")).toBe("mode");
  });
});
