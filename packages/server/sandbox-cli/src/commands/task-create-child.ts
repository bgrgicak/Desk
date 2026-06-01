import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = 'roomy-agent task create-child --title <text> [--parent-task <message-id>] <content>';

export const help = `\
roomy-agent task create-child — create a child task under the current task.

The current task is inferred from the sandbox session. Pass --parent-task only
when creating under a different known task anchor.

Examples:
  roomy-agent task create-child --title "Implement parser" "Parse RSS and Atom feeds"
  roomy-agent task create-child --parent-task msg_parent --title "Verify parser" "Add tests"
`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }
  const { flags, positionals } = parseFlags(argv, [], []);
  const title = flags["title"];
  const parentTaskId = flags["parent-task"];
  const content = positionals.join(" ").trim();
  if (typeof title !== "string" || !title.trim()) {
    throw new CliError("INVALID_ARGS", "Missing --title <text>. Usage:\n" + usage);
  }
  if (!content) throw new CliError("INVALID_ARGS", "Missing task content. Usage:\n" + usage);
  const body: Record<string, unknown> = { title: title.trim(), content };
  if (typeof parentTaskId === "string" && parentTaskId.trim()) body.parentTaskId = parentTaskId.trim();
  const result = await postJson("/sandbox/messages", body);
  output(result);
}
