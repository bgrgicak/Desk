import { describe, it, expect } from "vitest";
import { translateOpencodeSseEvent, readOpencodeSseEvents } from "../src/opencodeEvents.js";

const SES = "ses_test_abcd1234";

describe("translateOpencodeSseEvent", () => {
  it("translates a text part-updated event into run-format JSON", () => {
    const out = translateOpencodeSseEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SES,
          part: { type: "text", text: "hello", id: "prt_x" },
        },
      },
      { sessionID: SES },
    );
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.type).toBe("text");
    expect(parsed.sessionID).toBe(SES);
    expect(parsed.part).toEqual({ type: "text", text: "hello", id: "prt_x" });
  });

  it("hyphen-to-underscore for step-start and step-finish", () => {
    const a = translateOpencodeSseEvent(
      {
        type: "message.part.updated",
        properties: { sessionID: SES, part: { type: "step-start", id: "p1" } },
      },
      { sessionID: SES },
    );
    const b = translateOpencodeSseEvent(
      {
        type: "message.part.updated",
        properties: { sessionID: SES, part: { type: "step-finish", id: "p2" } },
      },
      { sessionID: SES },
    );
    expect(JSON.parse(a!).type).toBe("step_start");
    expect(JSON.parse(b!).type).toBe("step_finish");
  });

  it("passes through reasoning and tool part types", () => {
    const r = translateOpencodeSseEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SES,
          part: { type: "reasoning", text: "thinking..." },
        },
      },
      { sessionID: SES },
    );
    const t = translateOpencodeSseEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SES,
          part: { type: "tool", state: { status: "running" } },
        },
      },
      { sessionID: SES },
    );
    expect(JSON.parse(r!).type).toBe("reasoning");
    expect(JSON.parse(t!).type).toBe("tool");
  });

  it("drops events from other sessions", () => {
    const out = translateOpencodeSseEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_someone_else",
          part: { type: "text", text: "leak" },
        },
      },
      { sessionID: SES },
    );
    expect(out).toBeNull();
  });

  it("translates message.part.delta into a per-chunk text event", () => {
    const out = translateOpencodeSseEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: SES,
          messageID: "msg_1",
          partID: "prt_1",
          field: "text",
          delta: "Hello, ",
        },
      },
      { sessionID: SES },
    );
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.type).toBe("text");
    expect(parsed.sessionID).toBe(SES);
    expect(parsed.part).toEqual({
      type: "text",
      text: "Hello, ",
      id: "prt_1",
      messageID: "msg_1",
    });
  });

  it("handles message.part.delta for non-text fields (reasoning, etc.)", () => {
    const out = translateOpencodeSseEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: SES,
          partID: "prt_r1",
          field: "reasoning",
          delta: "thinking step",
        },
      },
      { sessionID: SES },
    );
    const parsed = JSON.parse(out!);
    expect(parsed.type).toBe("reasoning");
    expect((parsed.part as { text: string }).text).toBe("thinking step");
  });

  it("drops events that aren't part updates or deltas (busy, server.connected, session.*)", () => {
    const cases: { type: string; properties?: Record<string, unknown> }[] = [
      { type: "server.connected", properties: {} },
      { type: "busy", properties: {} },
      { type: "idle", properties: {} },
      { type: "session.idle", properties: { sessionID: SES } },
      { type: "session.updated", properties: { sessionID: SES, info: {} } },
      { type: "message.updated", properties: { sessionID: SES, info: {} } },
      { type: "file.watcher.updated", properties: {} },
    ];
    for (const c of cases) {
      expect(translateOpencodeSseEvent(c, { sessionID: SES }), `dropped ${c.type}`).toBeNull();
    }
  });

  it("drops malformed events (missing part, missing sessionID, missing part.type)", () => {
    expect(
      translateOpencodeSseEvent({ type: "message.part.updated", properties: {} }, { sessionID: SES }),
    ).toBeNull();
    expect(
      translateOpencodeSseEvent(
        { type: "message.part.updated", properties: { sessionID: SES } },
        { sessionID: SES },
      ),
    ).toBeNull();
    expect(
      translateOpencodeSseEvent(
        { type: "message.part.updated", properties: { sessionID: SES, part: {} } },
        { sessionID: SES },
      ),
    ).toBeNull();
  });
});

describe("readOpencodeSseEvents", () => {
  function streamOf(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  it("parses a single event frame", async () => {
    const body = streamOf('data: {"id":"e1","type":"server.connected","properties":{}}\n\n');
    const events = [];
    for await (const e of readOpencodeSseEvents(body)) events.push(e);
    expect(events).toEqual([
      { id: "e1", type: "server.connected", properties: {} },
    ]);
  });

  it("parses multiple events split across chunk boundaries", async () => {
    // The interesting case: a frame's terminating \n\n is split across two
    // chunks. The reader must accumulate, not lose the boundary.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"a","properties":{}}\n'),
        );
        controller.enqueue(
          encoder.encode('\ndata: {"type":"b","properties":{}}\n\n'),
        );
        controller.close();
      },
    });
    const events = [];
    for await (const e of readOpencodeSseEvents(body)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("skips malformed JSON without killing the stream", async () => {
    const text =
      'data: {"type":"a","properties":{}}\n\n' +
      "data: not-json{{\n\n" +
      'data: {"type":"b","properties":{}}\n\n';
    const body = streamOf(text);
    const errs: string[] = [];
    const events = [];
    for await (const e of readOpencodeSseEvents(body, {
      onParseError: (raw) => errs.push(raw),
    })) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
    expect(errs).toEqual(["not-json{{"]);
  });

  it("ignores frames with no data: field", async () => {
    const text =
      ":keep-alive comment line\n\n" +
      'data: {"type":"a","properties":{}}\n\n';
    const body = streamOf(text);
    const events = [];
    for await (const e of readOpencodeSseEvents(body)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["a"]);
  });
});
