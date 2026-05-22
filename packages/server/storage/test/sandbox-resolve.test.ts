import { describe, it, expect } from "vitest";
import { ValidationError } from "@roomy-ai/shared";
import { resolveHostPath } from "../src/layout.js";

describe("resolveHostPath", () => {
  const home = "/tmp/roomy-test-home";
  const slug = "roomy";

  it("resolves a valid relative path", () => {
    const result = resolveHostPath(home, slug, "files/fil_abc123-hello.txt");
    expect(result).toBe("/tmp/roomy-test-home/roomy/files/fil_abc123-hello.txt");
  });

  it("resolves a library path", () => {
    const result = resolveHostPath(home, slug, "library/fil_abc123-note.md");
    expect(result).toBe("/tmp/roomy-test-home/roomy/library/fil_abc123-note.md");
  });

  it("rejects path traversal with ..", () => {
    expect(() => resolveHostPath(home, slug, "../../etc/passwd")).toThrow(ValidationError);
  });

  it("rejects absolute paths that escape the root", () => {
    expect(() => resolveHostPath(home, slug, "/etc/passwd")).toThrow(ValidationError);
  });
});
