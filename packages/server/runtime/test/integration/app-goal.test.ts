/**
 * Integration test: agent app-goal scaffolding inside a real sandbox container.
 *
 * Skips when the desk/sandbox:v1 image isn't present locally.
 *
 * Requires the image built from this PR's Dockerfile so /opt/desk-template/app
 * is baked in. With an older image, the test surfaces a clear failure pointing
 * the developer at the rebuild command.
 *
 * What the test does end-to-end against real Docker:
 *   1. Spawn a sandbox container.
 *   2. Run `desk-agent app create --chat <id> my-app`.
 *   3. Confirm the cloned tree has the expected structure and substitutions.
 *   4. Run `npm run build` inside the cloned `<name>.app/` directory.
 *   5. Confirm `dist/index.html` exists and Tailwind CSS was emitted.
 *
 * The build relies on the pre-installed node_modules baked into the
 * scaffold; no network access is required.
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
  sandboxImage,
} from "../../src/docker.js";
import { detectEngine, type Engine } from "../../src/engine.js";
import { rmTempTree } from "./helpers.js";

let engineForSetup: Engine | null = null;
let SKIP = false;
let skipReason = "";

try {
  engineForSetup = await detectEngine();
  if (!(await engineForSetup.imageId(sandboxImage()))) {
    SKIP = true;
    skipReason = "desk/sandbox:v1 image not present";
  }
} catch (err) {
  SKIP = true;
  skipReason = `engine probe failed: ${(err as Error).message}`;
}

const describeIf = SKIP ? describe.skip : describe;

let home: string;
const testWorkspaceId = "wks_int_app_goal";
const testWorkspaceSlug = "int-app-goal";
const containerName = `desk-sandbox-${testWorkspaceId}`;

beforeAll(async () => {
  if (SKIP) {
    console.warn(`[app-goal integration] skipped: ${skipReason}`);
    return;
  }
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-app-goal-int-"));
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

async function execCapture(
  engine: Engine,
  containerId: string,
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const handle = await engine.exec({ containerId, cmd });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  handle.stdout.on("data", (c: Buffer) => out.push(c));
  handle.stderr.on("data", (c: Buffer) => err.push(c));
  const exitCode = await handle.wait();
  return {
    exitCode,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
  };
}

describeIf("app goal — scaffold + build", () => {
  it("clones the scaffold and `npm run build` produces dist/index.html that references @agent-desk/ui", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();
    const chatId = "cht_app_goal_test";

    // Confirm the bake-in exists. Old image without /opt/desk-template/app
    // produces a clear failure message instead of a confusing CLI error.
    const probe = await execCapture(engine, handle.containerId, [
      "test",
      "-d",
      "/opt/desk-template/app",
    ]);
    expect(
      probe.exitCode,
      "sandbox image is missing /opt/desk-template/app — rebuild via " +
        "`docker build -f packages/server/runtime/Dockerfile.sandbox -t desk/sandbox:v1 .`",
    ).toBe(0);

    // Pre-create the chat directory so the cp target exists. The host-side
    // chat creation API does this; here we mimic it.
    const chatHostDir = path.join(
      workspaceRootPath(home, testWorkspaceSlug),
      ".chats",
      chatId,
      "artifacts",
    );
    await fs.mkdir(chatHostDir, { recursive: true });

    const create = await execCapture(engine, handle.containerId, [
      "desk-agent",
      "app",
      "create",
      "--chat",
      chatId,
      "my-app",
    ]);
    expect(create.exitCode, `app create stderr: ${create.stderr}`).toBe(0);

    const created = JSON.parse(create.stdout.trim().split("\n").pop()!);
    expect(created.name).toBe("my-app");
    expect(created.chatId).toBe(chatId);
    expect(created.path).toBe(`/home/agent/.chats/${chatId}/artifacts/my-app.app`);

    // Confirm the host sees the cloned tree (bind-mount round-trip).
    const hostAppDir = path.join(chatHostDir, "my-app.app");
    const manifest = JSON.parse(
      await fs.readFile(path.join(hostAppDir, "desk.app.json"), "utf-8"),
    );
    expect(manifest.name).toBe("my-app");

    const build = await execCapture(engine, handle.containerId, [
      "sh",
      "-c",
      `cd /home/agent/.chats/${chatId}/artifacts/my-app.app && npm run build 2>&1`,
    ]);
    expect(
      build.exitCode,
      `npm run build output:\n${build.stdout}\n${build.stderr}`,
    ).toBe(0);

    // Built dist/ on the host (via bind-mount) — index.html must exist and
    // pull in a hashed JS bundle.
    const distIndex = await fs.readFile(path.join(hostAppDir, "dist", "index.html"), "utf-8");
    expect(distIndex).toMatch(/<script[^>]+src=["'][^"']*assets\/[^"']+\.js/);

    const distAssetsDir = path.join(hostAppDir, "dist", "assets");
    const assetEntries = await fs.readdir(distAssetsDir);
    const cssAsset = assetEntries.find((f) => f.endsWith(".css"));
    expect(cssAsset, `expected a CSS asset under dist/assets/: ${assetEntries}`).toBeTruthy();
    const css = await fs.readFile(path.join(distAssetsDir, cssAsset!), "utf-8");
    // Tailwind v4 emitted a non-trivial CSS bundle, evidence that
    // @agent-desk/ui's @source directives reached the consumer build.
    expect(css.length).toBeGreaterThan(1000);

    // Each fragment also gets its own dist/fragments/<name>/index.html.
    const exampleFragment = await fs.readFile(
      path.join(hostAppDir, "dist", "fragments", "example", "index.html"),
      "utf-8",
    );
    expect(exampleFragment).toMatch(/<script[^>]+src=/);

    await stopSandbox(handle);
  }, 600_000); // build can take a couple minutes when caches are cold
});
