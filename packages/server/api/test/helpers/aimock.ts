/**
 * Boots a per-test aimock HTTP server so integration tests that need an
 * actual model response can hit a deterministic, zero-cost mock instead
 * of the real Anthropic / OpenAI API. Replaces the free-tier model we
 * used to rely on (no longer available), while keeping the test policy
 * ("no fakes as the only coverage of any surface"). Tests that want
 * real-stack coverage should record a fixture once against a paid key
 * (locally, by a developer) and replay it against this server in CI.
 *
 * # Usage
 *
 *     const mock = await startAimock({ done: "DONE" });
 *     applyAimockEnv(mock);       // points pi at the mock
 *     // …run the test…
 *     await mock.stop();
 *
 * # Cross-process notes
 *
 * Pi runs in a Docker sandbox, not the test runner's Node process. To
 * reach aimock from inside the container, the sandbox env var must
 * point at `http://host.docker.internal:<port>/v1` on Docker Desktop,
 * or the equivalent bridge gateway on Linux. Tests that exec pi must
 * forward `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` into the sandbox env
 * — not just into the test runner's env. The helpers here cover the
 * test-runner side; sandbox plumbing is the caller's responsibility.
 */
import { LLMock } from "@copilotkit/aimock";

export interface StartAimockOptions {
  /** Text returned to any request whose prompt matches `donePattern`.
   *  Defaults to "DONE" so the e2e "agent must say DONE" pattern keeps
   *  working without per-test wiring. */
  done?: string;
  /** Pattern used to match the prompt for the canned `done` reply.
   *  Defaults to a permissive match-anything regex so any prompt yields
   *  the canned response — fine for smoke coverage, override for tests
   *  that need multiple distinct responses. */
  donePattern?: string | RegExp;
}

export interface AimockHandle {
  /** Base URL with no trailing `/v1`. E.g. `http://127.0.0.1:54321`. */
  url: string;
  /** `${url}/v1`, the value to set as `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`. */
  baseUrl: string;
  port: number;
  /** Stop the mock server. Idempotent. */
  stop: () => Promise<void>;
  /** Underlying mock instance — escape hatch for tests that want to
   *  register additional fixtures or assert on captured requests. */
  mock: LLMock;
}

/**
 * Start an aimock server on a random port. The returned handle exposes
 * its base URL so callers can wire env vars and stop the server in
 * `afterAll`.
 */
export async function startAimock(opts: StartAimockOptions = {}): Promise<AimockHandle> {
  const mock = new LLMock({ port: 0 });
  mock.onMessage(opts.donePattern ?? /.*/, { content: opts.done ?? "DONE" });
  await mock.start();
  return {
    url: mock.url,
    baseUrl: `${mock.url}/v1`,
    port: mock.port,
    stop: () => mock.stop(),
    mock,
  };
}

/**
 * Sets the env vars pi-in-sandbox reads for provider base URLs. Returns
 * a snapshot of the previous values so tests can restore them in
 * `afterAll`. Tests that exec pi inside Docker must additionally pass
 * these into the sandbox env — see the module header.
 */
export function applyAimockEnv(handle: AimockHandle): () => void {
  const keys = [
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ];
  const before: Record<string, string | undefined> = {};
  for (const k of keys) before[k] = process.env[k];
  process.env.ANTHROPIC_BASE_URL = handle.baseUrl;
  process.env.OPENAI_BASE_URL = handle.baseUrl;
  process.env.ANTHROPIC_API_KEY = "aimock-test-key";
  process.env.OPENAI_API_KEY = "aimock-test-key";
  return () => {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  };
}
