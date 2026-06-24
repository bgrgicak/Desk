import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import {
  bindsSatisfy,
  classifyResourceError,
  providerKeyEnv,
  providerKeyExecEnv,
  stopRunningSandboxes,
  waitForEntrypointReady,
} from "../src/docker.js";
import type { Engine, ExecHandle, ExecSpec, ContainerInfo } from "../src/engine.js";

describe("classifyResourceError", () => {
  it("returns null for a successful exit", () => {
    expect(classifyResourceError(0, "anything")).toBeNull();
    expect(classifyResourceError(0, "spawn EAGAIN")).toBeNull();
  });

  it("classifies exit 137 as a memory failure (cgroup OOM-kill)", () => {
    // The cgroup memory-controller OOM-killer sends SIGKILL to processes
    // over the limit; nothing else routinely produces 137 on a CLI we
    // own, so we treat it as an OOM signal without needing a string
    // match in stderr (which the killed process may not have flushed).
    expect(classifyResourceError(137, "")).toBe("memory");
  });

  it("classifies `spawn EAGAIN` as a pids failure", () => {
    // The Bun/Node spawn-EAGAIN message indicates the kernel refused
    // fork(2) because the pids cgroup is exhausted. Matched
    // case-insensitively because Bun's wrapping varies.
    expect(
      classifyResourceError(1, "spawn /usr/local/bin/.pi EAGAIN"),
    ).toBe("pids");
    expect(classifyResourceError(1, "SPAWN ... EAGAIN")).toBe("pids");
  });

  it("classifies POSIX 'resource temporarily unavailable' as pids", () => {
    expect(
      classifyResourceError(1, "fork: Resource temporarily unavailable"),
    ).toBe("pids");
  });

  it("classifies ENOMEM / out-of-memory wording as memory", () => {
    expect(classifyResourceError(1, "Bun panic: out of memory")).toBe("memory");
    expect(classifyResourceError(1, "malloc: ENOMEM")).toBe("memory");
    expect(classifyResourceError(1, "fatal: cannot allocate memory")).toBe(
      "memory",
    );
  });

  it("returns null for unrelated failures so we don't retry-loop on them", () => {
    // A model API auth error, a tool's permission denied, etc. must
    // not be classified as resource — we'd retry forever and grow the
    // sandbox to the max for no reason.
    expect(classifyResourceError(1, "permission denied")).toBeNull();
    expect(classifyResourceError(1, "API key invalid")).toBeNull();
    expect(
      classifyResourceError(2, "TypeError: cannot read properties of undefined"),
    ).toBeNull();
  });

  it("classifies setsid 'did not exit normally' as memory (OOM via wrapper)", () => {
    // The setsid wrapper around pi reports a signal-killed child as
    // `setsid: child <pid> did not exit normally: Success` and itself
    // exits 1 — so a cgroup OOM-kill never reaches us as the canonical
    // exit 137. The auto-grow path has to recognise this stderr or it
    // does nothing for the most common death mode in a memory-pressured
    // sandbox.
    expect(
      classifyResourceError(1, "setsid: child 6638 did not exit normally: Success"),
    ).toBe("memory");
    expect(
      classifyResourceError(1, "setsid: child 12345 did not exit normally: Success\n"),
    ).toBe("memory");
  });
});

