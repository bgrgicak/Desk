import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { UnauthorizedError } from "@desk/shared";
import { issueSessionToken, revokeSession, authenticate } from "../src/auth.js";
import {
  setupTestTools,
  teardownTestTools,
  type TestToolContext,
} from "./helpers/toolServer.js";

let ctx: TestToolContext;

beforeAll(async () => {
  ctx = await setupTestTools();
});

afterAll(async () => {
  await teardownTestTools(ctx);
});

describe("auth", () => {
  it("issue → authenticate succeeds", async () => {
    const { token, session } = await issueSessionToken(ctx.pool, ctx.agentId);
    const result = await authenticate(ctx.pool, token);
    expect(result.session.id).toBe(session.id);
    expect(result.agent.id).toBe(ctx.agentId);
  });

  it("revoke → authenticate fails", async () => {
    const { token, session } = await issueSessionToken(ctx.pool, ctx.agentId);
    await revokeSession(ctx.pool, session.id);
    await expect(authenticate(ctx.pool, token)).rejects.toThrow(UnauthorizedError);
  });

  it("unknown token → fails", async () => {
    await expect(authenticate(ctx.pool, "tok_unknown123")).rejects.toThrow(UnauthorizedError);
  });

  it("missing header → fails", async () => {
    await expect(authenticate(ctx.pool, undefined)).rejects.toThrow(UnauthorizedError);
  });
});
