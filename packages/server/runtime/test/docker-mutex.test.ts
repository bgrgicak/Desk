import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import type {
  Engine,
  ExecHandle,
  ExecSpec,
  ContainerInfo,
} from "../src/engine.js";

/**
 * Regression coverage for the per-workspace `createOrReuse` mutex.
 *
 * Two rapid chat sends to the same workspace previously raced on
 * inspect/create/remove inside `createOrReuse` — the loser ended up
 * exec'ing against a container the winner had just removed, which
 * surfaced as "container … is no longer present" on a brand-new chat.
 * The mutex chains the calls so the second observes the container the
 * first just created and takes the reuse path; chat sends to *different*
 * workspaces remain independent.
 */

const fakeEngineState = {
  inspectCount: 0,
  inspectLatencyMs: 50,
  concurrentInspects: 0,
  maxConcurrentInspectsByWorkspace: new Map<string, number>(),
  createCountByName: new Map<string, number>(),
  removeCount: 0,
  existing: new Map<string, ContainerInfo>(),
  imageId: "img_test",
  expectedBinds: [] as string[],
  expectedUser: "0:0",
  agentUserLabel: "0:0",
  resourceProfile: "runtime=pi-v1,user=root+sudo",
};

function buildFakeEngine(): Engine {
  return {
    name: "docker",
    inspect: async (name: string) => {
      fakeEngineState.inspectCount++;
      fakeEngineState.concurrentInspects++;
      const prev = fakeEngineState.maxConcurrentInspectsByWorkspace.get(name) ?? 0;
      fakeEngineState.maxConcurrentInspectsByWorkspace.set(
        name,
        Math.max(prev, fakeEngineState.concurrentInspects),
      );
      try {
        await new Promise((r) => setTimeout(r, fakeEngineState.inspectLatencyMs));
        return fakeEngineState.existing.get(name) ?? null;
      } finally {
        fakeEngineState.concurrentInspects--;
      }
    },
    imageId: async () => fakeEngineState.imageId,
    imagePull: async () => {},
    create: async (spec) => {
      fakeEngineState.createCountByName.set(
        spec.name,
        (fakeEngineState.createCountByName.get(spec.name) ?? 0) + 1,
      );
      const id = `id-${spec.name}-${fakeEngineState.createCountByName.get(spec.name)}`;
      // Convert structured BindMount[] back to the "src:dst:mode" string
      // form that ContainerInfo.binds carries, so the second call's
      // drift-check sees a matching bind set instead of always-empty.
      const bindStrings = (spec.binds ?? []).map(
        (b) => `${b.source}:${b.target}:${b.mode}`,
      );
      fakeEngineState.existing.set(spec.name, {
        id,
        imageId: fakeEngineState.imageId,
        user: spec.user ?? fakeEngineState.expectedUser,
        labels: spec.labels ?? {
          "agent-desk.sandbox-resource-profile": fakeEngineState.resourceProfile,
          "agent-desk.sandbox-agent-user": fakeEngineState.agentUserLabel,
        },
        binds: bindStrings,
        running: true,
        // Carry a published-ports map so the createOrReuse drift check
        // doesn't classify the reused container as
        // "pi-port-unbound" and recreate it. Mirrors the
        // shape `engine.inspect` returns for a healthy live container.
        publishedPorts: {
          "9105/tcp": [{ hostIp: "127.0.0.1", hostPort: 34123 }],
        },
      } as ContainerInfo);
      return id;
    },
    start: async () => {},
    stop: async () => {},
    update: async () => true,
    remove: async (name: string) => {
      fakeEngineState.removeCount++;
      fakeEngineState.existing.delete(name);
    },
    list: async () => [],
    exec: async (spec: ExecSpec) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      // The entrypoint-ready check runs `test -f /tmp/desk-entrypoint-ready`.
      // We return success so `waitForEntrypointReady` doesn't loop.
      setImmediate(() => {
        stdout.end();
        stderr.end();
      });
      void spec;
      return {
        stdout,
        stderr,
        wait: async () => 0,
        cancel: async () => {},
      } as ExecHandle;
    },
    execDetached: async () => {},
    // The post-create pre-flight in `createOrReuse` calls `engine.port()`
    // to confirm the host-side publish wired up. The mutex test doesn't
    // care which port number comes back — return a stable fake binding
    // so the pre-flight passes and the reuse / drift logic actually
    // exercises.
    port: async () => ({ hostIp: "127.0.0.1", hostPort: 34123 }),
    top: async () => [],
    isRootless: async () => false,
  };
}

