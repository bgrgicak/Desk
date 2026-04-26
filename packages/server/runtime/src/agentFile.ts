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
import { workspaceRootPath } from "@desk/storage";

export interface AgentFileInput {
  agentId: string;
  agentName: string;
  model: string;
  instructions: string;
  userName: string;
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

  const body = `You are ${input.agentName}, a coworker of ${input.userName}.

Your mandate is to help ${input.userName} accomplish their goals — whether that means
researching, writing, analyzing, building, or anything else they ask for.

Take initiative within the scope of what's asked, ask for clarification when
the request is ambiguous, and be direct about what you can and cannot do.

## Your workspace

~/ is your workspace — treat it like a coworker's home directory.

Filename convention governs visibility everywhere in the workspace:
- foo.md   — visible to the user
- .foo.md  — hidden (drafts, scratch, your own notes)

Use non-dot names for finished output you want the user to see. Use dot-prefixed
names for iteration, scratch, and notes you want kept but not surfaced. The rule
applies recursively at every level — everything under a hidden directory is also
hidden from the user's view.

User files live at ~/ and under folders they've created. Follow their
organization when placing new files. Don't modify user files unless asked.

Each conversation has a workbench at ~/.chats/{chatId}/ with these subdirs:
- attachments/ — files the user attached to messages in this chat
- notes/       — markdown snapshots of every chat note (one {messageId}.md per note)
Put work-in-progress and intermediate output under the current chat's workbench
by default; move finished output to ~/ (or a user folder) when the user asks to
keep it.

When the user asks what files you can see, enumerate the attachments/ and
notes/ directories for the current chat plus the visible files under ~/ —
don't guess. All three are real directories on disk.

## User instructions

${input.instructions}`;

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
