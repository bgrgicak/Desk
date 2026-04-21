import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getInstanceUrl, pollEndpoint, VM_SH } from "./helpers.js";

const INSTANCE = "test-dev-override";
const URL = getInstanceUrl(INSTANCE);
// Path to the tiny scratch file that holds the health-check literal. The test
// mutates this file to prove tsx-watch reload works; if the test crashes mid-run,
// only this throwaway scratch is left in a bad state (not app.ts). Restoration
// happens in afterAll.
// Path is from packages/server/setup/test/e2e/ → ../../../api/src/health-message.ts.
const INDEX_PATH = resolve(
  import.meta.dirname,
  "../../../api/src/health-message.ts",
);

const vm = (subcmd: string) =>
  execSync(`${VM_SH} ${subcmd}`, {
    env: { ...process.env, DESK_INSTANCE: INSTANCE },
    stdio: "inherit",
    timeout: 600_000,
  });

const vmExec = (cmd: string) =>
  execSync(`${VM_SH} exec ${JSON.stringify(cmd)}`, {
    env: { ...process.env, DESK_INSTANCE: INSTANCE },
    stdio: "inherit",
    timeout: 60_000,
  });

let originalSource: string | undefined;

const RUN = process.env.RUN_VM_TESTS === "1";
describe.skipIf(!RUN)("dev-override", () => {
  beforeAll(() => {
    originalSource = readFileSync(INDEX_PATH, "utf-8");
    try { vm("destroy"); } catch { /* ignore */ }
    vm("up");
  }, 900_000);

  afterAll(() => {
    if (originalSource !== undefined) {
      writeFileSync(INDEX_PATH, originalSource);
    }
    try {
      vmExec(
        "sudo rm -f /etc/systemd/system/desk-server.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart desk-server",
      );
    } catch { /* VM may already be gone */ }
    try { vm("destroy"); } catch { /* ignore */ }
  }, 120_000);

  it("switches to dev mode and picks up source changes", async () => {
    // Install the checked-in override template (same file dev-override.sh uses)
    // so test and helper never drift.
    vmExec(
      "sudo mkdir -p /etc/systemd/system/desk-server.service.d && " +
      "sudo install -m 644 /desk/packages/server/setup/dev-override.conf " +
      "/etc/systemd/system/desk-server.service.d/override.conf && " +
      "sudo systemctl daemon-reload && sudo systemctl restart desk-server",
    );

    await pollEndpoint(URL, "hello world", 60_000);

    const modified = originalSource!.replace('"hello world"', '"hello dev"');
    writeFileSync(INDEX_PATH, modified);

    const body = await pollEndpoint(URL, "hello dev", 60_000);
    expect(body).toBe("hello dev");
  }, 180_000);

  it("reverts back to prod after removing override", async () => {
    writeFileSync(INDEX_PATH, originalSource!);

    vmExec(
      "sudo rm -f /etc/systemd/system/desk-server.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart desk-server",
    );

    const body = await pollEndpoint(URL, "hello world", 60_000);
    expect(body).toBe("hello world");
  }, 120_000);
});
