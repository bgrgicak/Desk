/**
 * Integration test: automatic runtime fallback across real PI invocations.
 *
 * The first attempt uses an intentionally invalid OpenAI API key and should
 * fail quickly. The driver should then invoke PI again with the host Codex
 * OAuth model and return a successful turn.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, ensureWorkspaceLayout } from "@agent-desk/storage";
import { sandboxImage } from "../../src/docker.js";
import { createDriver, type LogEvent } from "../../src/driver.js";
import { detectEngine, type Engine } from "../../src/engine.js";
import { loadCodexEnv } from "../../src/localSources/codex.js";
import { rmTempTree } from "./helpers.js";

let engineForSetup: Engine | null = null;
let SKIP = false;
try {
  engineForSetup = await detectEngine();
  if (!(await engineForSetup.imageId(sandboxImage()))) SKIP = true;
} catch {
  SKIP = true;
}
const CODEX_AUTH_ENV = loadCodexEnv();
if (!CODEX_AUTH_ENV) SKIP = true;
const describeIf = SKIP ? describe.skip : describe;

let home: string;
const originalDeskHome = process.env.DESK_HOME;
const workspaceId = "wks_model_fallback_int";
const workspaceSlug = "model-fallback-int";

beforeAll(async () => {
  if (SKIP) return;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-model-fallback-int-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, workspaceSlug);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  if (engineForSetup) {
    await engineForSetup.remove(`desk-sandbox-${workspaceId}`, true).catch(() => {});
  }
  if (home) await rmTempTree(home);
  if (originalDeskHome === undefined) {
    delete process.env.DESK_HOME;
  } else {
    process.env.DESK_HOME = originalDeskHome;
  }
});

describeIf("runtime model fallback (real Docker + PI)", () => {
  it("falls back from an invalid OpenAI key to the Codex OAuth model", async () => {
    const events: LogEvent[] = [];
    const result = await createDriver().execRun(workspaceId, {
      runId: "run_model_fallback_int",
      workspaceSlug,
      chatId: "cht_model_fallback_int",
      prompt: "Reply with exactly: fallback-ok",
      model: "openai/gpt-4o-mini",
      modelFallbacks: ["codex/gpt-5.5"],
      providerKeys: { OPENAI_API_KEY: "tset" },
      extraEnv: CODEX_AUTH_ENV ?? undefined,
      onLog: (evt) => {
        events.push(evt);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("openai-codex/gpt-5.5");
    expect(events.some((evt) => evt.payload.includes("trying fallback openai-codex/gpt-5.5"))).toBe(true);
  }, 180_000);
});
