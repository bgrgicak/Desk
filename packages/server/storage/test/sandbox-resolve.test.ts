import { describe, it, expect } from "vitest";
import { ValidationError } from "@desk/shared";
import { resolveHostPath } from "../src/layout.js";

describe("resolveHostPath", () => {
  const home = "/tmp/desk-test-home";

  it("resolves a valid relative path", () => {
    const result = resolveHostPath(home, "files/fil_abc123-hello.txt");
    expect(result).toBe("/tmp/desk-test-home/Desk/workspaces/desk/files/fil_abc123-hello.txt");
  });

  it("resolves a library path", () => {
    const result = resolveHostPath(home, "library/fil_abc123-note.md");
    expect(result).toBe("/tmp/desk-test-home/Desk/workspaces/desk/library/fil_abc123-note.md");
  });

  it("rejects path traversal with ..", () => {
    expect(() => resolveHostPath(home, "../../etc/passwd")).toThrow(ValidationError);
  });

  it("rejects absolute paths that escape the root", () => {
    expect(() => resolveHostPath(home, "/etc/passwd")).toThrow(ValidationError);
  });
});
