import { describe, it, expect } from "vitest";
import {
  parseWsEvent,
  serializeWsEvent,
  type WsEvent,
} from "../src/index.js";

const now = new Date().toISOString();

const fixtures: Record<string, WsEvent> = {
  "chat.updated": {
    type: "chat.updated",
    payload: { id: "cht_abc", workspaceId: "wks_abc", agentId: "agt_abc", title: "Chat", updatedAt: now, awaitingUser: false, unread: false },
  },
  "message.appended": {
    type: "message.appended",
    payload: { id: "msg_abc", chatId: "cht_abc", role: "user", content: { type: "text", text: "hi" }, createdAt: now, kind: "chat" },
  },
  "message.streaming": {
    type: "message.streaming",
    payload: { chatId: "cht_abc", messageId: "msg_abc", delta: "hello" },
  },
  "artifact.created": {
    type: "artifact.created",
    payload: { path: "library/a.txt", name: "a.txt", mime: "text/plain", size: 10, createdAt: now },
  },
  "library.changed": {
    type: "library.changed",
    payload: { workspaceId: "wks_abc", path: "library/a.txt", op: "added" },
  },
  "message.updated": {
    type: "message.updated",
    payload: {
      id: "msg_abc",
      chatId: "cht_abc",
      role: "agent",
      content: { type: "text", text: "hi" },
      createdAt: now,
      state: "running",
      startedAt: now,
      kind: "chat",
    },
  },
  "message.log_appended": {
    type: "message.log_appended",
    payload: { messageId: "msg_abc", kind: "stdout", line: "hello from opencode" },
  },
};

describe("WsEvent round-trip", () => {
  for (const [eventType, fixture] of Object.entries(fixtures)) {
    it(`${eventType}: serialize → parse round-trips`, () => {
      const serialized = serializeWsEvent(fixture);
      const parsed = parseWsEvent(serialized);
      expect(parsed).toEqual(fixture);
    });
  }
});

describe("parseWsEvent error handling", () => {
  it("throws on invalid JSON", () => {
    expect(() => parseWsEvent("not json")).toThrow();
  });

  it("throws on unknown event type", () => {
    expect(() => parseWsEvent(JSON.stringify({ type: "unknown.event", payload: {} }))).toThrow();
  });
});
