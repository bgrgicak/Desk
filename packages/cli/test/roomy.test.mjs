import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectMonorepo, ensureRoomyHome, resolvePublishedApiEntry, resolveAppDist, augmentPath } from "../src/roomy.mjs";

const ROOMY_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/roomy.mjs");

describe("detectMonorepo", () => {
  let tmpRoot;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "roomy-cli-test-"));
  });

  afterAll(async () => {
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns the workspace root when invoked from packages/cli/", () => {
    // Simulate the in-monorepo layout: <root>/package.json with name=roomy
    // and workspaces, plus a packages/cli/ dir under it.
    const root = path.join(tmpRoot, "monorepo-shape");
    fs.mkdirSync(path.join(root, "packages", "cli"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "roomy", workspaces: ["packages/*"] }),
    );
    expect(detectMonorepo(path.join(root, "packages", "cli"))).toBe(root);
  });

  it("returns null when invoked from a node_modules install location", () => {
    // Simulate a published install: <home>/lib/node_modules/@roomy-ai/cli/
    // walking up two levels lands at <home>/lib, no `roomy` package.json.
    const installRoot = path.join(tmpRoot, "fake-install", "lib", "node_modules");
    const cliPkgRoot = path.join(installRoot, "@roomy-ai", "cli");
    fs.mkdirSync(cliPkgRoot, { recursive: true });
    fs.writeFileSync(
      path.join(cliPkgRoot, "package.json"),
      JSON.stringify({ name: "@roomy-ai/cli", version: "0.1.0-alpha.0" }),
    );
    expect(detectMonorepo(cliPkgRoot)).toBeNull();
  });

  it("returns null when the candidate root has a different name", () => {
    const root = path.join(tmpRoot, "wrong-name");
    fs.mkdirSync(path.join(root, "packages", "cli"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "some-other-thing", workspaces: ["packages/*"] }),
    );
    expect(detectMonorepo(path.join(root, "packages", "cli"))).toBeNull();
  });

  it("returns null when the candidate root has no workspaces array", () => {
    const root = path.join(tmpRoot, "no-workspaces");
    fs.mkdirSync(path.join(root, "packages", "cli"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "roomy" }),
    );
    expect(detectMonorepo(path.join(root, "packages", "cli"))).toBeNull();
  });
});

describe("ensureRoomyHome", () => {
  // Regression: an earlier version returned `$HOME` (the parent) while
  // creating `$HOME/Roomy` — the server then wrote db/backups/memory/skills
  // directly under $HOME. The contract is: the returned path is the data
  // root, and it exists on disk afterwards.
  it("returns ROOMY_HOME verbatim when set, and creates the directory", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "roomyhome-env-"));
    const target = path.join(tmp, "custom-root");
    const prev = process.env.ROOMY_HOME;
    process.env.ROOMY_HOME = target;
    try {
      const home = await ensureRoomyHome();
      expect(home).toBe(target);
      expect(fs.existsSync(home)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ROOMY_HOME;
      else process.env.ROOMY_HOME = prev;
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

describe("augmentPath", () => {
  it("prepends Homebrew and linuxbrew paths when missing", () => {
    const result = augmentPath("/usr/bin:/bin:/usr/sbin:/sbin");
    const parts = result.split(":");
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/home/linuxbrew/.linuxbrew/bin");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
  });

  it("does not duplicate entries already present", () => {
    const result = augmentPath("/usr/local/bin:/usr/bin:/bin");
    const parts = result.split(":");
    expect(parts.filter((p) => p === "/usr/local/bin").length).toBe(1);
  });

  it("treats undefined the same as the minimal daemon PATH", () => {
    const result = augmentPath(undefined);
    const parts = result.split(":");
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
  });

  it("preserves extras already in PATH without duplication", () => {
    const result = augmentPath("/opt/homebrew/bin:/usr/bin:/bin");
    const parts = result.split(":");
    expect(parts.filter((p) => p === "/opt/homebrew/bin").length).toBe(1);
    expect(parts).toContain("/usr/local/bin");
  });
});

describe("roomy service update", () => {
  it("routes to the same update logic as roomy update (monorepo guard fires)", () => {
    // Both `roomy update` and `roomy service update` should refuse when run
    // inside the monorepo checkout, exiting with code 2.
    const direct = spawnSync(process.execPath, [ROOMY_BIN, "update"], {
      encoding: "utf-8",
    });
    const viaService = spawnSync(process.execPath, [ROOMY_BIN, "service", "update"], {
      encoding: "utf-8",
    });
    expect(direct.status).toBe(2);
    expect(viaService.status).toBe(2);
    expect(viaService.stderr).toContain("use `git pull");
  });

  it("passes --tag and --skip-restart flags through from service update", () => {
    // Still hits the monorepo guard first (exit 2), but with a different
    // message — confirms args forwarding doesn't crash before the guard.
    const result = spawnSync(
      process.execPath,
      [ROOMY_BIN, "service", "update", "--tag=beta", "--skip-restart"],
      { encoding: "utf-8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("use `git pull");
  });
});
