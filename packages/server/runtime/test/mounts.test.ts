import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, ensureWorkspaceLayout, workspaceRootPath } from "@agent-desk/storage";
import {
  projectMounts,
  teardownMounts,
  activeRunCount,
  containerBinds,
  buildDefaultMountPlan,
  bindsFromPlan,
  SANDBOX_HOME,
  SKILLS_SANDBOX_MOUNT_DIR,
  skillsHostDir,
} from "../src/mounts.js";
import type { SandboxHandle } from "../src/docker.js";

let home: string;
const TEST_SLUG = "test-ws";
const handle: SandboxHandle = { containerId: "fake-container", workspaceId: "wks_test123" };

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-runtime-mount-test-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, TEST_SLUG);
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("mounts", () => {
  it("projectMounts returns the workspace root that gets bind-mounted at $HOME", async () => {
    const mounts = await projectMounts(handle, {
      home,
      workspaceId: "wks_test",
      workspaceSlug: TEST_SLUG,
      runId: "run_mount1",
    });

    expect(mounts.workspace).toBe(workspaceRootPath(home, TEST_SLUG));
    expect(mounts.attachments).toBeUndefined();
    expect(mounts.attachmentsInSandbox).toBeUndefined();
  });

  it("projectMounts exposes the current chat's attachments when chatId is provided", async () => {
    const mounts = await projectMounts(handle, {
      home,
      workspaceId: "wks_test",
      workspaceSlug: TEST_SLUG,
      chatId: "cht_test12345678901234567",
      runId: "run_mount2",
    });

    expect(mounts.attachments).toContain(
      ".chats/cht_test12345678901234567/attachments",
    );
    expect(mounts.attachmentsInSandbox).toBe(
      `${SANDBOX_HOME}/.chats/cht_test12345678901234567/attachments`,
    );
  });

  it("containerBinds binds the workspace root and global skills", () => {
    const binds = containerBinds(home, TEST_SLUG);
    expect(binds).toEqual([
      `${workspaceRootPath(home, TEST_SLUG)}:${SANDBOX_HOME}:rw`,
      `${skillsHostDir(home)}:${SKILLS_SANDBOX_MOUNT_DIR}:ro`,
    ]);
  });

  it("buildDefaultMountPlan mounts workspace rw and skills ro", () => {
    const plan = buildDefaultMountPlan(home, TEST_SLUG);
    expect(plan).toHaveLength(2);
    expect(plan[0].mode).toBe("rw");
    expect(plan[0].category).toBe("workspace");
    expect(plan[0].targetPath).toBe(SANDBOX_HOME);
    expect(plan[0].sourcePath).toBe(workspaceRootPath(home, TEST_SLUG));
    expect(plan[1].mode).toBe("ro");
    expect(plan[1].targetPath).toBe(SKILLS_SANDBOX_MOUNT_DIR);
    expect(plan[1].sourcePath).toBe(skillsHostDir(home));
    expect(bindsFromPlan(plan)).toEqual(containerBinds(home, TEST_SLUG));
  });

  it("custom MountPlan produces its own bind set (G5)", () => {
    const binds = bindsFromPlan([
      { sourcePath: "/tmp/project", targetPath: "/home/agent/project", mode: "rw", category: "external" },
      { sourcePath: "/tmp/docs", targetPath: "/home/agent/docs", mode: "ro", category: "external" },
    ]);
    expect(binds).toEqual([
      "/tmp/project:/home/agent/project:rw",
      "/tmp/docs:/home/agent/docs:ro",
    ]);
  });

  it("later plan entries with the same targetPath override earlier ones", () => {
    const binds = bindsFromPlan([
      { sourcePath: "/a", targetPath: "/home/agent/x", mode: "ro", category: "workspace" },
      { sourcePath: "/b", targetPath: "/home/agent/x", mode: "rw", category: "external" },
    ]);
    expect(binds).toEqual(["/b:/home/agent/x:rw"]);
  });

  it("activeRunCount tracks runs correctly", async () => {
    const testHandle: SandboxHandle = { containerId: "fake-2", workspaceId: "wks_count_test" };

    expect(activeRunCount("wks_count_test")).toBe(0);

    await projectMounts(testHandle, {
      home,
      workspaceId: "wks_count_test",
      workspaceSlug: TEST_SLUG,
      runId: "run_count1",
    });
    expect(activeRunCount("wks_count_test")).toBe(1);

    await projectMounts(testHandle, {
      home,
      workspaceId: "wks_count_test",
      workspaceSlug: TEST_SLUG,
      runId: "run_count2",
    });
    expect(activeRunCount("wks_count_test")).toBe(2);

    await teardownMounts(testHandle, "run_count1");
    expect(activeRunCount("wks_count_test")).toBe(1);

    await teardownMounts(testHandle, "run_count2");
    expect(activeRunCount("wks_count_test")).toBe(0);
  });
});
