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
import { type GoalKey } from "@agent-desk/shared";
import { renderPromptBody } from "./prompt.js";

export interface AgentFileInput {
  agentId: string;
  agentName: string;
  model: string;
  instructions: string;
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
  /** Whether to include the goal-selection/autodetection prompt fragment. */
  includeGoalAutodetect?: boolean;
  /**
   * Summary runs are internal summary refreshes. They get a narrow prompt that
   * returns markdown only and never writes artifacts.
   */
  runMode?: "chat" | "summary";
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
    instructions: input.instructions,
    userTimezone: input.userTimezone,
    chatId: input.chatId,
    goal: input.goal ?? null,
    includeGoalAutodetect: input.includeGoalAutodetect,
    runMode: input.runMode ?? "chat",
  });

  return `${frontmatter}\n\n${body}\n`;
}

/**
 * Writes the agent definition file to the host workspace so it's visible
 * inside the sandbox via the `~/` bind-mount. Idempotent — overwrites
 * existing file contents.
 *
 * The `home` argument is the DESK_HOME root (contains
 * `Desk/workspaces/desk/`). We no longer need the container id because
 * the file lands on the host filesystem.
 */
export async function writeAgentFile(
  home: string,
  workspaceSlug: string,
  input: AgentFileInput,
): Promise<void> {
  const content = renderAgentFile(input);
  const agentDir = path.join(workspaceRootPath(home, workspaceSlug), ".opencode", "agents");
  const filePath = path.join(agentDir, `${input.agentId}.md`);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}
