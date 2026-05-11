import { describe, it, expect } from "vitest";
import { classifyResourceError } from "../src/docker.js";

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
});