vi.mock("../src/engine.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/engine.js")>();
  const engine = buildFakeEngine();
  return {
    ...original,
    detectEngine: vi.fn(async () => engine),
  };
});

beforeEach(async () => {
  fakeEngineState.inspectCount = 0;
  fakeEngineState.concurrentInspects = 0;
  fakeEngineState.maxConcurrentInspectsByWorkspace.clear();
  fakeEngineState.createCountByName.clear();
  fakeEngineState.removeCount = 0;
  fakeEngineState.existing.clear();
  const { _resetGrowthStateForTest } = await import("../src/docker.js");
  _resetGrowthStateForTest();
});

describe("createOrReuse mutex", () => {
  it("serializes concurrent calls for the same workspace", async () => {
    // Two rapid sends to the same workspace must not both run engine.create
    // for the same container name — the second should observe the first's
    // result and take the reuse path. Before the mutex, both calls' inspect
    // returned null in parallel and both raced to engine.create, with one
    // call's drift-recreate removing the other's mid-poll container.
    const { createOrReuse } = await import("../src/docker.js");

    const settled = await Promise.all([
      createOrReuse("wks_race", "wks_race_slug"),
      createOrReuse("wks_race", "wks_race_slug"),
    ]);

    expect(settled).toHaveLength(2);
    expect(settled[0].workspaceId).toBe("wks_race");
    expect(settled[1].workspaceId).toBe("wks_race");

    const containerName = "desk-sandbox-wks_race";

    // The second concurrent call must wait — at no point are both
    // inspect calls in-flight against the same container name.
    const maxConcurrent =
      fakeEngineState.maxConcurrentInspectsByWorkspace.get(containerName) ?? 0;
    expect(maxConcurrent).toBe(1);

    // The serialized second call takes the reuse path, so engine.create
    // fires exactly once for the workspace's container name.
    expect(fakeEngineState.createCountByName.get(containerName) ?? 0).toBe(1);

    // And no drift-recreate (the first call's container matches expectations
    // on the second call's inspect, so we don't remove + recreate).
    expect(fakeEngineState.removeCount).toBe(0);
  });

  it("does not block concurrent calls for different workspaces", async () => {
    // The mutex is per-workspace; chat sends to different workspaces must
    // still run in parallel. If they didn't, a busy workspace would
    // stall a quiet one's first send.
    const { createOrReuse } = await import("../src/docker.js");

    const start = Date.now();
    await Promise.all([
      createOrReuse("wks_a", "wks_a_slug"),
      createOrReuse("wks_b", "wks_b_slug"),
    ]);
    const elapsed = Date.now() - start;

    // Both inspects happen in parallel — total should be roughly one
    // inspect-latency (50 ms) plus overhead, not two (which would be
    // ~100 ms serialized). 80 ms gives the CI scheduler some slack.
    expect(elapsed).toBeLessThan(80);

    expect(fakeEngineState.createCountByName.get("desk-sandbox-wks_a")).toBe(1);
    expect(fakeEngineState.createCountByName.get("desk-sandbox-wks_b")).toBe(1);
  });

  it("releases the lock after a failing call so the next caller can proceed", async () => {
    // A failing createOrReuse must not poison the lock for subsequent
    // calls — otherwise one transient error wedges the workspace until
    // the process restarts.
    const { createOrReuse } = await import("../src/docker.js");
    const engineModule = await import("../src/engine.js");

    let inspectCalls = 0;
    const original = engineModule.detectEngine as ReturnType<typeof vi.fn>;
    const previousImpl = original.getMockImplementation();
    original.mockImplementationOnce(async () => {
      const engine = await (previousImpl?.() ?? Promise.resolve(buildFakeEngine()));
      const wrapped: Engine = {
        ...engine,
        inspect: async (name: string) => {
          inspectCalls++;
          if (inspectCalls === 1) throw new Error("engine.inspect blew up");
          return engine.inspect(name);
        },
      };
      return wrapped;
    });

    await expect(createOrReuse("wks_recover", "wks_recover_slug")).rejects.toThrow(
      /engine\.inspect blew up/,
    );

    // Second call must complete on the same workspace without being
    // wedged behind the dead lock entry.
    const handle = await createOrReuse("wks_recover", "wks_recover_slug");
    expect(handle.workspaceId).toBe("wks_recover");
  });
});
