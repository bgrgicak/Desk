import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildApps } from "../scripts/build-apps.mjs";

describe("buildApps", () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "roomy-apps-build-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("builds @roomy-ai/ui before built-in apps when ui dist is missing", async () => {
    const { packageRoot, uiPackageRoot } = await makeWorkspaceShape(tmpRoot);
    const calls = [];

    await buildApps({
      packageRoot,
      uiPackageRoot,
      run: async (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts.cwd });
        if (opts.cwd === uiPackageRoot) {
          await fsp.mkdir(path.join(uiPackageRoot, "dist"), { recursive: true });
          await fsp.writeFile(path.join(uiPackageRoot, "dist", "index.js"), "");
          await fsp.writeFile(path.join(uiPackageRoot, "dist", "index.d.ts"), "");
        }
      },
    });

    expect(calls).toEqual([
      { cmd: "npm", args: ["run", "build"], cwd: uiPackageRoot },
      { cmd: "npm", args: ["run", "build"], cwd: path.join(packageRoot, "chat-cards.app") },
    ]);
  });

  it("does not rebuild @roomy-ai/ui when its JS and type outputs exist", async () => {
    const { packageRoot, uiPackageRoot } = await makeWorkspaceShape(tmpRoot);
    await fsp.mkdir(path.join(uiPackageRoot, "dist"), { recursive: true });
    await fsp.writeFile(path.join(uiPackageRoot, "dist", "index.js"), "");
    await fsp.writeFile(path.join(uiPackageRoot, "dist", "index.d.ts"), "");
    const calls = [];

    await buildApps({
      packageRoot,
      uiPackageRoot,
      run: async (cmd, args, opts) => calls.push({ cmd, args, cwd: opts.cwd }),
    });

    expect(calls).toEqual([
      { cmd: "npm", args: ["run", "build"], cwd: path.join(packageRoot, "chat-cards.app") },
    ]);
  });

  it("skips the workspace ui prebuild outside the monorepo source layout", async () => {
    const packageRoot = path.join(tmpRoot, "standalone-apps");
    await fsp.mkdir(path.join(packageRoot, "chat-cards.app"), { recursive: true });
    const calls = [];

    await buildApps({
      packageRoot,
      uiPackageRoot: path.join(tmpRoot, "missing-ui"),
      run: async (cmd, args, opts) => calls.push({ cmd, args, cwd: opts.cwd }),
    });

    expect(calls).toEqual([
      { cmd: "npm", args: ["run", "build"], cwd: path.join(packageRoot, "chat-cards.app") },
    ]);
  });
});

async function makeWorkspaceShape(root) {
  const packageRoot = path.join(root, "packages", "apps");
  const uiPackageRoot = path.join(root, "packages", "ui");
  await fsp.mkdir(path.join(packageRoot, "chat-cards.app"), { recursive: true });
  await fsp.mkdir(uiPackageRoot, { recursive: true });
  return { packageRoot, uiPackageRoot };
}
