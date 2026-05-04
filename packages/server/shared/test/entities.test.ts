import { describe, it, expect } from "vitest";
import {
  UserSchema,
  AgentSchema,
  WorkspaceSchema,
  ChatSchema,
  MessageSchema,
  FileSchema,
} from "../src/index.js";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, data: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(data)));
}

const now = new Date().toISOString();

describe("UserSchema", () => {
  const valid = { id: "usr_abc", username: "alice", email: "a@b.com", createdAt: now };

  it("parses a valid user", () => {
    expect(UserSchema.parse(valid)).toEqual(valid);
  });

  it("accepts optional avatarPath", () => {
    expect(UserSchema.parse({ ...valid, avatarPath: "/img.png" })).toMatchObject({ avatarPath: "/img.png" });
  });

  it("rejects missing email", () => {
    expect(() => UserSchema.parse({ id: "usr_abc", username: "alice", createdAt: now })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(UserSchema, valid)).toEqual(valid);
  });
});

describe("AgentSchema", () => {
  const valid = {
    id: "agt_abc",
    userId: "usr_abc",
    name: "Helper",
    instructions: "Be helpful",
    model: "gpt-4",
  };

  it("parses a valid agent", () => {
    expect(AgentSchema.parse(valid)).toEqual(valid);
  });

  it("rejects missing name", () => {
    expect(() => AgentSchema.parse({ id: "agt_abc", userId: "usr_abc", instructions: "x", model: "m" })).toThrow();
  });

  it("rejects missing userId (M3 invariant)", () => {
    expect(() => AgentSchema.parse({ id: "agt_abc", name: "n", instructions: "x", model: "m" })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(AgentSchema, valid)).toEqual(valid);
  });
});

describe("WorkspaceSchema", () => {
  const valid = { id: "wks_abc", userId: "usr_abc", name: "My WS", description: "desc", icon: "star", color: "#fce7f3", path: "my-ws", createdAt: now };

  it("parses a valid workspace", () => {
    expect(WorkspaceSchema.parse(valid)).toEqual(valid);
  });

  it("rejects missing userId", () => {
    expect(() => WorkspaceSchema.parse({ id: "wks_abc", name: "n", description: "d", icon: "i", createdAt: now })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(WorkspaceSchema, valid)).toEqual(valid);
  });
});

describe("ChatSchema", () => {
  const valid = { id: "cht_abc", workspaceId: "wks_abc", agentId: "agt_abc", title: "Chat 1", updatedAt: now, awaitingUser: false, unread: true };

  it("parses a valid chat", () => {
    expect(ChatSchema.parse(valid)).toEqual(valid);
  });

  it("accepts optional goal", () => {
    expect(ChatSchema.parse({ ...valid, goal: "Do stuff" })).toMatchObject({ goal: "Do stuff" });
  });

  it("rejects wrong awaitingUser type", () => {
    expect(() => ChatSchema.parse({ ...valid, awaitingUser: "yes" })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(ChatSchema, valid)).toEqual(valid);
  });
});

describe("MessageSchema", () => {
  const base = { id: "msg_abc", chatId: "cht_abc", createdAt: now, kind: "chat" as const };

  it("parses text content", () => {
    const msg = { ...base, role: "user", content: { type: "text", text: "hello" } };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("parses toolCall content", () => {
    const msg = { ...base, role: "agent", content: { type: "toolCall", toolName: "file.read", args: { fileId: "f1" } } };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("parses toolResult content", () => {
    const msg = { ...base, role: "agent", content: { type: "toolResult", toolName: "file.read", result: { content: "data" } } };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("parses artifactRef content", () => {
    const msg = { ...base, role: "system", content: { type: "artifactRef", path: "library/report.md", name: "report.md" } };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects unknown content type", () => {
    expect(() => MessageSchema.parse({ ...base, role: "user", content: { type: "image", url: "x" } })).toThrow();
  });

  it("rejects invalid role", () => {
    expect(() => MessageSchema.parse({ ...base, role: "admin", content: { type: "text", text: "hi" } })).toThrow();
  });

  it("round-trips through JSON", () => {
    const msg = { ...base, role: "user", content: { type: "text", text: "hello" } };
    expect(roundTrip(MessageSchema, msg)).toEqual(msg);
  });
});

describe("FileSchema (FS-backed FileRef)", () => {
  const valid = { path: "library/a.txt", name: "a.txt", mime: "text/plain", size: 100, createdAt: now };

  it("parses a valid file ref", () => {
    expect(FileSchema.parse(valid)).toEqual(valid);
  });

  it("rejects negative size", () => {
    expect(() => FileSchema.parse({ ...valid, size: -1 })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(FileSchema, valid)).toEqual(valid);
  });
});

describe("MessageSchema execution metadata", () => {
  const base = { id: "msg_abc", chatId: "cht_abc", role: "system", content: { type: "summary_request" }, createdAt: now, kind: "chat" as const };

  it("accepts state + executeAt + schedulerRef", () => {
    const msg = {
      ...base,
      state: "pending",
      executeAt: now,
      schedulerRef: { kind: "at", id: "42" },
    };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts cron + parentId + agentId + timing fields", () => {
    const msg = {
      ...base,
      cron: "0 9 * * *",
      parentId: "msg_parent",
      agentId: "agt_abc",
      startedAt: now,
      endedAt: now,
      updatedAt: now,
    };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects invalid state", () => {
    expect(() =>
      MessageSchema.parse({ ...base, state: "bogus" }),
    ).toThrow();
  });

  it("rejects invalid schedulerRef kind", () => {
    expect(() =>
      MessageSchema.parse({ ...base, schedulerRef: { kind: "bogus", id: "x" } }),
    ).toThrow();
  });

  it("accepts attachments on the envelope", () => {
    const msg = {
      ...base,
      role: "user",
      content: { type: "text", text: "see attached" },
      attachments: [
        { path: ".chats/cht_abc/attachments/spec.md", name: "spec.md", mime: "text/markdown", size: 1234 },
        { path: ".chats/cht_abc/attachments/photo.png", name: "photo.png" },
      ],
    };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects attachments with negative size", () => {
    expect(() =>
      MessageSchema.parse({
        ...base,
        attachments: [{ path: "a", name: "a", size: -1 }],
      }),
    ).toThrow();
  });

  it("accepts a model label on the envelope", () => {
    const msg = {
      ...base,
      role: "agent",
      content: { type: "text", text: "hello" },
      model: "anthropic/claude-sonnet-4-5",
    };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });
});

describe("MessageContent summary / summary_request", () => {
  const base = { id: "msg_abc", chatId: "cht_abc", createdAt: now, kind: "chat" as const };

  it("parses summary content", () => {
    const msg = { ...base, role: "agent", content: { type: "summary", body: "Running summary of the chat." } };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("parses summary_request content", () => {
    const msg = { ...base, role: "system", content: { type: "summary_request" } };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects a summary with non-string body", () => {
    expect(() =>
      MessageSchema.parse({ ...base, role: "agent", content: { type: "summary", body: 123 } }),
    ).toThrow();
  });
});
