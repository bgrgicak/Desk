import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, filesDir, libraryDir, chatsDir } from "@desk/storage";
import {
  projectMounts,
  teardownMounts,
  activeRunCount,
  sandboxMountRoot,
  desktopDir,
  containerBinds,
} from "../src/mounts.js";
import type { SandboxHandle } from "../src/docker.js";

let home: string;
const handle: SandboxHandle = { containerId: "fake-container", workspaceId: "wks_test123" };

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-runtime-mount-test-"));
  await ensureLayout(home);
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("mounts", () => {
  it("projectMounts returns paths to the REAL workspace dirs, not a staging copy", async () => {
    const mounts = await projectMounts(handle, {
      home,
      workspaceId: "wks_test",
      runId: "run_mount1",
    });

    expect(mounts.files).toBe(filesDir(home));
    expect(mounts.library).toBe(libraryDir(home));
    expect(mounts.desktop).toBe(desktopDir(home, handle.workspaceId));
    expect(mounts.attachments).toBeUndefined();
    expect(mounts.attachmentsInSandbox).toBeUndefined();
  });

  it("projectMounts exposes the current chat's attachments when chatId is provided", async () => {
    const mounts = await projectMounts(handle, {
      home,
      workspaceId: "wks_test",
      chatId: "cht_test12345678901234567",
      runId: "run_mount2",
    });

    expect(mounts.attachments).toContain("chats/cht_test12345678901234567/attachments");
    expect(mounts.attachmentsInSandbox).toBe(
      "/mnt/desk/chats/cht_test12345678901234567/attachments",
    );
  });

  it("projectMounts creates the desktop scratch dir on disk", async () => {
    const stat = await fs.stat(desktopDir(home, handle.workspaceId));
    expect(stat.isDirectory()).toBe(true);
  });

  it("projectMounts writes a manifest with host + in-sandbox paths", async () => {
    const root = sandboxMountRoot(home, handle.workspaceId);
    const raw = await fs.readFile(path.join(root, "manifest-run_mount1.json"), "utf-8");
    const manifest = JSON.parse(raw);
    expect(manifest.runId).toBe("run_mount1");
    expect(manifest.host.files).toBe(filesDir(home));
    expect(manifest.inSandbox.files).toBe("/mnt/desk/files");
    expect(manifest.inSandbox.library).toBe("/mnt/desk/library");
    expect(manifest.inSandbox.desktop).toBe("/mnt/desk/desktop");
  });

  it("containerBinds binds the real workspace dirs read-only + desktop read-write", () => {
    const binds = containerBinds(home, "wks_test_binds");
    expect(binds).toEqual([
      `${filesDir(home)}:/mnt/desk/files:ro`,
      `${libraryDir(home)}:/mnt/desk/library:ro`,
      `${chatsDir(home)}:/mnt/desk/chats:ro`,
      `${desktopDir(home, "wks_test_binds")}:/mnt/desk/desktop:rw`,
    ]);
  });

  it("activeRunCount tracks runs correctly", async () => {
    const testHandle: SandboxHandle = { containerId: "fake-2", workspaceId: "wks_count_test" };

    expect(activeRunCount("wks_count_test")).toBe(0);

    await projectMounts(testHandle, {
      home,
      workspaceId: "wks_count_test",
      runId: "run_count1",
    });
    expect(activeRunCount("wks_count_test")).toBe(1);

    await projectMounts(testHandle, {
      home,
      workspaceId: "wks_count_test",
      runId: "run_count2",
    });
    expect(activeRunCount("wks_count_test")).toBe(2);

    await teardownMounts(testHandle, "run_count1");
    expect(activeRunCount("wks_count_test")).toBe(1);

    await teardownMounts(testHandle, "run_count2");
    expect(activeRunCount("wks_count_test")).toBe(0);
  });
});
