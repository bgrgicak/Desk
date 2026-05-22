import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { NotFoundError, ValidationError } from "@roomy-ai/shared";
import {
  uploadArtifact,
  readFile,
  downloadFile,
  deleteFile,
  moveFile,
  pinLibraryFileToChat,
  relativeSymlinkTarget,
  removeChatAttachment,
  resolveForSandbox,
  statFile,
} from "../src/files.js";
import { chatAttachmentsDir, workspaceRootPath } from "../src/layout.js";
import {
  setupTestStorage,
  teardownTestStorage,
  type TestStorageContext,
} from "./helpers/storage.js";

let ctx: TestStorageContext;

beforeAll(async () => {
  ctx = await setupTestStorage();
});

afterAll(async () => {
  await teardownTestStorage(ctx);
});

function makeStream(content: string): Readable {
  return Readable.from(Buffer.from(content));
}

describe("uploadArtifact (FS-backed, no DB)", () => {
  it("writes a library file to library/ and returns a workspace-relative path", async () => {
    const file = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "report.md",
      mime: "text/markdown",
      stream: makeStream("library content"),
    });

    // Workspace root is the library — file lands directly at the root.
    expect(file.path).toBe("report.md");
    expect(file.name).toBe("report.md");
    expect(file.mime).toBe("text/markdown");
    expect(file.size).toBe("library content".length);

    const hostPath = path.join(ctx.home, "roomy", file.path);
    const content = await fs.readFile(hostPath, "utf-8");
    expect(content).toBe("library content");
  });

  it("routes chat attachments into chats/{chatId}/attachments/", async () => {
    const file = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      chatId: ctx.chatId,
      name: "artifact.png",
      mime: "image/png",
      stream: makeStream("fake-png-data"),
    });

    expect(file.path).toContain(`.chats/${ctx.chatId}/attachments/`);
  });

  it("rejects user uploads whose name starts with a dot (reserved for agent artifacts)", async () => {
    await expect(
      uploadArtifact(ctx, {
        workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
        name: ".hidden.md",
        mime: "text/markdown",
        stream: makeStream("nope"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("avoids collisions by suffixing -1, -2, ...", async () => {
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "dup.txt",
      mime: "text/plain",
      stream: makeStream("first"),
    });
    const second = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "dup.txt",
      mime: "text/plain",
      stream: makeStream("second"),
    });

    expect(second.name).toBe("dup-1.txt");
  });

  it("rejects files exceeding MAX_UPLOAD_BYTES", async () => {
    vi.resetModules();
    vi.doMock("@roomy-ai/shared", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@roomy-ai/shared")>()),
      MAX_UPLOAD_BYTES: 8,
    }));

    try {
      const { uploadArtifact: uploadWithSmallLimit } = await import("../src/files.js");
      await expect(
        uploadWithSmallLimit(ctx, {
          workspaceId: ctx.workspaceId,
          workspaceSlug: ctx.workspaceSlug,
          name: "toobig.bin",
          mime: "application/octet-stream",
          stream: makeStream("more than eight bytes"),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      vi.doUnmock("@roomy-ai/shared");
      vi.resetModules();
    }
  });
});

describe("readFile / downloadFile / statFile", () => {
  it("reads back the exact uploaded bytes", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "read-test.txt",
      mime: "text/plain",
      stream: makeStream("read me"),
    });

    const { stream, file } = await readFile(ctx, ctx.workspaceSlug,uploaded.path);
    expect(file.path).toBe(uploaded.path);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("read me");
  });

  it("downloadFile is the same as readFile", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "download-test.txt",
      mime: "text/plain",
      stream: makeStream("download me"),
    });

    const { stream } = await downloadFile(ctx, ctx.workspaceSlug,uploaded.path);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("download me");
  });

  it("statFile returns metadata without a stream", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "stat-test.txt",
      mime: "text/plain",
      stream: makeStream("12345"),
    });

    const ref = await statFile(ctx, ctx.workspaceSlug,uploaded.path);
    expect(ref.path).toBe(uploaded.path);
    expect(ref.size).toBe(5);
  });

  it("throws NotFoundError for an unknown path", async () => {
    await expect(readFile(ctx, ctx.workspaceSlug,"does-not-exist.txt")).rejects.toThrow(NotFoundError);
  });
});

describe("deleteFile (moves to trash)", () => {
  it("moves the file to ~/.trash and the old path stops resolving", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "delete-me.txt",
      mime: "text/plain",
      stream: makeStream("bye"),
    });

    const hostPath = path.join(ctx.home, "roomy", uploaded.path);
    await fs.access(hostPath);

    await deleteFile(ctx, ctx.workspaceSlug,uploaded.path);

    // Old path no longer exists.
    await expect(fs.access(hostPath)).rejects.toThrow();

    // But the trash dir holds a file of the same content.
    const trashEntries = await fs.readdir(path.join(ctx.home, ".trash"));
    const trashed = trashEntries.find((n) => n.endsWith("delete-me.txt"));
    expect(trashed).toBeDefined();
    const content = await fs.readFile(
      path.join(ctx.home, ".trash", trashed!),
      "utf-8",
    );
    expect(content).toBe("bye");
  });

  it("throws NotFoundError for unknown path", async () => {
    await expect(deleteFile(ctx, ctx.workspaceSlug,"does-not-exist.txt")).rejects.toThrow(NotFoundError);
  });
});

