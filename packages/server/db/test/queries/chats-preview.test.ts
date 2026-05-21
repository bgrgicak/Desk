/**
 * Direct unit coverage of `previewFromContent`.
 *
 * The function walks the server message-content discriminated union
 * to extract a single short preview string for the chat-list
 * sidebar.  The chats.test.ts integration test covers it via real
 * SQL round-trips; this file pins the JSON-parsing edge cases that
 * are inconvenient to set up in SQL fixtures (malformed JSON,
 * non-string content, mixed event-log shapes, etc.).
 */
import { describe, expect, it } from "vitest";
import { previewFromContent } from "../../src/queries/chats.js";

describe("previewFromContent", () => {
  it("returns an empty string for null / undefined / non-object inputs", () => {
    expect(previewFromContent(null)).toBe("");
    expect(previewFromContent(undefined)).toBe("");
    expect(previewFromContent(42 as unknown)).toBe("");
    // Boolean / number aren't messages — neither short-circuits the
    // pipeline, they all return "".
    expect(previewFromContent(true as unknown)).toBe("");
  });

  it("falls back to the raw string when the input is a non-JSON string", () => {
    // Pre-JSON-content rows (or corrupt rows) — best-effort plain
    // string preview without throwing.
    expect(previewFromContent("not json at all")).toBe("not json at all");
  });

  it("extracts text content from a stringified `type=text` payload", () => {
    expect(previewFromContent(JSON.stringify({ type: "text", text: "hello world" })))
      .toBe("hello world");
  });

  it("extracts text content from an already-parsed `type=text` payload", () => {
    expect(previewFromContent({ type: "text", text: "hello already-parsed" }))
      .toBe("hello already-parsed");
  });

  it("normalises whitespace and trims", () => {
    expect(previewFromContent({ type: "text", text: "  hello\n  there\t friend  " }))
      .toBe("hello there friend");
  });

  it("returns empty when text is missing/non-string on a text content", () => {
    expect(previewFromContent({ type: "text" })).toBe("");
    expect(previewFromContent({ type: "text", text: 42 })).toBe("");
  });

  it("concatenates every visible text event from a `type=events` log", () => {
    expect(previewFromContent({
      type: "events",
      log: [
        { kind: "event", event: { type: "text", part: { text: "Tasks are " } } },
        { kind: "stderr", line: "this is noise" },
        { kind: "event", event: { type: "text", part: { text: "scheduled messages." } } },
      ],
    })).toBe("Tasks are scheduled messages.");
  });

  it("skips non-text events inside the log", () => {
    expect(previewFromContent({
      type: "events",
      log: [
        { kind: "event", event: { type: "tool", part: { input: "hidden" } } },
        { kind: "unparsed", line: "raw" },
        { kind: "event", event: { type: "text", part: { text: "Only this." } } },
      ],
    })).toBe("Only this.");
  });

  it("returns empty when the log is empty or all entries are non-visible", () => {
    expect(previewFromContent({ type: "events", log: [] })).toBe("");
    expect(previewFromContent({
      type: "events",
      log: [{ kind: "stderr", line: "ignored" }],
    })).toBe("");
  });

  it("returns empty for non-text/events content types", () => {
    expect(previewFromContent({ type: "artifactRef", path: "x" })).toBe("");
    expect(previewFromContent({ type: "summary", body: "hi" })).toBe("");
    expect(previewFromContent({ type: "agent_turn", userMessageId: "x" })).toBe("");
  });

  it("truncates at 200 UTF-16 code units with an ellipsis", () => {
    const text = "x".repeat(500);
    const out = previewFromContent({ type: "text", text });
    expect(out).toHaveLength(200);
    expect(out.endsWith("…")).toBe(true);
    // Right at the boundary — exactly 200 chars passes through.
    const exactly200 = "y".repeat(200);
    expect(previewFromContent({ type: "text", text: exactly200 })).toBe(exactly200);
  });
});