describe("bindsSatisfy — exact semantics for mount drift", () => {
  const workspace = "/home/bero/Roomy/proj:/home/agent:rw";
  const skills = "/home/bero/Roomy/.skills:/opt/roomy-skills:ro";
  const projectsLocal = "/home/bero/Projects:/home/agent/Projects:rw";
  const downloadsLocal = "/home/bero/Downloads:/home/agent/Downloads:ro";

  it("accepts exact-match (same set on both sides)", () => {
    expect(bindsSatisfy([workspace, skills], [workspace, skills])).toBe(true);
  });

  it("rejects extras in actual beyond what expected requires", () => {
    // Revoked local-filesystem grants must not survive as extra binds in
    // a warm container. Reuse is safe only when the live bind set exactly
    // matches the current mount plan.
    expect(
      bindsSatisfy(
        [workspace, skills, projectsLocal, downloadsLocal],
        [workspace, skills],
      ),
    ).toBe(false);
  });

  it("rejects when an expected mount is missing", () => {
    // The caller's required workspace mount is absent → real drift.
    expect(
      bindsSatisfy([skills, projectsLocal], [workspace, skills]),
    ).toBe(false);
  });

  it("rejects when an expected mount has a different host source", () => {
    // Same target (/home/agent) but a different host path means the
    // container is pointed at the wrong workspace dir on disk.
    expect(
      bindsSatisfy(
        ["/home/bero/Roomy/OTHER:/home/agent:rw", skills],
        [workspace, skills],
      ),
    ).toBe(false);
  });

  it("treats undefined actual as no mounts (empty expected still satisfied)", () => {
    expect(bindsSatisfy(undefined, [])).toBe(true);
    expect(bindsSatisfy(undefined, [workspace])).toBe(false);
  });

  it("is order-insensitive — Docker reports binds in arbitrary order", () => {
    expect(
      bindsSatisfy([skills, workspace], [workspace, skills]),
    ).toBe(true);
  });
});

describe("providerKeyEnv", () => {
  it("does not fall back to host process provider keys", () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "host-openai-key";
    try {
      expect(providerKeyEnv()).not.toContain("OPENAI_API_KEY=host-openai-key");
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });

  it("requires explicit opt-in before forwarding provider keys as sandbox env", () => {
    const previous = process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    try {
      expect(providerKeyEnv({ OPENAI_API_KEY: "sk-test" })).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
      else process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = previous;
    }
  });

  it("forwards explicit provider keys when raw sandbox credential env is opted in", () => {
    const previous = process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = "1";
    try {
      expect(providerKeyEnv({
        OPENAI_API_KEY: "sk-test",
        NOT_ALLOWED: "nope",
      })).toEqual([
        "OPENAI_API_KEY=sk-test",
      ]);
    } finally {
      if (previous === undefined) delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
      else process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = previous;
    }
  });

  it("keeps sandbox connection tokens out of create-time container env", () => {
    const previous = process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = "1";
    try {
      expect(providerKeyEnv({
        OPENAI_API_KEY: "sk-test",
        GITHUB_TOKEN: "github_pat_test",
        NOT_ALLOWED: "nope",
      })).toEqual([
        "OPENAI_API_KEY=sk-test",
      ]);
    } finally {
      if (previous === undefined) delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
      else process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = previous;
    }
  });
});

