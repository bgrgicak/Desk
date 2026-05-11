import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("sandbox CLI bundle", () => {
  it("runs the packaged desk-agent entrypoint and find artifacts alias", async () => {
    await execFileAsync(process.execPath, ["build.mjs"], { cwd: packageDir });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-agent-cli-smoke-"));
    const standalonePath = path.join(tmpDir, "desk-agent.js");
    await fs.copyFile(path.join(packageDir, "dist", "desk.js"), standalonePath);

    const { stdout } = await execFileAsync(process.execPath, [
      standalonePath,
      "find",
      "artifacts",
      "--help",
    ]);

    expect(stdout).toContain("desk-agent find library");
    expect(stdout).toContain("discover reusable library apps");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
