import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, ensureWorkspaceLayout, workspaceRootPath } from "@roomy-ai/storage";
import { generateId, LOCAL_FILESYSTEM_MOUNT_MARKER, LOCAL_FILESYSTEM_PROVIDER_ID } from "@roomy-ai/shared";
import { setupTestDb, teardownTestDb } from "../../db/test/helpers/db.js";
import { queries, type Pool } from "@roomy-ai/db";
import {
  projectMounts,
  teardownMounts,
  activeRunCount,
  containerBinds,
  buildDefaultMountPlan,
  buildWorkspaceMountPlan,
  bindsFromPlan,
  SANDBOX_HOME,
  SKILLS_SANDBOX_MOUNT_DIR,
  APPS_SANDBOX_MOUNT_DIR,
  skillsHostDir,
  appsHostDir,
} from "../src/mounts.js";
import type { SandboxHandle } from "../src/docker.js";

let home: string;
let pool: Pool;
let userId: string;
let workspaceId: string;
const TEST_SLUG = "test-ws";
const handle: SandboxHandle = { containerId: "fake-container", workspaceId: "wks_test123" };

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-runtime-mount-test-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, TEST_SLUG);
  pool = await setupTestDb();
  userId = generateId("user");
  workspaceId = generateId("workspace");
  await queries.users.insert(pool, {
    id: userId,
    username: "mount-user",
    passwordHash: "hash",
    email: "mount@example.com",
  });
  await queries.workspaces.insert(pool, { id: workspaceId, userId, name: "Test WS", path: TEST_SLUG });
});

