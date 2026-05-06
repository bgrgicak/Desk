/**
 * Integration tests for the sandbox lifecycle.
 *
 * Requires a working container engine (docker or nerdctl) and the
 * `desk/sandbox:v1` image present locally — auto-detected and skipped
 * otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureLayout,
  ensureWorkspaceLayout,
  workspaceRootPath,
} from "@agent-desk/storage";
import {
  createOrReuse,
  stopSandbox,
  ensureImage,
  sandboxImage,
} from "../../src/docker.js";
import { execInSandbox } from "../../src/sandboxExec.js";
import { projectMounts, teardownMounts, SANDBOX_HOME } from "../../src/mounts.js";
import { detectEngine, type Engine } from "../../src/engine.js";
import { rmTempTree } from "./helpers.js";

let engineForSetup: Engine | null = null;
let SKIP = false;
try {
  engineForSetup = await detectEngine();
  const haveImage = (await engineForSetup.imageId(sandboxImage())) !== null;
  if (!haveImage) SKIP = true;
} catch {
  SKIP = true;
}
const describeIf = SKIP ? describe.skip : describe;

let home: string;
const testWorkspaceId = "wks_int_sandbox_test";
const testWorkspaceSlug = "int-sandbox-test";
const containerName = `desk-sandbox-${testWorkspaceId}`;

beforeAll(async () => {
  if (SKIP) return;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-int-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, testWorkspaceSlug);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  if (engineForSetup) {
    await engineForSetup.remove(containerName, true).catch(() => {});
  }
  await rmTempTree(home);
});

describeIf("sandbox integration", () => {
  it("ensureImage does not throw", async () => {
    await ensureImage();
  });

  it("createOrReuse creates a container and returns a handle", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    expect(handle.workspaceId).toBe(testWorkspaceId);
    expect(handle.containerId).toBeTruthy();

    const engine = await detectEngine();
    const info = await engine.inspect(handle.containerId);
    expect(info?.labels["agent-desk.sandbox-resource-profile"]).toBe(
      "pids=1024,memory=4g,tmpfs=/tmp:size=1g",
    );
  });

  it("createOrReuse is idempotent — second call returns same container", async () => {
    const h1 = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const h2 = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    expect(h1.containerId).toBe(h2.containerId);
  });

  it("createOrReuse rebuilds a container whose binds drifted from the current plan", async () => {
    const first = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);

    // Force drift by passing an extra bind the existing container doesn't
    // have. Without the drift check, createOrReuse would hand back the old
    // container and the new bind would silently go missing.
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), "desk-drift-"));
    try {
      const plan = [
        {
          sourcePath: workspaceRootPath(home, testWorkspaceSlug),
          targetPath: SANDBOX_HOME,
          mode: "rw" as const,
          category: "workspace" as const,
        },
        {
          sourcePath: extra,
          targetPath: "/mnt/extra",
          mode: "ro" as const,
          category: "external" as const,
        },
      ];
      const second = await createOrReuse(
        testWorkspaceId, testWorkspaceSlug, home, undefined, plan,
      );
      expect(second.containerId).not.toBe(first.containerId);

      const engine = await detectEngine();
      const info = await engine.inspect(second.containerId);
      expect(info?.binds ?? []).toContain(`${extra}:/mnt/extra:ro`);
    } finally {
      await fs.rm(extra, { recursive: true, force: true });
    }
  });

  it("projectMounts resolves the workspace root that gets bind-mounted at $HOME", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const mounts = await projectMounts(handle, {
      home,
      workspaceId: "wks_int_test",
      workspaceSlug: testWorkspaceSlug,
      runId: "run_int_1",
    });

    expect(mounts.workspace).toBe(workspaceRootPath(home, testWorkspaceSlug));

    const stat = await fs.stat(mounts.workspace);
    expect(stat.isDirectory()).toBe(true);

    expect(SANDBOX_HOME).toBe("/home/agent");

    await teardownMounts(handle, "run_int_1");
  });

  it("runs a no-op command inside the sandbox", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();
    const h = await engine.exec({
      containerId: handle.containerId,
      cmd: ["echo", "hello from sandbox"],
    });
    const chunks: Buffer[] = [];
    h.stdout.on("data", (c: Buffer) => chunks.push(c));
    await h.wait();
    expect(Buffer.concat(chunks).toString("utf8")).toContain("hello from sandbox");
  });

  it("forwards provider API keys from host env to the sandbox", async () => {
    // Pick a sentinel from the forwarded set that opencode recognises
    // (see PROVIDER_KEY_VARS in @agent-desk/shared).
    const envKey = "OPENAI_API_KEY";
    const secret = "sk-desk-env-forwarding-test-123";
    const prev = process.env[envKey];
    process.env[envKey] = secret;

    // Force recreation of this test's container so it picks up the new env.
    const engine = await detectEngine();
    await engine.remove(containerName, true).catch(() => {});

    try {
      const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
      const h = await engine.exec({
        containerId: handle.containerId,
        cmd: ["sh", "-c", `echo "$${envKey}"`],
      });
      const chunks: Buffer[] = [];
      h.stdout.on("data", (c: Buffer) => chunks.push(c));
      await h.wait();
      expect(Buffer.concat(chunks).toString("utf8")).toContain(secret);
    } finally {
      if (prev === undefined) delete process.env[envKey];
      else process.env[envKey] = prev;
    }
  });

  it("execInSandbox refreshes provider keys on a reused container", async () => {
    // Regression: a sandbox first created without keys (or with stale keys)
    // used to keep that env until tear-down, so opencode would hit
    // Anthropic with an empty/old token even after the user saved a new
    // one. The fix injects providerKeys at each exec; this test pins that
    // behaviour.
    const envKey = "ANTHROPIC_API_KEY";
    const stale = "sk-stale-original";
    const fresh = "sk-fresh-rotated";

    const engine = await detectEngine();
    await engine.remove(containerName, true).catch(() => {});

    await createOrReuse(testWorkspaceId, testWorkspaceSlug, home, { [envKey]: stale });

    const result = await execInSandbox(testWorkspaceId, testWorkspaceSlug, {
      argv: ["sh", "-c", `echo "$${envKey}"`],
      providerKeys: { [envKey]: fresh },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(fresh);
    expect(result.stdout).not.toContain(stale);
  });

  it("ships browser automation tooling and a working display", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();

    const htmlPath = "/tmp/desk-playwright-smoke.html";
    const screenshotPath = "/tmp/desk-playwright-smoke.png";
    const h = await engine.exec({
      containerId: handle.containerId,
      cmd: [
        "sh",
        "-lc",
        [
          "set -eu",
          "test \"$DISPLAY\" = ':99'",
          "playwright --version",
          "playwright-mcp --version >/dev/null",
          "node -e \"const mcp=require('/usr/local/lib/node_modules/@playwright/mcp/package.json'); const pw=require('/usr/local/lib/node_modules/playwright/package.json'); if (mcp.dependencies.playwright !== pw.version) throw new Error(`playwright mismatch ${mcp.dependencies.playwright} !== ${pw.version}`);\"",
          "test -S /tmp/.X11-unix/X99",
          `printf '%s' '<!doctype html><title>Desk Browser Smoke</title><main>Firefox works</main>' > ${htmlPath}`,
          `node - <<'NODE'
const { firefox } = require('/usr/local/lib/node_modules/playwright');
const fs = require('node:fs');

(async () => {
  const browser = await firefox.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto('file://${htmlPath}');
  const title = await page.title();
  await page.screenshot({ path: '${screenshotPath}' });
  await browser.close();

  if (title !== 'Desk Browser Smoke') throw new Error(` + "`unexpected title ${title}`" + `);
  if (fs.statSync('${screenshotPath}').size <= 0) throw new Error('empty screenshot');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE`,
        ].join("\n"),
      ],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    h.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    h.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    const exitCode = await h.wait();

    expect({
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    }).toMatchObject({ exitCode: 0 });
  });

  it("pre-registers Playwright MCP in OpenCode's resolved config", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();
    const h = await engine.exec({
      containerId: handle.containerId,
      cmd: [
        "sh",
        "-lc",
        "opencode debug config | node -e \"let raw=''; process.stdin.on('data', c => raw += c); process.stdin.on('end', () => { const start = raw.indexOf('{'); const cfg = JSON.parse(raw.slice(start)); const mcp = cfg.mcp && cfg.mcp.playwright; if (!mcp) process.exit(1); if (mcp.type !== 'local') process.exit(2); if (mcp.enabled !== true) process.exit(3); if (JSON.stringify(mcp.command) !== JSON.stringify(['playwright-mcp','--browser','firefox'])) process.exit(4); });\"",
      ],
    });
    const exitCode = await h.wait();

    expect(exitCode).toBe(0);
  });

  it("stopSandbox stops the container", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    await stopSandbox(handle);
    const engine = await detectEngine();
    const info = await engine.inspect(handle.containerId);
    expect(info?.running).toBe(false);
  });
});
