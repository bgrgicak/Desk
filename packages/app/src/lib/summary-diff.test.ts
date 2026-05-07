import { describe, it, expect } from "vitest";
import { diffLines } from "./summary-diff";

describe("diffLines", () => {
  it("returns a single equal segment when bodies are identical", () => {
    const segments = diffLines("a\nb\nc", "a\nb\nc");
    expect(segments).toEqual([{ kind: "equal", text: "a\nb\nc" }]);
  });

  it("marks new trailing lines as add", () => {
    const segments = diffLines("a\nb", "a\nb\nc");
    expect(segments).toEqual([
      { kind: "equal", text: "a\nb" },
      { kind: "add", text: "c" },
    ]);
  });

  it("marks removed trailing lines as remove", () => {
    const segments = diffLines("a\nb\nc", "a\nb");
    expect(segments).toEqual([
      { kind: "equal", text: "a\nb" },
      { kind: "remove", text: "c" },
    ]);
  });

  it("captures replacements as remove + add adjacent", () => {
    const segments = diffLines("a\nold\nc", "a\nnew\nc");
    expect(segments).toEqual([
      { kind: "equal", text: "a" },
      { kind: "remove", text: "old" },
      { kind: "add", text: "new" },
      { kind: "equal", text: "c" },
    ]);
  });

  it("handles entirely different bodies", () => {
    const segments = diffLines("a\nb", "c\nd");
    expect(segments).toEqual([
      { kind: "remove", text: "a\nb" },
      { kind: "add", text: "c\nd" },
    ]);
  });

  it("returns an empty array when both bodies are empty", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("returns only-add when before is empty", () => {
    expect(diffLines("", "x\ny")).toEqual([{ kind: "add", text: "x\ny" }]);
  });

  it("collapses consecutive same-kind runs into a single segment", () => {
    const segments = diffLines("a\nb\nc", "x\ny\nz");
    expect(segments).toEqual([
      { kind: "remove", text: "a\nb\nc" },
      { kind: "add", text: "x\ny\nz" },
    ]);
  });
});
