/**
 * Unit tests for the engine module.
 *
 * The CLI shim itself is exercised by integration tests under
 * `test/integration/sandbox.test.ts` (real docker / nerdctl). What this file
 * pins down is the small bit of pure logic that doesn't need a daemon:
 * detection ordering and the rejected-name preservation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { detectEngine, _resetEngineCache, _wrapExecChildForTest, type EngineName } from "../src/engine.js";

const PRIOR_OVERRIDE = process.env.DESK_CONTAINER_ENGINE;
const PRIOR_PATH = process.env.PATH;

beforeEach(() => {
  _resetEngineCache();
});

afterEach(() => {
  if (PRIOR_OVERRIDE === undefined) delete process.env.DESK_CONTAINER_ENGINE;
  else process.env.DESK_CONTAINER_ENGINE = PRIOR_OVERRIDE;
  process.env.PATH = PRIOR_PATH;
  _resetEngineCache();
});

describe("detectEngine — DESK_CONTAINER_ENGINE override", () => {
  it("honors a docker override when docker is reachable", async () => {
    if (!(await binaryWorks("docker"))) {
      // Skip cleanly when neither runtime is present on the host.
      return;
    }
    process.env.DESK_CONTAINER_ENGINE = "docker";
    const engine = await detectEngine();
    expect(engine.name).toBe<EngineName>("docker");
  });

  it("honors a nerdctl override when nerdctl is reachable", async () => {
    if (!(await binaryWorks("nerdctl"))) return;
    process.env.DESK_CONTAINER_ENGINE = "nerdctl";
    const engine = await detectEngine();
    expect(engine.name).toBe<EngineName>("nerdctl");
  });

  it("throws a descriptive error when no runtime is available", async () => {
    // Neutralise PATH so neither binary can be found.
    process.env.PATH = "/nonexistent";
    delete process.env.DESK_CONTAINER_ENGINE;
    await expect(detectEngine()).rejects.toThrow(/No container runtime/);
  });
});

describe("exec handle stream lifecycle", () => {
  it("does not resolve wait() on exit before stdout/stderr have closed", async () => {
    const child = new EventEmitter() as NodeJS.EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {};

    const handle = _wrapExecChildForTest(child as never);
    const chunks: Buffer[] = [];
    handle.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    let resolved = false;
    const wait = handle.wait().then((code) => {
      resolved = true;
      return code;
    });

    child.emit("exit", 0);
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.stdout.write("late stdout");
    child.stdout.end();
    child.stderr.end();
    child.exitCode = 0;
    child.emit("close", 0);

    await expect(wait).resolves.toBe(0);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("late stdout");
  });
});

/** True if `<bin> info` exits 0 — same probe detectEngine uses. */
async function binaryWorks(name: EngineName): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(
      name,
      ["info", "--format", "{{.ID}}"],
      {
        env:
          name === "nerdctl"
            ? { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}` }
            : process.env,
        stdio: "ignore",
        timeout: 3000,
        killSignal: "SIGKILL",
      },
    );
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, 3000);
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  });
}