describe("removeChatAttachment", () => {
  it("pins library files with sandbox-portable relative symlinks", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "pin-portable.txt",
      mime: "text/plain",
      stream: makeStream("portable"),
      subpath: "PinPortable",
    });

    await pinLibraryFileToChat(ctx, ctx.workspaceSlug, ctx.chatId, uploaded.path);

    const root = workspaceRootPath(ctx.home, ctx.workspaceSlug);
    const targetAbs = path.join(root, uploaded.path);
    const attDir = await chatAttachmentsDir(ctx.home, ctx.workspaceSlug, ctx.chatId);
    const linkPath = path.join(attDir, "pin-portable.txt");
    expect(await fs.readlink(linkPath)).toBe(relativeSymlinkTarget(linkPath, targetAbs));
    expect(await fs.readFile(linkPath, "utf8")).toBe("portable");

    await fs.unlink(linkPath);
    await fs.symlink(targetAbs, linkPath);

    await pinLibraryFileToChat(ctx, ctx.workspaceSlug, ctx.chatId, uploaded.path);
    expect(await fs.readlink(linkPath)).toBe(relativeSymlinkTarget(linkPath, targetAbs));
  });

  it("unlinks a pinned library symlink without disturbing the source file", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "pin-source.txt",
      mime: "text/plain",
      stream: makeStream("payload"),
      subpath: "PinHome",
    });
    await pinLibraryFileToChat(ctx, ctx.workspaceSlug, ctx.chatId, uploaded.path);

    const attDir = await chatAttachmentsDir(ctx.home, ctx.workspaceSlug, ctx.chatId);
    const linkPath = path.join(attDir, "pin-source.txt");
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

    await removeChatAttachment(ctx, ctx.workspaceSlug, ctx.chatId, "pin-source.txt");

    await expect(fs.lstat(linkPath)).rejects.toThrow();
    // Source file is untouched.
    const root = workspaceRootPath(ctx.home, ctx.workspaceSlug);
    const srcContent = await fs.readFile(path.join(root, uploaded.path), "utf8");
    expect(srcContent).toBe("payload");
  });

  it("unlinks a direct chat upload (regular file)", async () => {
    const attDir = await chatAttachmentsDir(ctx.home, ctx.workspaceSlug, ctx.chatId);
    await fs.writeFile(path.join(attDir, "direct.txt"), "scratch");

    await removeChatAttachment(ctx, ctx.workspaceSlug, ctx.chatId, "direct.txt");

    await expect(fs.lstat(path.join(attDir, "direct.txt"))).rejects.toThrow();
  });

  it("rejects path-traversal and slash-bearing names", async () => {
    await expect(
      removeChatAttachment(ctx, ctx.workspaceSlug, ctx.chatId, "../escape.txt"),
    ).rejects.toThrow(ValidationError);
    await expect(
      removeChatAttachment(ctx, ctx.workspaceSlug, ctx.chatId, "nested/file.txt"),
    ).rejects.toThrow(ValidationError);
  });

  it("treats hidden / dot-prefixed names like any other (NotFoundError when absent)", async () => {
    // Hidden names are no longer rejected — they behave like regular
    // files. If the file doesn't exist, the caller sees NotFoundError.
    await expect(
      removeChatAttachment(ctx, ctx.workspaceSlug, ctx.chatId, ".internal.txt"),
    ).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when the attachment doesn't exist", async () => {
    await expect(
      removeChatAttachment(ctx, ctx.workspaceSlug, ctx.chatId, "ghost.txt"),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("moveFile (symlink-on-move)", () => {
  it("renames the file and leaves a symlink at the old location", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "movable.txt",
      mime: "text/plain",
      stream: makeStream("follow me"),
    });

    const newRel = `moved-${Date.now()}.txt`;
    const moved = await moveFile(ctx, ctx.workspaceSlug,uploaded.path, newRel);
    expect(moved.path).toBe(newRel);

    const oldAbs = path.join(ctx.home, "roomy", uploaded.path);
    const lstat = await fs.lstat(oldAbs);
    expect(lstat.isSymbolicLink()).toBe(true);

    // Reading through the symlink gets the new location.
    const content = await fs.readFile(oldAbs, "utf-8");
    expect(content).toBe("follow me");
  });
});

describe("resolveForSandbox", () => {
  it("returns an absolute path that actually exists", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "sandbox-resolve.txt",
      mime: "text/plain",
      stream: makeStream("sandbox"),
    });

    const resolved = await resolveForSandbox(ctx, ctx.workspaceSlug,uploaded.path);
    expect(path.isAbsolute(resolved)).toBe(true);
    await fs.access(resolved);
  });

  it("throws NotFoundError for unknown path", async () => {
    await expect(resolveForSandbox(ctx, ctx.workspaceSlug,"does-not-exist.txt")).rejects.toThrow(NotFoundError);
  });
});