afterAll(async () => {
  await teardownTestDb(pool);
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

  it("containerBinds binds the workspace root, global skills, and built-in apps", () => {
    const binds = containerBinds(home, TEST_SLUG);
    expect(binds).toEqual([
      `${workspaceRootPath(home, TEST_SLUG)}:${SANDBOX_HOME}:rw`,
      `${skillsHostDir(home)}:${SKILLS_SANDBOX_MOUNT_DIR}:ro`,
      `${appsHostDir(home)}:${APPS_SANDBOX_MOUNT_DIR}:ro`,
    ]);
  });

  it("buildDefaultMountPlan mounts workspace rw, skills ro, and built-in apps ro", () => {
    const plan = buildDefaultMountPlan(home, TEST_SLUG);
    expect(plan).toHaveLength(3);
    expect(plan[0].mode).toBe("rw");
    expect(plan[0].category).toBe("workspace");
    expect(plan[0].targetPath).toBe(SANDBOX_HOME);
    expect(plan[0].sourcePath).toBe(workspaceRootPath(home, TEST_SLUG));
    expect(plan[1].mode).toBe("ro");
    expect(plan[1].targetPath).toBe(SKILLS_SANDBOX_MOUNT_DIR);
    expect(plan[1].sourcePath).toBe(skillsHostDir(home));
    expect(plan[2].mode).toBe("ro");
    expect(plan[2].targetPath).toBe(APPS_SANDBOX_MOUNT_DIR);
    expect(plan[2].sourcePath).toBe(appsHostDir(home));
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

  it("buildWorkspaceMountPlan adds active local filesystem mounts and agent context", async () => {
    const previousAllowedRoots = process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-local-fs-source-"));
    const realSource = await fs.realpath(source);
    process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = source;
    try {
      const connection = await queries.connectors.createConnection(pool, {
        ownerUserId: userId,
        providerId: LOCAL_FILESYSTEM_PROVIDER_ID,
        displayName: "Local folders",
        status: "active",
        metadata: {
          localFilesystem: {
            directories: [{
              id: "dir_docs",
              hostPath: source,
              homeName: "Docs",
              access: "read_only",
              description: "Reference docs.",
            }],
          },
        },
      });
      await queries.connectors.replaceWorkspaceGrants(pool, workspaceId, userId, [
        { connectionId: connection.id, providerId: LOCAL_FILESYSTEM_PROVIDER_ID, grantedCapabilities: [] },
      ]);

      const result = await buildWorkspaceMountPlan(pool, { home, workspaceId, workspaceSlug: TEST_SLUG, userId });

      expect(result.mountPlan).toContainEqual({
        sourcePath: realSource,
        targetPath: `${SANDBOX_HOME}/Docs`,
        mode: "ro",
        category: "external",
        ensureSource: false,
        mountPointId: `${result.mountPlan.find((entry) => entry.targetPath === `${SANDBOX_HOME}/Docs`)?.mountPointId}`,
      });
      expect(result.agentDirectories).toEqual([{ path: "~/Docs", access: "read_only", description: "Reference docs." }]);
    } finally {
      if (previousAllowedRoots === undefined) delete process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
      else process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = previousAllowedRoots;
    }
  });

  it("buildWorkspaceMountPlan accepts stale local filesystem mount placeholders for the same home name", async () => {
    const previousAllowedRoots = process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-local-fs-stale-marker-"));
    const realSource = await fs.realpath(source);
    process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = source;
    try {
      const staleUserId = generateId("user");
      await queries.users.insert(pool, {
        id: staleUserId,
        username: "mount-stale-marker-user",
        passwordHash: "hash",
        email: "mount-stale-marker@example.com",
      });
      const target = path.join(workspaceRootPath(home, TEST_SLUG), "Projects");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, LOCAL_FILESYSTEM_MOUNT_MARKER), JSON.stringify({ mountId: "old:dir" }));
      const connection = await queries.connectors.createConnection(pool, {
        ownerUserId: staleUserId,
        providerId: LOCAL_FILESYSTEM_PROVIDER_ID,
        displayName: "Local folders",
        status: "active",
        metadata: {
          localFilesystem: {
            directories: [{ id: "dir_projects", hostPath: source, homeName: "Projects", access: "read_write" }],
          },
        },
      });
      await queries.connectors.replaceWorkspaceGrants(pool, workspaceId, staleUserId, [
        { connectionId: connection.id, providerId: LOCAL_FILESYSTEM_PROVIDER_ID, grantedCapabilities: [] },
      ]);

      const result = await buildWorkspaceMountPlan(pool, { home, workspaceId, workspaceSlug: TEST_SLUG, userId: staleUserId });

      expect(result.mountPlan).toContainEqual(expect.objectContaining({
        sourcePath: realSource,
        targetPath: `${SANDBOX_HOME}/Projects`,
        mountPointId: `${connection.id}:dir_projects`,
      }));
    } finally {
      if (previousAllowedRoots === undefined) delete process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
      else process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = previousAllowedRoots;
    }
  });

  it("buildWorkspaceMountPlan downgrades read-write directories when the workspace grant lacks write", async () => {
    const previousAllowedRoots = process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-local-fs-grant-ro-"));
    const realSource = await fs.realpath(source);
    process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = source;
    try {
      const grantUserId = generateId("user");
      await queries.users.insert(pool, {
        id: grantUserId,
        username: "mount-grant-ro-user",
        passwordHash: "hash",
        email: "mount-grant-ro@example.com",
      });
      const connection = await queries.connectors.createConnection(pool, {
        ownerUserId: grantUserId,
        providerId: LOCAL_FILESYSTEM_PROVIDER_ID,
        displayName: "Grant read only",
        status: "active",
        capabilities: ["local_filesystem.read", "local_filesystem.write"],
        metadata: {
          localFilesystem: {
            directories: [{ id: "dir_projects_ro", hostPath: source, homeName: "GrantProjects", access: "read_write" }],
          },
        },
      });
      await queries.connectors.replaceWorkspaceGrants(pool, workspaceId, grantUserId, [
        { connectionId: connection.id, providerId: LOCAL_FILESYSTEM_PROVIDER_ID, grantedCapabilities: ["local_filesystem.read"] },
      ]);

      const result = await buildWorkspaceMountPlan(pool, { home, workspaceId, workspaceSlug: TEST_SLUG, userId: grantUserId });

      expect(result.mountPlan).toContainEqual(expect.objectContaining({
        sourcePath: realSource,
        targetPath: `${SANDBOX_HOME}/GrantProjects`,
        mode: "ro",
        mountPointId: `${connection.id}:dir_projects_ro`,
      }));
      expect(result.agentDirectories).toContainEqual({
        path: "~/GrantProjects",
        access: "read_only",
      });
    } finally {
      if (previousAllowedRoots === undefined) delete process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
      else process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = previousAllowedRoots;
      await fs.rm(source, { recursive: true, force: true });
    }
  });

  it("buildWorkspaceMountPlan rejects local filesystem mounts outside the operator allowlist", async () => {
    const previousAllowedRoots = process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-local-fs-blocked-"));
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-local-fs-different-root-"));
    process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = allowedRoot;
    try {
      const blockedUserId = generateId("user");
      await queries.users.insert(pool, {
        id: blockedUserId,
        username: "mount-blocked-user",
        passwordHash: "hash",
        email: "mount-blocked@example.com",
      });
      const connection = await queries.connectors.createConnection(pool, {
        ownerUserId: blockedUserId,
        providerId: LOCAL_FILESYSTEM_PROVIDER_ID,
        displayName: "Blocked local folders",
        status: "active",
        metadata: {
          localFilesystem: {
            directories: [{ id: "dir_blocked", hostPath: source, homeName: "Blocked", access: "read_only" }],
          },
        },
      });
      await queries.connectors.replaceWorkspaceGrants(pool, workspaceId, blockedUserId, [
        { connectionId: connection.id, providerId: LOCAL_FILESYSTEM_PROVIDER_ID, grantedCapabilities: [] },
      ]);

      await expect(buildWorkspaceMountPlan(pool, { home, workspaceId, workspaceSlug: TEST_SLUG, userId: blockedUserId }))
        .rejects.toThrow("not allowed");
    } finally {
      if (previousAllowedRoots === undefined) delete process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
      else process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = previousAllowedRoots;
      await fs.rm(allowedRoot, { recursive: true, force: true });
      await fs.rm(source, { recursive: true, force: true });
    }
  });

  it("buildWorkspaceMountPlan rejects home-name collisions", async () => {
    const previousAllowedRoots = process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-local-fs-collision-"));
    process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = source;
    try {
      await fs.mkdir(path.join(workspaceRootPath(home, TEST_SLUG), "Taken"));
      const collisionUserId = generateId("user");
      await queries.users.insert(pool, {
        id: collisionUserId,
        username: "mount-collision-user",
        passwordHash: "hash",
        email: "mount-collision@example.com",
      });
      const connection = await queries.connectors.createConnection(pool, {
        ownerUserId: collisionUserId,
        providerId: LOCAL_FILESYSTEM_PROVIDER_ID,
        displayName: "Local folders",
        status: "active",
        metadata: {
          localFilesystem: {
            directories: [{ id: "dir_taken", hostPath: source, homeName: "Taken", access: "read_write" }],
          },
        },
      });
      await queries.connectors.replaceWorkspaceGrants(pool, workspaceId, collisionUserId, [
        { connectionId: connection.id, providerId: LOCAL_FILESYSTEM_PROVIDER_ID, grantedCapabilities: [] },
      ]);

      await expect(buildWorkspaceMountPlan(pool, { home, workspaceId, workspaceSlug: TEST_SLUG, userId: collisionUserId }))
        .rejects.toThrow("~/Taken already exists");
    } finally {
      if (previousAllowedRoots === undefined) delete process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS;
      else process.env.ROOMY_LOCAL_FILESYSTEM_ALLOWED_ROOTS = previousAllowedRoots;
    }
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
