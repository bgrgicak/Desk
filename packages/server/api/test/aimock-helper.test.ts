/**
 * Smoke test for the aimock helper. Boots the mock, drives it from the
 * test process with a real `fetch` (the same shape pi would make from
 * inside the sandbox), and asserts the canned "DONE" reply comes back.
 *
 * The intent is to keep the helper honest as aimock's API evolves —
 * if the package renames `onMessage` or changes its response shape,
 * this test catches it before any real test depends on it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAimock, type AimockHandle } from "./helpers/aimock.js";

let handle: AimockHandle;

beforeAll(async () => {
  handle = await startAimock({ done: "DONE" });
});

afterAll(async () => {
  await handle?.stop();
});

describe("aimock helper", () => {
  it("serves canned 'DONE' reply on the OpenAI Chat Completions surface", async () => {
    const res = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mock" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "anything" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("DONE");
  });

  it("serves canned 'DONE' reply on the Anthropic Messages surface", async () => {
    const res = await fetch(`${handle.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "mock",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "anything" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string; text: string }> };
    const text = body.content.find((b) => b.type === "text")?.text;
    expect(text).toBe("DONE");
  });
});
