import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectMonorepo, ensureDeskHome, resolvePublishedApiEntry, resolveAppDist } from "../src/desk.mjs";

describe("detectMonorepo", () => {
  let tmpRoot;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "desk-cli-test-"));
  });

  afterAll(async () => {
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns the workspace root when invoked from packages/agent-desk-cli/", () => {
    // Simulate the in-monorepo layout: <root>/package.json with name=desk
    // and workspaces, plus a packages/agent-desk-cli/ dir under it.
    const root = path.join(tmpRoot, "monorepo-shape");
    fs.mkdirSync(path.join(root, "packages", "agent-desk-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "desk", workspaces: ["packages/*"] }),
    );
    expect(detectMonorepo(path.join(root, "packages", "agent-desk-cli"))).toBe(root);
  });

  it("returns null when invoked from a node_modules install location", () => {
    // Simulate a published install: <home>/lib/node_modules/@agent-desk/cli/
    // walking up two levels lands at <home>/lib, no `desk` package.json.
    const installRoot = path.join(tmpRoot, "fake-install", "lib", "node_modules");
    const cliPkgRoot = path.join(installRoot, "@agent-desk", "cli");
    fs.mkdirSync(cliPkgRoot, { recursive: true });
    fs.writeFileSync(
      path.join(cliPkgRoot, "package.json"),
      JSON.stringify({ name: "@agent-desk/cli", version: "0.1.0-alpha.0" }),
    );
    expect(detectMonorepo(cliPkgRoot)).toBeNull();
  });

  it("returns null when the candidate root has a different name", () => {
    const root = path.join(tmpRoot, "wrong-name");
    fs.mkdirSync(path.join(root, "packages", "agent-desk-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "some-other-thing", workspaces: ["packages/*"] }),
    );
    expect(detectMonorepo(path.join(root, "packages", "agent-desk-cli"))).toBeNull();
  });

  it("returns null when the candidate root has no workspaces array", () => {
    const root = path.join(tmpRoot, "no-workspaces");
    fs.mkdirSync(path.join(root, "packages", "agent-desk-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "desk" }),
    );
    expect(detectMonorepo(path.join(root, "packages", "agent-desk-cli"))).toBeNull();
  });
});

describe("ensureDeskHome", () => {
  // Regression: an earlier version returned `$HOME` (the parent) while
  // creating `$HOME/Desk` — the server then wrote db/backups/memory/skills
  // directly under $HOME. The contract is: the returned path is the data
  // root, and it exists on disk afterwards.
  it("returns DESK_HOME verbatim when set, and creates the directory", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "deskhome-env-"));
    const target = path.join(tmp, "custom-root");
    const prev = process.env.DESK_HOME;
    process.env.DESK_HOME = target;
    try {
      const home = await ensureDeskHome();
      expect(home).toBe(target);
      expect(fs.existsSync(home)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DESK_HOME;
      else process.env.DESK_HOME = prev;
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolvePublishedApiEntry / resolveAppDist", () => {
  // Inside the monorepo, both packages exist as workspace symlinks. The
  // resolver returns the dist path if dist/main.js (or dist/index.html
  // for the app) is present from a prior build, else null. The exact
  // truthiness depends on whether `npm run build` has been run; what
  // matters is that the function never throws and returns a string-or-
  // null type.
  it("resolvePublishedApiEntry returns null or an absolute path to main.js", () => {
    const result = resolvePublishedApiEntry();
    if (result !== null) {
      expect(path.isAbsolute(result)).toBe(true);
      expect(result.endsWith("dist/main.js") || result.endsWith("dist\\main.js")).toBe(true);
    }
  });

  it("resolveAppDist returns null or an absolute path with index.html", () => {
    const result = resolveAppDist();
    if (result !== null) {
      expect(path.isAbsolute(result)).toBe(true);
      expect(fs.existsSync(path.join(result, "index.html"))).toBe(true);
    }
  });
});
