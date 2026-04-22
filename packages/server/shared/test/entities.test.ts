import { describe, it, expect } from "vitest";
import {
  UserSchema,
  AgentSchema,
  WorkspaceSchema,
  ChatSchema,
  MessageSchema,
  FileSchema,
  RunSchema,
  ScheduledJobSchema,
  NoteSchema,
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
    toolAllowlist: ["file.read"],
  };

  it("parses a valid agent", () => {
    expect(AgentSchema.parse(valid)).toEqual(valid);
  });

  it("rejects missing name", () => {
    expect(() => AgentSchema.parse({ id: "agt_abc", userId: "usr_abc", instructions: "x", model: "m", toolAllowlist: [] })).toThrow();
  });

  it("rejects missing userId (M3 invariant)", () => {
    expect(() => AgentSchema.parse({ id: "agt_abc", name: "n", instructions: "x", model: "m", toolAllowlist: [] })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(AgentSchema, valid)).toEqual(valid);
  });
});

describe("WorkspaceSchema", () => {
  const valid = { id: "wks_abc", userId: "usr_abc", name: "My WS", description: "desc", icon: "star", createdAt: now };

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
  const base = { id: "msg_abc", chatId: "cht_abc", createdAt: now };

  it("parses text content", () => {
    const msg = { ...base, role: "user", content: { type: "text", text: "hello" } };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("parses toolCall content", () => {
    const msg = { ...base, role: "agent", content: { type: "toolCall", toolName: "file.read", args: { fileId: "f1" } } };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  it("parses toolResult content", () => {
    const msg = { ...base, role: "tool", content: { type: "toolResult", toolName: "file.read", result: { content: "data" } } };
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

describe("RunSchema", () => {
  const valid = { id: "run_abc", kind: "immediate", state: "pending" };

  it("parses a minimal run", () => {
    expect(RunSchema.parse(valid)).toEqual(valid);
  });

  it("parses a full run", () => {
    const full = { ...valid, chatId: "cht_abc", scheduledJobId: "job_abc", state: "succeeded", startedAt: now, finishedAt: now, exitCode: 0, logPath: "/logs/r.log" };
    expect(RunSchema.parse(full)).toEqual(full);
  });

  it("rejects invalid state", () => {
    expect(() => RunSchema.parse({ id: "run_abc", kind: "immediate", state: "paused" })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(RunSchema, valid)).toEqual(valid);
  });
});

describe("ScheduledJobSchema", () => {
  const base = { id: "job_abc", kind: "once", active: true };

  it("parses once spec", () => {
    const job = { ...base, spec: { type: "once", onceAt: now } };
    expect(ScheduledJobSchema.parse(job)).toEqual(job);
  });

  it("parses recurring spec", () => {
    const job = { ...base, kind: "recurring", spec: { type: "recurring", cronExpr: "0 * * * *" } };
    expect(ScheduledJobSchema.parse(job)).toEqual(job);
  });

  it("parses ai_note spec", () => {
    const job = { ...base, kind: "ai_note", spec: { type: "ai_note", aiNoteDelayMs: 5000 } };
    expect(ScheduledJobSchema.parse(job)).toEqual(job);
  });

  it("rejects negative aiNoteDelayMs", () => {
    expect(() => ScheduledJobSchema.parse({ ...base, kind: "ai_note", spec: { type: "ai_note", aiNoteDelayMs: -1 } })).toThrow();
  });

  it("accepts optional fields", () => {
    const job = { ...base, spec: { type: "once", onceAt: now }, chatId: "cht_abc", atJobId: "42", crontabId: "c1", nextRunAt: now };
    expect(ScheduledJobSchema.parse(job)).toMatchObject({ chatId: "cht_abc" });
  });

  it("round-trips through JSON", () => {
    const job = { ...base, spec: { type: "once", onceAt: now } };
    expect(roundTrip(ScheduledJobSchema, job)).toEqual(job);
  });
});

describe("NoteSchema", () => {
  const valid = { id: "note_abc", fileId: "fil_abc", chatId: "cht_abc", createdAt: now, summary: "A note" };

  it("parses a valid note", () => {
    expect(NoteSchema.parse(valid)).toEqual(valid);
  });

  it("rejects missing summary", () => {
    expect(() => NoteSchema.parse({ id: "note_abc", fileId: "fil_abc", chatId: "cht_abc", createdAt: now })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(NoteSchema, valid)).toEqual(valid);
  });
});
