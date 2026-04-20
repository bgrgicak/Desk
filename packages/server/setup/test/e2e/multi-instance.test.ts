import { describe, it, expect, afterAll } from "vitest";
import { exec, execSync } from "node:child_process";
import {
  getInstanceUrl,
  getPortForInstance,
  pollEndpoint,
  VM_SH,
} from "./helpers.js";

const INSTANCE_A = "test-multi-a";
const INSTANCE_B = "test-multi-b";

const vmSync = (subcmd: string, instance: string) =>
  execSync(`${VM_SH} ${subcmd}`, {
    env: { ...process.env, DESK_INSTANCE: instance },
    stdio: "inherit",
    timeout: 600_000,
  });

function vmAsync(subcmd: string, instance: string): Promise<void> {
  return new Promise((res, rej) => {
    exec(`${VM_SH} ${subcmd}`, {
      env: { ...process.env, DESK_INSTANCE: instance },
      timeout: 900_000,
    }, (err) => (err ? rej(err) : res()));
  });
}

const RUN = process.env.RUN_VM_TESTS === "1";
describe.skipIf(!RUN)("multi-instance", () => {
  afterAll(() => {
    for (const i of [INSTANCE_A, INSTANCE_B]) {
      try { vmSync("destroy", i); } catch { /* ignore */ }
    }
  }, 120_000);

  it("runs two instances on distinct host ports simultaneously", async () => {
    await Promise.all([
      (async () => { try { await vmAsync("destroy", INSTANCE_A); } catch {} ; await vmAsync("up", INSTANCE_A); })(),
      (async () => { try { await vmAsync("destroy", INSTANCE_B); } catch {} ; await vmAsync("up", INSTANCE_B); })(),
    ]);

    const portA = getPortForInstance(INSTANCE_A);
    const portB = getPortForInstance(INSTANCE_B);
    expect(portA).not.toBe(portB);

    const [bodyA, bodyB] = await Promise.all([
      pollEndpoint(getInstanceUrl(INSTANCE_A), "hello world", 60_000),
      pollEndpoint(getInstanceUrl(INSTANCE_B), "hello world", 60_000),
    ]);

    expect(bodyA).toBe("hello world");
    expect(bodyB).toBe("hello world");
  }, 900_000);
});
