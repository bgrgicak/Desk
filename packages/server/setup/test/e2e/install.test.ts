import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getInstanceUrl, pollEndpoint, VM_SH } from "./helpers.js";

const INSTANCE = `test-${randomUUID().slice(0, 8)}`;
const URL = getInstanceUrl(INSTANCE);

const vm = (subcmd: string) =>
  execSync(`${VM_SH} ${subcmd}`, {
    env: { ...process.env, DESK_INSTANCE: INSTANCE },
    stdio: "inherit",
    timeout: 600_000,
  });

const RUN = process.env.RUN_VM_TESTS === "1";
describe.skipIf(!RUN)("install", () => {
  beforeAll(() => {
    try { vm("destroy"); } catch { /* ignore */ }
    vm("up");
  }, 900_000);

  afterAll(() => {
    try { vm("destroy"); } catch { /* ignore */ }
  }, 120_000);

  it("responds with hello world after fresh install", async () => {
    const body = await pollEndpoint(URL, "hello world", 60_000);
    expect(body).toBe("hello world");
  }, 120_000);

  it("is idempotent — second provision succeeds", () => {
    vm("provision");
  }, 600_000);

  it("still responds with hello world after re-provision", async () => {
    const body = await pollEndpoint(URL, "hello world", 30_000);
    expect(body).toBe("hello world");
  }, 60_000);
});
