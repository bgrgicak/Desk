import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Readable } from "node:stream";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { uploadArtifact, validateLibrarySubpath } from "../src/files.js";
import {
  listLibrary,
  createLibraryFolder,
  moveLibraryEntry,
  deleteLibraryEntry,
} from "../src/library.js";
import { workspaceRootPath, trashDir } from "../src/layout.js";
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

describe("listLibrary", () => {
  it("returns files uploaded to the library root, excluding dotfiles", async () => {
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "first.txt",
      mime: "text/plain",
      stream: makeStream("one"),
    });
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "second.txt",
      mime: "text/plain",
      stream: makeStream("two"),
    });

    const { items } = await listLibrary(ctx, ctx.workspaceSlug);
    const names = items.map((i) => i.name);
    expect(names).toContain("first.txt");
    expect(names).toContain("second.txt");
  });

  it("recurses into subdirectories and returns folders alongside files", async () => {
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "report.md",
      mime: "text/markdown",
      stream: makeStream("report body"),
      subpath: "Work/Plans",
    });
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "budget.csv",
      mime: "text/csv",
      stream: makeStream("col1,col2"),
      subpath: "Work",
    });

    const { items, folders } = await listLibrary(ctx, ctx.workspaceSlug);
    const paths = items.map((i) => i.path);
    expect(paths).toContain("Work/Plans/report.md");
    expect(paths).toContain("Work/budget.csv");

    const folderPaths = folders.map((f) => f.path);
    expect(folderPaths).toContain("Work");
    expect(folderPaths).toContain("Work/Plans");
  });

  it("returns the full tree when no limit is given, even if a subtree dominates mtime", async () => {
    // Simulate the node_modules problem: a freshly-written subtree whose mtimes
    // sort above an older root file. Without a limit, the older root file must
    // still be present so the frontend's tree reconstruction stays accurate.
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "older-root.txt",
      mime: "text/plain",
      stream: makeStream("older root"),
    });
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 60; i++) {
      await uploadArtifact(ctx, {
        workspaceId: ctx.workspaceId,
        workspaceSlug: ctx.workspaceSlug,
        name: `pkg-${i}.json`,
        mime: "application/json",
        stream: makeStream("{}"),
        subpath: "deps/node_modules/pkg",
      });
    }

    const { items, nextCursor } = await listLibrary(ctx, ctx.workspaceSlug);
    expect(nextCursor).toBeUndefined();
    expect(items.map((i) => i.path)).toContain("older-root.txt");
  });

  it("surfaces symlinks as their resolved kind without recursing through them", async () => {
    // npm-style workspace links: node_modules/@scope/pkg → ../../packages/pkg.
    // The linked target is already part of the listing, so following the link
    // would duplicate the subtree (and risk cycles on self-referential links).
    const root = workspaceRootPath(ctx.home, ctx.workspaceSlug);
    await fs.mkdir(path.join(root, "linkpkg/inner"), { recursive: true });
    await fs.writeFile(path.join(root, "linkpkg/inner/payload.txt"), "x");
    await fs.mkdir(path.join(root, "node_modules/@scope"), { recursive: true });
    await fs.symlink("../../linkpkg", path.join(root, "node_modules/@scope/pkg"));
    await fs.writeFile(path.join(root, "loose-link-target.txt"), "leaf");
    await fs.symlink("../loose-link-target.txt", path.join(root, "node_modules/loose-link"));

    const { items, folders } = await listLibrary(ctx, ctx.workspaceSlug);
    const folderPaths = folders.map((f) => f.path);
    const itemPaths = items.map((i) => i.path);

    expect(folderPaths).toContain("node_modules/@scope/pkg");
    // No recursion through the symlinked directory.
    expect(folderPaths).not.toContain("node_modules/@scope/pkg/inner");
    expect(itemPaths).not.toContain("node_modules/@scope/pkg/inner/payload.txt");

    expect(itemPaths).toContain("node_modules/loose-link");
  });

  it("paginates by mtime cursor", async () => {
    for (let i = 0; i < 4; i++) {
      await uploadArtifact(ctx, {
        workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
        name: `page-${i}.txt`,
        mime: "text/plain",
        stream: makeStream(`content ${i}`),
      });
      // Ensure mtimes differ
      await new Promise((r) => setTimeout(r, 10));
    }

    const page1 = await listLibrary(ctx, ctx.workspaceSlug, { limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await listLibrary(ctx, ctx.workspaceSlug, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
    // Pages should not overlap.
    const ids1 = new Set(page1.items.map((i) => i.path));
    for (const item of page2.items) {
      expect(ids1.has(item.path)).toBe(false);
    }
  });
});

describe("listLibrary gitignore", () => {
  // These tests share the workspace root with the suites above. They
  // write `.gitignore` files into dedicated subtrees so prior listings
  // (which already populated `node_modules/`, `older-root.txt`, etc.)
  // remain visible when `showHidden` is true.

  it("hides gitignored entries by default and surfaces them with showHidden", async () => {
    const root = workspaceRootPath(ctx.home, ctx.workspaceSlug);
    const sub = path.join(root, "gi-basic");
    await fs.mkdir(path.join(sub, "build"), { recursive: true });
    await fs.writeFile(path.join(sub, "build/output.bin"), "out");
    await fs.writeFile(path.join(sub, "keep.txt"), "k");
    await fs.writeFile(path.join(sub, ".gitignore"), "build/\n");

    const hidden = await listLibrary(ctx, ctx.workspaceSlug);
    expect(hidden.folders.map((f) => f.path)).not.toContain("gi-basic/build");
    expect(hidden.items.map((i) => i.path)).not.toContain("gi-basic/build/output.bin");
    expect(hidden.items.map((i) => i.path)).toContain("gi-basic/keep.txt");

    const shown = await listLibrary(ctx, ctx.workspaceSlug, { showHidden: true });
    expect(shown.folders.map((f) => f.path)).toContain("gi-basic/build");
    expect(shown.items.map((i) => i.path)).toContain("gi-basic/build/output.bin");
  });

  it("composes nested .gitignore files with their ancestors", async () => {
    const root = workspaceRootPath(ctx.home, ctx.workspaceSlug);
    const top = path.join(root, "gi-nested");
    await fs.mkdir(path.join(top, "child", "deep"), { recursive: true });
    await fs.mkdir(path.join(top, "child", "private"), { recursive: true });

    // Root rule fires for any *.log at any depth in the subtree.
    await fs.writeFile(path.join(top, ".gitignore"), "*.log\n");
    // Nested rule only hides this branch's `private/` dir; doesn't escape.
    await fs.writeFile(path.join(top, "child", ".gitignore"), "private/\n");

    await fs.writeFile(path.join(top, "child", "private", "secret.md"), "s");
    await fs.writeFile(path.join(top, "child", "deep", "trace.log"), "x");
    await fs.writeFile(path.join(top, "child", "deep", "notes.md"), "ok");

    const { items, folders } = await listLibrary(ctx, ctx.workspaceSlug);
    const itemPaths = items.map((i) => i.path);
    const folderPaths = folders.map((f) => f.path);

    expect(itemPaths).not.toContain("gi-nested/child/deep/trace.log");
    expect(itemPaths).toContain("gi-nested/child/deep/notes.md");
    expect(folderPaths).not.toContain("gi-nested/child/private");
    expect(itemPaths).not.toContain("gi-nested/child/private/secret.md");
  });
});

describe("validateLibrarySubpath", () => {
  it("accepts simple and nested paths and normalizes leading/trailing slashes", () => {
    expect(validateLibrarySubpath(undefined)).toBe("");
    expect(validateLibrarySubpath("")).toBe("");
    expect(validateLibrarySubpath("foo")).toBe("foo");
    expect(validateLibrarySubpath("foo/bar/baz")).toBe("foo/bar/baz");
    expect(validateLibrarySubpath("/foo/bar/")).toBe("foo/bar");
  });

  it("rejects traversal, dotfile, backslash, and empty segments", () => {
    expect(() => validateLibrarySubpath("../etc")).toThrow();
    expect(() => validateLibrarySubpath("foo/../bar")).toThrow();
    expect(() => validateLibrarySubpath(".hidden")).toThrow();
    expect(() => validateLibrarySubpath("foo//bar")).toThrow();
    expect(() => validateLibrarySubpath("foo\\bar")).toThrow();
  });
});

describe("createLibraryFolder", () => {
  it("creates nested folders and lists them back", async () => {
    const folder = await createLibraryFolder(ctx, ctx.workspaceSlug, "Empty/Nested");
    expect(folder.path).toBe("Empty/Nested");
    expect(folder.name).toBe("Nested");

    const { folders } = await listLibrary(ctx, ctx.workspaceSlug);
    const folderPaths = folders.map((f) => f.path);
    expect(folderPaths).toContain("Empty");
    expect(folderPaths).toContain("Empty/Nested");
  });

  it("rejects empty and invalid paths", async () => {
    await expect(
      createLibraryFolder(ctx, ctx.workspaceSlug, ""),
    ).rejects.toThrow();
    await expect(
      createLibraryFolder(ctx, ctx.workspaceSlug, "../escape"),
    ).rejects.toThrow();
  });
});

describe("moveLibraryEntry", () => {
  it("renames a file inside the same folder", async () => {
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "original.txt",
      mime: "text/plain",
      stream: makeStream("payload"),
      subpath: "MoveFile",
    });
    const to = "MoveFile/renamed.txt";
    const result = await moveLibraryEntry(ctx, ctx.workspaceSlug, "MoveFile/original.txt", to);
    expect(result.kind).toBe("file");
    expect(result.path).toBe(to);

    const abs = path.join(workspaceRootPath(ctx.home, ctx.workspaceSlug), "MoveFile", "renamed.txt");
    const stat = await fs.stat(abs);
    expect(stat.isFile()).toBe(true);
  });

  it("moves a folder with its contents", async () => {
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "inside.txt",
      mime: "text/plain",
      stream: makeStream("hi"),
      subpath: "MoveDir/Child",
    });
    const result = await moveLibraryEntry(ctx, ctx.workspaceSlug, "MoveDir", "MovedDir");
    expect(result.kind).toBe("folder");

    const { items, folders } = await listLibrary(ctx, ctx.workspaceSlug);
    expect(folders.map((f) => f.path)).toContain("MovedDir");
    expect(items.map((i) => i.path)).toContain("MovedDir/Child/inside.txt");
  });

  it("refuses to move a folder into its own descendant", async () => {
    await createLibraryFolder(ctx, ctx.workspaceSlug, "Cycle");
    await expect(
      moveLibraryEntry(ctx, ctx.workspaceSlug, "Cycle", "Cycle/Inner"),
    ).rejects.toThrow();
  });

  it("refuses to clobber an existing destination", async () => {
    await createLibraryFolder(ctx, ctx.workspaceSlug, "SrcA");
    await createLibraryFolder(ctx, ctx.workspaceSlug, "DstA");
    await expect(
      moveLibraryEntry(ctx, ctx.workspaceSlug, "SrcA", "DstA"),
    ).rejects.toThrow();
  });
});

describe("deleteLibraryEntry", () => {
  it("moves a folder (and its contents) to trash", async () => {
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "doomed.txt",
      mime: "text/plain",
      stream: makeStream("bye"),
      subpath: "Doomed",
    });
    const result = await deleteLibraryEntry(ctx, ctx.workspaceSlug, "Doomed");
    expect(result.kind).toBe("folder");

    const { folders } = await listLibrary(ctx, ctx.workspaceSlug);
    expect(folders.map((f) => f.path)).not.toContain("Doomed");

    const trashLib = path.join(trashDir(ctx.home), "library");
    const trashEntries = await fs.readdir(trashLib);
    expect(trashEntries.some((n) => n.includes("Doomed"))).toBe(true);
  });

  it("refuses to delete the workspace library root", async () => {
    await expect(
      deleteLibraryEntry(ctx, ctx.workspaceSlug, ""),
    ).rejects.toThrow();
  });
});
