import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getDeskHomeForInstance, VM_SH } from "./helpers.js";

const INSTANCE = `test-${randomUUID().slice(0, 8)}`;
const HOST_DESK = getDeskHomeForInstance(INSTANCE);

const vm = (subcmd: string) =>
  execSync(`${VM_SH} ${subcmd}`, {
    env: { ...process.env, DESK_INSTANCE: INSTANCE },
    stdio: "inherit",
    timeout: 600_000,
  });

const vmCapture = (subcmd: string) =>
  execSync(`${VM_SH} ${subcmd}`, {
    env: { ...process.env, DESK_INSTANCE: INSTANCE },
    encoding: "utf8",
    timeout: 60_000,
  });

const RUN = process.env.RUN_VM_TESTS === "1";
describe.skipIf(!RUN)("host mount", () => {
  beforeAll(() => {
    try { vm("destroy"); } catch { /* ignore */ }
    if (existsSync(HOST_DESK)) rmSync(HOST_DESK, { recursive: true, force: true });
    vm("up");
  }, 900_000);

  afterAll(() => {
    try { vm("destroy"); } catch { /* ignore */ }
    if (existsSync(HOST_DESK)) rmSync(HOST_DESK, { recursive: true, force: true });
  }, 120_000);

  it("host writes are visible inside the VM at /home/desk/Desk", () => {
    const marker = `host-${randomUUID()}.txt`;
    const payload = `from-host-${randomUUID()}`;

    mkdirSync(HOST_DESK, { recursive: true });
    writeFileSync(join(HOST_DESK, marker), payload);

    const out = vmCapture(`exec "cat /home/desk/Desk/${marker}"`).trim();
    expect(out).toBe(payload);
  }, 30_000);

  it("VM writes are visible on the host at the mounted Desk dir", () => {
    const marker = `vm-${randomUUID()}.txt`;
    const payload = `from-vm-${randomUUID()}`;

    // Use sudo+tee so the desk user (uid 2000) can write through the mount;
    // the bind point is owned by the host user, so a plain `>` redirect from
    // a non-root shell may EACCES depending on virtiofs uid mapping.
    vm(`exec "echo -n '${payload}' | sudo tee /home/desk/Desk/${marker} >/dev/null"`);

    const got = readFileSync(join(HOST_DESK, marker), "utf8");
    expect(got).toBe(payload);
  }, 30_000);

  it("survives vm:reset — host data persists across VM destroy+recreate", () => {
    const marker = `survives-${randomUUID()}.txt`;
    const payload = `persists-${randomUUID()}`;

    mkdirSync(HOST_DESK, { recursive: true });
    writeFileSync(join(HOST_DESK, marker), payload);

    vm("reset");

    expect(existsSync(join(HOST_DESK, marker))).toBe(true);
    expect(readFileSync(join(HOST_DESK, marker), "utf8")).toBe(payload);

    const out = vmCapture(`exec "cat /home/desk/Desk/${marker}"`).trim();
    expect(out).toBe(payload);
  }, 900_000);
});
