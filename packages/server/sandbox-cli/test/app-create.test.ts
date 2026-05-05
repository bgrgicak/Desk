import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/commands/app-create.js";

const outputMock = vi.fn();

vi.mock("../src/index.js", () => ({
  output: (data: unknown) => outputMock(data),
}));

const here = path.dirname(fileURLToPath(import.meta.url));
// The real scaffold ships at packages/app-scaffold relative to repo root.
const SCAFFOLD_PATH = path.resolve(here, "..", "..", "..", "app-scaffold");

let homeDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  outputMock.mockReset();
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-app-create-"));
  prevHome = process.env.HOME;
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await fs.rm(homeDir, { recursive: true, force: true });
});

async function makeChatDir(chatId: string): Promise<void> {
  await fs.mkdir(path.join(homeDir, ".chats", chatId, "artifacts"), {
    recursive: true,
  });
}

describe("desk-agent app create", () => {
  it("clones the scaffold into ~/.chats/<chatId>/artifacts/<name>.app/ and substitutes the name", async () => {
    await makeChatDir("cht_a");
    await run(["--chat", "cht_a", "--template", SCAFFOLD_PATH, "my-todos"]);

    const target = path.join(homeDir, ".chats", "cht_a", "artifacts", "my-todos.app");

    const manifest = JSON.parse(
      await fs.readFile(path.join(target, "desk.app.json"), "utf-8"),
    );
    expect(manifest.name).toBe("my-todos");
    expect(manifest.displayName).toBe("my-todos");
    expect(Array.isArray(manifest.fragments)).toBe(true);

    // Structural pieces a buildable scaffold must ship.
    for (const rel of [
      "package.json",
      "vite.config.ts",
      "index.html",
      "src/main.tsx",
      "src/App.tsx",
      "src/index.css",
      "fragments/example/Component.tsx",
      "fragments/example/main.tsx",
      "fragments/example/index.html",
      "fragments/example/desk.fragment.json",
      "fragments/example/skill.md",
      "AGENTS.md",
    ]) {
      const p = path.join(target, rel);
      const stat = await fs.stat(p);
      expect(stat.isFile(), `expected ${rel} to be a file`).toBe(true);
    }

    expect(outputMock).toHaveBeenCalledWith({
      name: "my-todos",
      path: target,
      chatId: "cht_a",
    });
  });

  it("rejects an invalid name without writing anything", async () => {
    await expect(
      run(["--chat", "cht_a", "--template", SCAFFOLD_PATH, "Invalid Name"]),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });

    const chats = path.join(homeDir, ".chats");
    await expect(fs.stat(chats)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("errors with CHAT_NOT_FOUND when the chat artifacts dir doesn't exist", async () => {
    // Mistyped --chat is an upstream typo; surface it instead of silently
    // creating files under a nonsense path.
    await expect(
      run(["--chat", "cht_typo", "--template", SCAFFOLD_PATH, "my-todos"]),
    ).rejects.toMatchObject({ code: "CHAT_NOT_FOUND" });
  });

  it("refuses to clobber an existing app directory", async () => {
    await makeChatDir("cht_a");
    await run(["--chat", "cht_a", "--template", SCAFFOLD_PATH, "my-app"]);
    await expect(
      run(["--chat", "cht_a", "--template", SCAFFOLD_PATH, "my-app"]),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("errors with TEMPLATE_NOT_FOUND when the scaffold path does not exist", async () => {
    const missing = path.join(homeDir, "nope");
    await expect(
      run(["--chat", "cht_a", "--template", missing, "x"]),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("rejects missing --chat or missing name", async () => {
    await expect(run(["--template", SCAFFOLD_PATH, "x"])).rejects.toThrow(/Missing --chat/);
    await expect(run(["--chat", "cht_a", "--template", SCAFFOLD_PATH])).rejects.toThrow(/Missing <name>/);
  });

  it("safety net: rejects a template with an unsubstituted __APP_NAME__ marker", async () => {
    // Construct a fake template that adds a new file containing the marker.
    // The substitution list in app-create.ts only enumerates three files —
    // anything else with a marker should fail loudly so a future scaffold
    // change can't silently ship `__APP_NAME__` to users.
    await makeChatDir("cht_a");
    const fakeTemplate = await fs.mkdtemp(path.join(os.tmpdir(), "fake-tpl-"));
    await fs.cp(SCAFFOLD_PATH, fakeTemplate, { recursive: true });
    await fs.writeFile(
      path.join(fakeTemplate, "untracked-file.md"),
      "Hi, __APP_NAME__!",
      "utf-8",
    );
    try {
      await expect(
        run(["--chat", "cht_a", "--template", fakeTemplate, "my-app"]),
      ).rejects.toMatchObject({ code: "SCAFFOLD_BUG" });
    } finally {
      await fs.rm(fakeTemplate, { recursive: true, force: true });
    }
  });

  it("removes the partially copied app when scaffold validation fails", async () => {
    await makeChatDir("cht_a");
    const fakeTemplate = await fs.mkdtemp(path.join(os.tmpdir(), "fake-tpl-"));
    await fs.cp(SCAFFOLD_PATH, fakeTemplate, { recursive: true });
    await fs.writeFile(
      path.join(fakeTemplate, "untracked-file.md"),
      "Hi, __APP_NAME__!",
      "utf-8",
    );

    const target = path.join(homeDir, ".chats", "cht_a", "artifacts", "my-app.app");
    try {
      await expect(
        run(["--chat", "cht_a", "--template", fakeTemplate, "my-app"]),
      ).rejects.toMatchObject({ code: "SCAFFOLD_BUG" });
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(fakeTemplate, { recursive: true, force: true });
    }
  });
});
