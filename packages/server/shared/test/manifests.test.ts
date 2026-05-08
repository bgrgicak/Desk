import { describe, expect, it } from "vitest";
import {
  AppManifestSchema,
  FragmentManifestSchema,
  isOptionalParamKey,
  stripOptionalMarker,
} from "../src/manifests.js";

describe("manifest schemas", () => {
  it("accepts app and fragment params", () => {
    expect(AppManifestSchema.parse({
      name: "todo-list",
      description: "Task app",
      params: { "filter?": "all | open | done" },
    }).params).toEqual({ "filter?": "all | open | done" });

    expect(FragmentManifestSchema.parse({
      name: "note-editor",
      description: "Inline list",
      params: { note_id: "string" },
    }).params).toEqual({ note_id: "string" });
  });

  it("requires descriptions and validates param names", () => {
    expect(() => AppManifestSchema.parse({ name: "todos" })).toThrow();
    expect(() => FragmentManifestSchema.parse({
      name: "list",
      description: "Inline list",
      params: { "1bad": "string" },
    })).toThrow();
  });

  it("handles optional param markers", () => {
    expect(isOptionalParamKey("mode?")).toBe(true);
    expect(isOptionalParamKey("mode")).toBe(false);
    expect(stripOptionalMarker("mode?")).toBe("mode");
  });
});
