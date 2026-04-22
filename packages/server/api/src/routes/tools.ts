import pg from "pg";
import { NotFoundError, ValidationError } from "@desk/shared";
import { queries } from "@desk/db";
import { listModels as runtimeListModels, SandboxExecError, type ModelRef } from "@desk/runtime";
import { resolveProviderKeys } from "../providerKeys.js";

/**
 * Lists AI models that are ready to use — every entry is a provider opencode
 * has authenticated inside the sandbox (via a host-forwarded API key). Models
 * are server-wide config, not agent-scoped, so the response is a bare array
 * matching the convention of `/workspaces`, `/agents`, etc. We still query
 * through a warm sandbox internally because opencode is the source of truth
 * for provider availability.
 *
 * Foundation of host-initiated sandboxed tool calling per ARCHITECTURE.md §7.
 */
export async function listModels(
  pool: pg.Pool,
  opts: { provider?: string },
): Promise<ModelRef[]> {
  if (opts.provider !== undefined && !/^[A-Za-z0-9_.-]+$/.test(opts.provider)) {
    throw new ValidationError("Invalid provider id");
  }

  // Pick any available agent to reach a warm sandbox. Which one is an
  // implementation detail — all sandboxes see the same user-scoped keys.
  const agents = await queries.agents.list(pool);
  const agentId = agents[0]?.id;
  if (!agentId) throw new NotFoundError("No sandbox available to query models from");

  const providerKeys = await resolveProviderKeys(pool);

  try {
    return await runtimeListModels(agentId, { provider: opts.provider, providerKeys });
  } catch (err) {
    if (err instanceof SandboxExecError) {
      throw new ValidationError(
        `Sandbox rejected model listing (exit ${err.exitCode}): ${err.stderr.trim() || "no stderr"}`,
      );
    }
    throw err;
  }
}
