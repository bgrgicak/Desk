import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The fingerprint script is the source of truth for "did the sandbox
// image's inputs change". We exercise it against a fixture repo on disk
// so the test doesn't depend on docker, npm, or the real workspace.
const FINGERPRINT_SCRIPT = resolve(
  __dirname,
  "../../setup/scripts/sandbox-fingerprint.sh",
);

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "desk-fp-"));
  mkdirSync(join(root, "packages/server/sandbox-cli/src"), { recursive: true });
  mkdirSync(join(root, "packages/server/runtime"), { recursive: true });
  mkdirSync(join(root, "packages/ui/src"), { recursive: true });
  mkdirSync(join(root, "packages/app-scaffold/fragments/example"), {
    recursive: true,
  });

  writeFileSync(
    join(root, "packages/server/sandbox-cli/src/index.ts"),
    "export const v = 1;\n",
  );
  writeFileSync(
    join(root, "packages/server/sandbox-cli/build.mjs"),
    "// fixture build script\n",
  );
  writeFileSync(
    join(root, "packages/server/sandbox-cli/package.json"),
    '{"name":"@agent-desk/sandbox-cli"}\n',
  );
  writeFileSync(
    join(root, "packages/server/runtime/Dockerfile.sandbox"),
    "FROM node:23-slim\n",
  );
  writeFileSync(
    join(root, "packages/ui/package.json"),
    '{"name":"@agent-desk/ui"}\n',
  );
  writeFileSync(
    join(root, "packages/ui/src/index.ts"),
    "export const Button = 'button';\n",
  );
  writeFileSync(
    join(root, "packages/app-scaffold/desk.app.json"),
    '{"name":"app"}\n',
  );
  writeFileSync(
    join(root, "packages/app-scaffold/src.ts"),
    "export const scaffold = true;\n",
  );
  writeFileSync(
    join(root, "packages/app-scaffold/fragments/example/desk.fragment.json"),
    '{"name":"frag"}\n',
  );
  return root;
}

function fingerprint(root: string): string {
  return execFileSync("bash", [FINGERPRINT_SCRIPT, root], {
    encoding: "utf8",
  }).trim();
}

describe("sandbox-fingerprint.sh", () => {
  let root: string;

  beforeEach(() => {
    root = makeFixtureRepo();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns a sha256-shaped hex digest", () => {
    const fp = fingerprint(root);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable when sources don't change", () => {
    expect(fingerprint(root)).toBe(fingerprint(root));
  });

  it("changes when a sandbox-cli source file changes", () => {
    const before = fingerprint(root);
    writeFileSync(
      join(root, "packages/server/sandbox-cli/src/index.ts"),
      "export const v = 2;\n",
    );
    expect(fingerprint(root)).not.toBe(before);
  });

  it("changes when the Dockerfile changes", () => {
    const before = fingerprint(root);
    writeFileSync(
      join(root, "packages/server/runtime/Dockerfile.sandbox"),
      "FROM node:23-slim\nRUN echo hi\n",
    );
    expect(fingerprint(root)).not.toBe(before);
  });

  it("changes when an app-scaffold manifest changes", () => {
    const before = fingerprint(root);
    writeFileSync(
      join(root, "packages/app-scaffold/desk.app.json"),
      '{"name":"app","displayName":"App"}\n',
    );
    expect(fingerprint(root)).not.toBe(before);
  });

  it("changes when app-scaffold source changes", () => {
    const before = fingerprint(root);
    writeFileSync(
      join(root, "packages/app-scaffold/src.ts"),
      "export const scaffold = false;\n",
    );
    expect(fingerprint(root)).not.toBe(before);
  });

  it("changes when UI package source changes", () => {
    const before = fingerprint(root);
    writeFileSync(
      join(root, "packages/ui/src/index.ts"),
      "export const Button = 'updated';\n",
    );
    expect(fingerprint(root)).not.toBe(before);
  });

  it("changes when sandbox-cli package metadata changes", () => {
    const before = fingerprint(root);
    writeFileSync(
      join(root, "packages/server/sandbox-cli/package.json"),
      '{"name":"@agent-desk/sandbox-cli","dependencies":{"x":"1.0.0"}}\n',
    );
    expect(fingerprint(root)).not.toBe(before);
  });

  it("changes when a new sandbox-cli source file is added", () => {
    const before = fingerprint(root);
    writeFileSync(
      join(root, "packages/server/sandbox-cli/src/extra.ts"),
      "export const x = 1;\n",
    );
    expect(fingerprint(root)).not.toBe(before);
  });

  it("ignores files outside the tracked set", () => {
    const before = fingerprint(root);
    // README in the package root shouldn't influence the fingerprint.
    writeFileSync(
      join(root, "packages/server/sandbox-cli/README.md"),
      "# unrelated\n",
    );
    expect(fingerprint(root)).toBe(before);
  });
});
