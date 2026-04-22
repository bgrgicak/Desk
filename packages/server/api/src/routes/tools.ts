import pg from "pg";
import { NotFoundError, ValidationError } from "@desk/shared";
import { queries } from "@desk/db";
import { listModels as runtimeListModels, SandboxExecError } from "@desk/runtime";

/**
 * Lists AI models available to an agent by querying its sandbox.
 *
 * Host control plane → sandbox exec → `opencode models` → parsed response.
 * This is the first host-initiated tool call; it underpins the broader
 * sandboxed tool-calling surface described in ARCHITECTURE.md §7.
 */
export async function listModels(
  pool: pg.Pool,
  opts: { agentId?: string; provider?: string },
): Promise<{ agentId: string; provider: string | null; models: Array<{ providerId: string; modelId: string; fullId: string }> }> {
  const agentId = opts.agentId ?? (await resolveDefaultAgentId(pool));
  if (!agentId) throw new NotFoundError("No agent available to query models from");

  const agent = await queries.agents.findById(pool, agentId);
  if (!agent) throw new NotFoundError(`Agent not found: ${agentId}`);

  if (opts.provider !== undefined && !/^[A-Za-z0-9_.-]+$/.test(opts.provider)) {
    throw new ValidationError("Invalid provider id");
  }

  try {
    const models = await runtimeListModels(agentId, { provider: opts.provider });
    return { agentId, provider: opts.provider ?? null, models };
  } catch (err) {
    if (err instanceof SandboxExecError) {
      throw new ValidationError(
        `Sandbox rejected model listing (exit ${err.exitCode}): ${err.stderr.trim() || "no stderr"}`,
      );
    }
    throw err;
  }
}

async function resolveDefaultAgentId(pool: pg.Pool): Promise<string | undefined> {
  const agents = await queries.agents.list(pool);
  return agents[0]?.id;
}
