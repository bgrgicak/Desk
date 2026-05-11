import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { classifyResourceError, killClaimedRunsInContainers, providerKeyEnv, providerKeyExecEnv } from "../src/docker.js";
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
      classifyResourceError(1, "spawn /usr/local/bin/.opencode EAGAIN"),
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
    // The setsid wrapper around opencode reports a signal-killed child as
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

describe("providerKeyEnv", () => {
  it("keeps sandbox connection tokens out of create-time container env", () => {
    expect(providerKeyEnv({
      OPENAI_API_KEY: "sk-test",
      GITHUB_TOKEN: "github_pat_test",
      NOT_ALLOWED: "nope",
    })).toEqual([
      "OPENAI_API_KEY=sk-test",
    ]);
  });
});

describe("providerKeyExecEnv", () => {
  it("forwards GitHub connection tokens per exec alongside model provider keys", () => {
    const env = providerKeyExecEnv({
      OPENAI_API_KEY: "sk-test",
      GITHUB_TOKEN: "github_pat_test",
      NOT_ALLOWED: "nope",
    });
    expect(env).toContain("GITHUB_TOKEN=github_pat_test");
    expect(env).toContain("GH_TOKEN=github_pat_test");
  });

  it("clears missing connection keys so warm sandboxes cannot reuse deleted tokens", () => {
    const env = providerKeyExecEnv({ OPENAI_API_KEY: "sk-test" });

    expect(env).toContain("OPENAI_API_KEY=sk-test");
    expect(env).toContain("GITHUB_TOKEN=");
    expect(env).toContain("GH_TOKEN=");
  });

  it("does not let extra env override managed connection credentials", () => {
    const env = providerKeyExecEnv(
      { OPENAI_API_KEY: "sk-test" },
      { GITHUB_TOKEN: "stale", GH_TOKEN: "stale", OPENCODE_AUTH_CONTENT: "codex" },
    );

    expect(env).not.toContain("GITHUB_TOKEN=stale");
    expect(env).not.toContain("GH_TOKEN=stale");
    expect(env).toContain("GITHUB_TOKEN=");
    expect(env).toContain("GH_TOKEN=");
    expect(env).toContain("OPENCODE_AUTH_CONTENT=codex");
  });
});

describe("killClaimedRunsInContainers", () => {
  // Fake Engine that records exec calls per (containerId, script) so we can
  // assert exactly which pidfiles got signalled, without standing up real
  // containers. `inspect` is wired so we can fake "container exists" / "no
  // container" per workspace, since the orphan killer must skip workspaces
  // whose sandbox is already gone.
  type Handler = (containerId: string, script: string) => number;
  function fakeEngine(opts: {
    handler: Handler;
    knownContainers?: ReadonlySet<string>;
  }): { engine: Engine; calls: Array<{ container: string; script: string }> } {
    const calls: Array<{ container: string; script: string }> = [];
    const exec = async (spec: ExecSpec): Promise<ExecHandle> => {
      const script = spec.cmd.join(" ");
      calls.push({ container: spec.containerId, script });
      const code = opts.handler(spec.containerId, script);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.end();
      stderr.end();
      return {
        stdout,
        stderr,
        wait: async () => code,
        cancel: async () => {},
      };
    };
    const inspect = async (nameOrId: string): Promise<ContainerInfo | null> => {
      if (opts.knownContainers && !opts.knownContainers.has(nameOrId)) return null;
      return {
        id: nameOrId,
        name: nameOrId,
        image: "desk/sandbox:test",
        imageId: "sha256:fake",
        user: "0:0",
        binds: [],
        labels: {},
        running: true,
      };
    };
    return {
      calls,
      engine: {
        name: "docker",
        exec,
        inspect,
      } as unknown as Engine,
    };
  }

  it("skips workspaces whose sandbox container no longer exists", async () => {
    // No container means there's no surviving opencode to fight; the next
    // fire builds a fresh sandbox. The function must not exec anything in
    // a missing container — that would either be a wasted call or, worse,
    // hit a container with the same name freshly created in between.
    const { engine, calls } = fakeEngine({
      handler: () => 0,
      knownContainers: new Set(), // no containers exist
    });
    const results = await killClaimedRunsInContainers(
      new Map([["wks_gone", ["msg_a", "msg_b"]]]),
      engine,
    );
    expect(calls).toHaveLength(0);
    expect(results).toEqual([
      { workspaceId: "wks_gone", runId: "msg_a", killed: false },
      { workspaceId: "wks_gone", runId: "msg_b", killed: false },
    ]);
  });

  it("signals each claimed run's pidfile in its workspace container", async () => {
    // For each (workspace, runId) we expect the cleanup to: confirm the
    // pidfile exists, signal the process group, then rm the pidfile. We
    // only assert the pidfile path is mentioned and a kill landed — the
    // exact shell script is the cleanupRunProcessTree contract under test
    // elsewhere.
    const { engine, calls } = fakeEngine({
      handler: (_c, script) => {
        if (script.includes("[ -s ")) return 0; // pidfile present
        if (script.includes("kill -TERM")) return 42; // PG signalled
        if (script.includes("kill -KILL")) return 42;
        return 0;
      },
      knownContainers: new Set(["desk-sandbox-wks_a", "desk-sandbox-wks_b"]),
    });
    const results = await killClaimedRunsInContainers(
      new Map([
        ["wks_a", ["msg_1", "msg_2"]],
        ["wks_b", ["msg_3"]],
      ]),
      engine,
    );
    expect(results).toEqual([
      { workspaceId: "wks_a", runId: "msg_1", killed: true },
      { workspaceId: "wks_a", runId: "msg_2", killed: true },
      { workspaceId: "wks_b", runId: "msg_3", killed: true },
    ]);
    // Each runId's pidfile should appear in the call set; cross-workspace
    // routing is verified by the container id on the call.
    expect(
      calls.some(
        (c) => c.container === "desk-sandbox-wks_a" && c.script.includes("/tmp/desk-runs/msg_1.pid"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) => c.container === "desk-sandbox-wks_a" && c.script.includes("/tmp/desk-runs/msg_2.pid"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) => c.container === "desk-sandbox-wks_b" && c.script.includes("/tmp/desk-runs/msg_3.pid"),
      ),
    ).toBe(true);
    // Sanity: the wks_a pidfile must not have been routed into wks_b's
    // container — a routing bug here would cross-kill unrelated runs.
    expect(
      calls.some(
        (c) => c.container === "desk-sandbox-wks_b" && c.script.includes("/tmp/desk-runs/msg_1.pid"),
      ),
    ).toBe(false);
  });

  it("reports killed=false when the pidfile is absent (already cleaned up)", async () => {
    // The previous server may have crashed after the run exited cleanly but
    // before the pidfile was rm-ed by the finally block. We treat absent
    // pidfile as "nothing to kill" rather than an error — the requeue will
    // still happen.
    const { engine } = fakeEngine({
      handler: (_c, script) => {
        if (script.includes("[ -s ")) return 1; // no pidfile
        return 0;
      },
      knownContainers: new Set(["desk-sandbox-wks_a"]),
    });
    const results = await killClaimedRunsInContainers(
      new Map([["wks_a", ["msg_ghost"]]]),
      engine,
    );
    expect(results).toEqual([
      { workspaceId: "wks_a", runId: "msg_ghost", killed: false },
    ]);
  });

  it("returns an empty array for an empty input without touching the engine", async () => {
    const { engine, calls } = fakeEngine({ handler: () => 0 });
    const results = await killClaimedRunsInContainers(new Map(), engine);
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
