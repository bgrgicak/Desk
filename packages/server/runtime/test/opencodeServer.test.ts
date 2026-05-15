import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { _registerAuthBlobsForTest as registerAuthBlobs } from "../src/opencodeServer.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

describe("registerAuthBlobs", () => {
  let realFetch: typeof globalThis.fetch;
  let calls: RecordedCall[];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = (async (input: unknown, init: RequestInit | undefined) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k] = String(v);
      const rawBody = init?.body;
      const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
      calls.push({ url, method: init?.method ?? "GET", headers, body });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("PUTs each oauth provider in the blob to /auth/<id> with Basic auth", async () => {
    const blob = JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "REFRESH_TOKEN",
        access: "ACCESS_TOKEN",
        expires: 1234567890,
        accountId: "acct_x",
      },
    });
    await registerAuthBlobs("http://daemon", "pw", blob);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://daemon/auth/openai");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].headers.Authorization).toBe(
      `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
    );
    expect(calls[0].body).toEqual({
      type: "oauth",
      refresh: "REFRESH_TOKEN",
      access: "ACCESS_TOKEN",
      expires: 1234567890,
      accountId: "acct_x",
    });
  });

  it("registers multiple providers in a single blob", async () => {
    const blob = JSON.stringify({
      openai: { type: "oauth", refresh: "r", access: "a", expires: 1 },
      anthropic: { type: "api", key: "K" },
    });
    await registerAuthBlobs("http://daemon", "pw", blob);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "http://daemon/auth/anthropic",
      "http://daemon/auth/openai",
    ]);
  });

  it("skips entries whose type is unknown", async () => {
    const blob = JSON.stringify({
      bogus: { type: "magic", value: 1 },
      openai: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    });
    await registerAuthBlobs("http://daemon", "pw", blob);
    expect(calls.map((c) => c.url)).toEqual(["http://daemon/auth/openai"]);
  });

  it("skips entries that aren't objects", async () => {
    const blob = JSON.stringify({
      openai: "should-be-object",
      anthropic: { type: "api", key: "K" },
    });
    await registerAuthBlobs("http://daemon", "pw", blob);
    expect(calls.map((c) => c.url)).toEqual(["http://daemon/auth/anthropic"]);
  });

  it("throws when the blob isn't valid JSON", async () => {
    await expect(registerAuthBlobs("http://daemon", "pw", "not-json{{")).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("throws when the blob is JSON but not an object", async () => {
    await expect(registerAuthBlobs("http://daemon", "pw", '"a-string"')).rejects.toThrow(
      /does not decode to an object/,
    );
  });

  it("tolerates non-2xx PUT responses without throwing (warns and continues)", async () => {
    globalThis.fetch = (async () => {
      return new Response("denied", { status: 401 });
    }) as typeof globalThis.fetch;
    const blob = JSON.stringify({ openai: { type: "oauth", refresh: "r", access: "a", expires: 1 } });
    await expect(registerAuthBlobs("http://daemon", "pw", blob)).resolves.toBeUndefined();
  });
});
