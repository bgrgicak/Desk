import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  augmentPath,
  defaultSandboxImage,
  detectMonorepo,
  ensureRoomyHome,
  packageVersion,
  parseUpdateArgs,
  resolveAppDist,
  resolvePublishedApiEntry,
  resolveSourceReleaseConfig,
  updateFromSource,
  validateSourceRoot,
} from "../src/roomy.mjs";

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

describe("defaultSandboxImage", () => {
  it("uses the package version tag instead of mutable latest", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomy-cli-image-"));
    try {
      await fsp.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "@roomy-ai/cli", version: "1.2.3" }),
      );
      expect(packageVersion(root)).toBe("1.2.3");
      expect(defaultSandboxImage(root)).toBe("bgrgicak/roomy-ai:1.2.3");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
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

describe("source update staging", () => {
  async function makeSourceRoot(root) {
    await fsp.mkdir(path.join(root, "packages", "server", "api"), { recursive: true });
    await fsp.mkdir(path.join(root, "packages", "server", "runtime"), { recursive: true });
    await fsp.mkdir(path.join(root, "packages", "app"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "roomy", workspaces: ["packages/server/*", "packages/app"] }),
    );
    await fsp.writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({ name: "roomy", lockfileVersion: 3, packages: { "": { name: "roomy" } } }),
    );
    await fsp.writeFile(
      path.join(root, "packages", "server", "api", "package.json"),
      JSON.stringify({ name: "@roomy-ai/api" }),
    );
    await fsp.writeFile(
      path.join(root, "packages", "app", "package.json"),
      JSON.stringify({ name: "@roomy-ai/app" }),
    );
    await fsp.writeFile(
      path.join(root, "packages", "server", "runtime", "Dockerfile.sandbox"),
      "FROM scratch\n",
    );
  }

  it("parses --source as a mode separate from npm tag updates", () => {
    expect(parseUpdateArgs(["--source", "/srv/rumi-dev", "--skip-restart"])).toMatchObject({
      mode: "source",
      source: "/srv/rumi-dev",
      skipRestart: true,
    });
    expect(() => parseUpdateArgs(["--source=/srv/rumi-dev", "--tag=preprod"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("validates the source root before staging a release", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "roomy-source-root-"));
    try {
      const source = path.join(tmp, "repo");
      await makeSourceRoot(source);
      expect(validateSourceRoot(source)).toBe(path.resolve(source));

      const wrong = path.join(tmp, "not-roomy");
      await fsp.mkdir(wrong, { recursive: true });
      await fsp.writeFile(path.join(wrong, "package.json"), JSON.stringify({ name: "other" }));
      expect(() => validateSourceRoot(wrong)).toThrow(/Roomy workspace root/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not move current or restart when the source build fails", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "roomy-source-fail-"));
    try {
      const home = path.join(tmp, "home");
      const source = path.join(tmp, "repo");
      const oldRelease = path.join(home, "releases", "old");
      const current = path.join(home, "current");
      await makeSourceRoot(source);
      await fsp.mkdir(oldRelease, { recursive: true });
      await fsp.mkdir(home, { recursive: true });
      await fsp.symlink(oldRelease, current, "dir");

      let restarted = false;
      await expect(updateFromSource({
        source,
        home,
        releaseId: "bad",
        currentLink: current,
        serviceInstalled: true,
        runSync(command, args) {
          if (command === "npm" && args.join(" ") === "run build") return { status: 1 };
          return { status: 0 };
        },
        restartService() {
          restarted = true;
        },
      })).rejects.toThrow(/npm run build failed/);

      expect(await fsp.readlink(current)).toBe(oldRelease);
      expect(restarted).toBe(false);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("builds in a staged release, switches current, and writes start config", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "roomy-source-ok-"));
    try {
      const home = path.join(tmp, "home");
      const source = path.join(tmp, "repo");
      const current = path.join(home, "current");
      const commands = [];
      let restarted = false;
      await makeSourceRoot(source);
      await updateFromSource({
        source,
        home,
        releaseId: "abc123",
        currentLink: current,
        serviceInstalled: true,
        now: () => "2026-06-01T10:00:00.000Z",
        runSync(command, args, options) {
          commands.push([command, args.join(" "), options.cwd]);
          if (command === "npm" && args.join(" ") === "run build") {
            fs.mkdirSync(path.join(options.cwd, "packages", "server", "api", "dist"), { recursive: true });
            fs.mkdirSync(path.join(options.cwd, "packages", "app", "dist"), { recursive: true });
            fs.writeFileSync(path.join(options.cwd, "packages", "server", "api", "dist", "main.js"), "");
            fs.writeFileSync(path.join(options.cwd, "packages", "app", "dist", "index.html"), "");
          }
          return { status: 0 };
        },
        restartService() {
          restarted = true;
        },
      });

      const releaseDir = await fsp.readlink(current);
      expect(releaseDir).toBe(path.join(home, "releases", "abc123"));
      expect(fs.existsSync(path.join(releaseDir, "packages", "server", "api", "dist", "main.js"))).toBe(true);
      expect(fs.existsSync(path.join(source, "packages", "server", "api", "dist", "main.js"))).toBe(false);
      expect(commands.map(([, args]) => args)).toContain("ci --include=optional --no-audit --no-fund");
      expect(commands.map(([, args]) => args)).toContain("run build");
      expect(restarted).toBe(true);

      const config = resolveSourceReleaseConfig(home);
      const realReleaseDir = fs.realpathSync(releaseDir);
      expect(config.apiEntry).toBe(path.join(realReleaseDir, "packages", "server", "api", "dist", "main.js"));
      expect(config.appDist).toBe(path.join(realReleaseDir, "packages", "app", "dist"));
      expect(config.sandboxImage).toBe("roomy/source:abc123");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("passes strict sandbox build env for source releases", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "roomy-source-strict-"));
    try {
      const home = path.join(tmp, "home");
      const source = path.join(tmp, "repo");
      let sandboxEnv;
      await makeSourceRoot(source);

      await updateFromSource({
        source,
        home,
        releaseId: "strict",
        serviceInstalled: false,
        runSync(command, args, options) {
          if (command === "npm" && args.join(" ") === "run build") {
            fs.mkdirSync(path.join(options.cwd, "packages", "server", "api", "dist"), { recursive: true });
            fs.mkdirSync(path.join(options.cwd, "packages", "app", "dist"), { recursive: true });
            fs.writeFileSync(path.join(options.cwd, "packages", "server", "api", "dist", "main.js"), "");
            fs.writeFileSync(path.join(options.cwd, "packages", "app", "dist", "index.html"), "");
          }
          if (command === "bash" && args[0].endsWith("ensure-sandbox-image.sh")) {
            sandboxEnv = options.env;
          }
          return { status: 0 };
        },
      });

      expect(sandboxEnv).toMatchObject({
        ROOMY_SANDBOX_IMAGE: "roomy/source:strict",
        ROOMY_SANDBOX_STRICT: "1",
      });
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
