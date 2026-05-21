/**
 * Renders and writes pi's project-level system-prompt file.
 *
 * Pi auto-loads `AGENTS.md` (or `CLAUDE.md`) from cwd up through parent
 * directories. The workspace root *is* the agent's home inside the
 * sandbox (it's the rw bind-mount target), so a single AGENTS.md at the
 * workspace root is visible to every pi invocation.
 *
 * Writing host-side means no `docker exec` dance — the file is simply
 * present when pi reads it.
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
  userTimezone?: string;
  chatId?: string;
  goal?: GoalKey | null;
  runMode?: "chat" | "scheduled-task" | "summary" | "reflection";
  home?: string;
  workspaceSlug?: string;
  workspaceKind?: WorkspaceKind;
  includeGoalAutodetect?: boolean;
  localFilesystemDirectories?: Array<{ path: string; access: "read_only" | "read_write"; description?: string }>;
}

/**
 * Renders the AGENTS.md body for pi. Pi reads no frontmatter from this
 * file — the body is treated as plain system-prompt context. Per-agent
 * model/permission selection is passed to pi on the CLI (`--model`,
 * `--no-builtin-tools`) by the driver instead.
 */
export function renderAgentFile(input: AgentFileInput): string {
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
    localFilesystemDirectories: input.localFilesystemDirectories,
  });
  // Lead with a short header so the file is recognizable when a user
  // browses the workspace; the body is everything below.
  return `# ${input.agentName}\n\n${body.trim()}\n`;
}

/**
 * Writes the AGENTS.md file to the workspace root. Idempotent —
 * overwrites existing file contents.
 *
 * The `home` argument is the DESK_HOME root (contains `workspaces/desk/`).
 */
export async function writeAgentFile(
  home: string,
  workspaceSlug: string,
  input: AgentFileInput,
): Promise<void> {
  const content = renderAgentFile({ ...input, home, workspaceSlug });
  const filePath = path.join(workspaceRootPath(home, workspaceSlug), "AGENTS.md");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}
