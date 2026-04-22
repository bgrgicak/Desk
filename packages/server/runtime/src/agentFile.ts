/**
 * Generates and writes OpenCode agent definition files into sandbox containers.
 *
 * Each Desk agent maps to a `.opencode/agents/<agentId>.md` file inside the
 * sandbox. The file contains YAML frontmatter (description, model) and a
 * markdown body with the hardcoded Desk framing followed by the user's custom
 * instructions from the DB.
 */

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

## File access

You can access files on the host filesystem under /mnt/desk:
- /mnt/desk/files      (read-only) workspace files
- /mnt/desk/library    (read-only) library items
- /mnt/desk/desktop    (read-write) scratch space for your output

When a chat has attachments, they will be mounted at a path provided in the chat context.

## User instructions

${input.instructions}`;

  return `${frontmatter}\n\n${body}\n`;
}

/**
 * Writes the agent definition file into a running sandbox container at
 * `/home/agent/.opencode/agents/<agentId>.md` via `docker exec`.
 */
export async function writeAgentFile(
  containerId: string,
  input: AgentFileInput,
): Promise<void> {
  const content = renderAgentFile(input);
  const agentDir = "/home/agent/.opencode/agents";
  const filePath = `${agentDir}/${input.agentId}.md`;

  const { dockerSocketPath } = await import("./docker.js");
  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });
  const container = docker.getContainer(containerId);

  // mkdir + write in a single exec to avoid race conditions
  const exec = await container.exec({
    Cmd: ["sh", "-c", `mkdir -p "${agentDir}" && cat > "${filePath}"`],
    User: "agent",
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: true, stdin: true });
  stream.write(content);
  stream.end();

  // Wait for the exec to finish
  await new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("error", () => resolve());
  });
}