describe("providerKeyExecEnv", () => {
  it("does not forward host GitHub tokens without explicit vault-backed keys", () => {
    const previousGitHubToken = process.env.GITHUB_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "host-github-token";
    process.env.GH_TOKEN = "host-gh-token";
    try {
      const env = providerKeyExecEnv();

      expect(env).not.toContain("GITHUB_TOKEN=host-github-token");
      expect(env).not.toContain("GH_TOKEN=host-gh-token");
    } finally {
      if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHubToken;
      if (previousGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
    }
  });

  it("forwards GitHub connection tokens per exec alongside model provider keys", () => {
    const previous = process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = "1";
    try {
      const env = providerKeyExecEnv({
        OPENAI_API_KEY: "sk-test",
        GITHUB_TOKEN: "github_pat_test",
        NOT_ALLOWED: "nope",
      });
      expect(env).toContain("GITHUB_TOKEN=github_pat_test");
      expect(env).toContain("GH_TOKEN=github_pat_test");
    } finally {
      if (previous === undefined) delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
      else process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = previous;
    }
  });

  it("clears missing connection keys so warm sandboxes cannot reuse deleted tokens", () => {
    const previous = process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = "1";
    try {
      const env = providerKeyExecEnv({ OPENAI_API_KEY: "sk-test" });

      expect(env).toContain("OPENAI_API_KEY=sk-test");
      expect(env).toContain("GITHUB_TOKEN=");
      expect(env).toContain("GH_TOKEN=");
    } finally {
      if (previous === undefined) delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
      else process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = previous;
    }
  });

  it("clears managed env names even when raw credential forwarding is not opted in", () => {
    const previous = process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    try {
      const env = providerKeyExecEnv({ OPENAI_API_KEY: "sk-test" });

      expect(env).not.toContain("OPENAI_API_KEY=sk-test");
      expect(env).toContain("OPENAI_API_KEY=");
      expect(env).toContain("GITHUB_TOKEN=");
      expect(env).toContain("GH_TOKEN=");
    } finally {
      if (previous === undefined) delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
      else process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = previous;
    }
  });

  it("does not let extra env override managed connection credentials", () => {
    const previous = process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = "1";
    try {
      const env = providerKeyExecEnv(
        { OPENAI_API_KEY: "sk-test" },
        { GITHUB_TOKEN: "stale", GH_TOKEN: "stale", PI_AUTH_JSON_BASE64: "codex" },
      );

      expect(env).not.toContain("GITHUB_TOKEN=stale");
      expect(env).not.toContain("GH_TOKEN=stale");
      expect(env).toContain("GITHUB_TOKEN=");
      expect(env).toContain("GH_TOKEN=");
      expect(env).toContain("PI_AUTH_JSON_BASE64=codex");
    } finally {
      if (previous === undefined) delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
      else process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = previous;
    }
  });
});

describe("stopRunningSandboxes", () => {
  function engineWithSandboxes(opts: {
    names: string[];
    failStop?: string;
    bindsByName?: Record<string, string[]>;
  }): Engine & { stopped: string[] } {
    const stopped: string[] = [];
    return {
      name: "docker",
      inspect: async (nameOrId: string) => {
        const name = opts.names.find((n) => n === nameOrId || `${n}-id` === nameOrId);
        if (!name) return null;
        return {
          id: `${name}-id`,
          imageId: "sha256:test",
          user: "0:0",
          labels: {},
          binds: opts.bindsByName?.[name] ?? [],
          running: true,
        } satisfies ContainerInfo;
      },
      imageId: async () => null,
      imagePull: async () => {},
      create: async () => "",
      start: async () => {},
      stop: async (nameOrId: string) => {
        if (nameOrId === opts.failStop) throw new Error("stop failed");
        stopped.push(nameOrId);
      },
      update: async () => true,
      remove: async () => {},
      list: async ({ namePrefix }) => opts.names
        .filter((name) => !namePrefix || name.startsWith(namePrefix))
        .map((name) => ({ id: `${name}-id`, name })),
      exec: async () => {
        throw new Error("not used");
      },
      execDetached: async () => {},
      port: async () => null,
      top: async () => [],
      isRootless: async () => false,
      stopped,
    };
  }

  it("stops every running Roomy sandbox returned by the engine", async () => {
    const engine = engineWithSandboxes({
      names: ["roomy-sandbox-wks_a", "roomy-sandbox-wks_b", "other"],
    });

    await expect(stopRunningSandboxes({ engine })).resolves.toEqual([
      "roomy-sandbox-wks_a",
      "roomy-sandbox-wks_b",
    ]);
    expect(engine.stopped).toEqual([
      "roomy-sandbox-wks_a",
      "roomy-sandbox-wks_b",
    ]);
  });

  it("continues stopping other sandboxes when one stop fails", async () => {
    const engine = engineWithSandboxes({
      names: ["roomy-sandbox-wks_a", "roomy-sandbox-wks_b"],
      failStop: "roomy-sandbox-wks_a",
    });

    await expect(stopRunningSandboxes({ engine })).resolves.toEqual([
      "roomy-sandbox-wks_b",
    ]);
    expect(engine.stopped).toEqual(["roomy-sandbox-wks_b"]);
  });

  it("limits shutdown cleanup to sandboxes mounted under the current ROOMY_HOME", async () => {
    const home = "/Users/tester/Roomy";
    const otherHome = "/tmp/other-roomy";
    const engine = engineWithSandboxes({
      names: ["roomy-sandbox-wks_a", "roomy-sandbox-wks_b"],
      bindsByName: {
        "roomy-sandbox-wks_a": [`${home}/alpha:/home/agent:rw`],
        "roomy-sandbox-wks_b": [`${otherHome}/beta:/home/agent:rw`],
      },
    });

    await expect(stopRunningSandboxes({ engine, home })).resolves.toEqual([
      "roomy-sandbox-wks_a",
    ]);
    expect(engine.stopped).toEqual(["roomy-sandbox-wks_a"]);
  });
});


describe("waitForEntrypointReady", () => {
  // Drive the container-gone fast-bail path. A live repro showed that
  // when the sandbox container is removed mid-poll (drift recreate,
  // reaper, parallel rm -f), every `docker exec` returns exit 1 with
  // stderr "No such container: <id>". Without this fast bail, the loop
  // hangs for the full 5 minutes before reporting a timeout — that's
  // the wedge users were seeing in cht_*.

  function engineWithExec(handler: (cmd: string[]) => { code: number; stderr?: string }): Engine {
    return {
      name: "docker",
      inspect: async () => null,
      imageId: async () => null,
      imagePull: async () => {},
      create: async () => "",
      start: async () => {},
      stop: async () => {},
      update: async () => true,
      remove: async () => {},
      list: async () => [],
      exec: async (spec: ExecSpec) => {
        const { code, stderr: stderrText } = handler(spec.cmd);
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        // Defer the writes through setImmediate to mimic real-process
        // ordering, but make wait() block on it so the caller sees the
        // stderr chunk before reading the exit code.
        const drained = new Promise<void>((resolve) => {
          setImmediate(() => {
            if (stderrText) stderr.write(stderrText);
            stdout.end();
            stderr.end();
            resolve();
          });
        });
        return {
          stdout,
          stderr,
          wait: async () => {
            await drained;
            return code;
          },
          cancel: async () => {},
        } as ExecHandle;
      },
      execDetached: async () => {},
      port: async () => null,
      top: async () => [],
      isRootless: async () => false,
    };
  }

  it("returns once the entrypoint marker exists", async () => {
    const engine = engineWithExec(() => ({ code: 0 }));
    await expect(waitForEntrypointReady(engine, "id-ok", 5_000)).resolves.toBeUndefined();
  });

  it("bails immediately when stderr says the container is gone", async () => {
    let calls = 0;
    const engine = engineWithExec(() => {
      calls++;
      return {
        code: 1,
        stderr: "Error response from daemon: No such container: 4118b44d870701f0",
      };
    });
    const start = Date.now();
    await expect(waitForEntrypointReady(engine, "4118b44d", 60_000)).rejects.toThrow(
      /no longer present/i,
    );
    const elapsed = Date.now() - start;
    // Bail on the first poll — well under the 60s test ceiling.
    expect(elapsed).toBeLessThan(2_000);
    expect(calls).toBe(1);
  });

  it("bails immediately when Docker says the container is not running", async () => {
    let calls = 0;
    const engine = engineWithExec(() => {
      calls++;
      return {
        code: 1,
        stderr: "Error response from daemon: container 4118b44d870701f0 is not running",
      };
    });
    const start = Date.now();
    await expect(waitForEntrypointReady(engine, "4118b44d", 60_000)).rejects.toThrow(
      /no longer present/i,
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(calls).toBe(1);
  });

  it("keeps polling on non-container-gone errors until ready", async () => {
    let calls = 0;
    const engine = engineWithExec(() => {
      calls++;
      // First two polls: marker missing (entrypoint script still
      // running). Third poll: marker present.
      return calls < 3 ? { code: 1, stderr: "" } : { code: 0 };
    });
    await expect(waitForEntrypointReady(engine, "id-warming-up", 5_000)).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("throws the timeout error if neither ready nor gone within budget", async () => {
    const engine = engineWithExec(() => ({ code: 1, stderr: "permission denied" }));
    const start = Date.now();
    await expect(waitForEntrypointReady(engine, "id-stuck", 800)).rejects.toThrow(
      /did not become ready/i,
    );
    expect(Date.now() - start).toBeGreaterThanOrEqual(800);
  });
});
