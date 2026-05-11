/**
 * Generates and writes OpenCode agent definition files.
 *
 * Under the workspace-as-home model the sandbox's `$HOME` is a bind-mount
 * of the workspace root, so the agent file lives at
 * `{workspaceRoot}/.opencode/agents/{agentId}.md` on the host and appears
 * inside the container at `~/.opencode/agents/{agentId}.md`.
 *
 * Writing host-side means no `docker exec` dance — the file is simply
 * present when the container runs `opencode`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspaceRootPath } from "@agent-desk/storage";
import { type GoalKey, type WorkspaceKind } from "@agent-desk/shared";
import { renderPromptBody } from "./prompt.js";

export interface AgentFileInput {
  agentId: string;
  agentName: string;
  model: string;
  userName: string;
  /**
   * IANA zone (e.g. `America/Los_Angeles`) reported by the user's app
   * client. Rendered into the system prompt so the agent interprets
   * unqualified user-supplied times in the right zone. Omit when unknown
   * — the agent is told to ask in that case.
   */
  userTimezone?: string;
  /**
   * Chat the agent is responding in. When set, the artifacts fragment
   * names the per-chat paths so the agent reads real paths instead of guessing.
   */
  chatId?: string;
  /**
   * Persistent goal for the chat. When set, the matching `goal/<key>.md`
   * fragment is rendered into the system prompt on every turn so the
   * agent has the same goal context across the whole conversation.
   */
  goal?: GoalKey | null;
  /**
   * Summary and reflection runs are internal. They get narrow prompts instead
   * of the full chat/task/artifact instruction set.
   */
  runMode?: "chat" | "summary" | "reflection";
  /**
   * DESK_HOME root, threaded through so the prompt renderer can read the
   * user `.memory/memory.md` index and the workspace `.memory/workspace.md`
   * index. Optional — when missing, memory injection is skipped.
   */
  home?: string;
  /** Workspace slug for resolving the workspace memory index. */
  workspaceSlug?: string;
  /**
   * Kind of the workspace this agent file is being rendered for. Drives
   * kind-specific prompt fragments (e.g. the hub-only `hub.md` section).
   * Defaults to `project` so existing callers stay unchanged.
   */
  workspaceKind?: WorkspaceKind;
  /**
   * When false, the goal-autodetect fragment is omitted from the prompt.
   * Defaults to true.
   */
  includeGoalAutodetect?: boolean;
}

/**
 * Renders the content of an OpenCode agent `.md` file.
 */
export function renderAgentFile(input: AgentFileInput): string {
  const frontmatter = [
    "---",
    `description: ${input.agentName}`,
    `model: ${input.model}`,
    "mode: primary",
    "---",
  ].join("\n");

  const body = renderPromptBody({
    agentName: input.agentName,
    userName: input.userName,
    userTimezone: input.userTimezone,
    chatId: input.chatId,
    goal: input.goal ?? null,
    runMode: input.runMode ?? "chat",
    home: input.home,
    workspaceSlug: input.workspaceSlug,
    workspaceKind: input.workspaceKind ?? "project",
    includeGoalAutodetect: input.includeGoalAutodetect,
  });

  return `${frontmatter}\n\n${body}\n`;
}

/**
 * Writes the agent definition file to the host workspace so it's visible
 * inside the sandbox via the `~/` bind-mount. Idempotent — overwrites
 * existing file contents.
 *
 * The `home` argument is the DESK_HOME root (contains
 * `workspaces/desk/`). We no longer need the container id because
 * the file lands on the host filesystem.
 */
export async function writeAgentFile(
  home: string,
  workspaceSlug: string,
  input: AgentFileInput,
): Promise<void> {
  const content = renderAgentFile({ ...input, home, workspaceSlug });
  const agentDir = path.join(workspaceRootPath(home, workspaceSlug), ".opencode", "agents");
  const filePath = path.join(agentDir, `${input.agentId}.md`);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}
