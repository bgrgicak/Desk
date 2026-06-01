import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = 'roomy-agent task progress --message <text>';

export const help = `\
roomy-agent task progress — append visible progress to the current task.

Use this inside a task run for milestones the user should see while the task is
open. The current task is inferred from the sandbox session.

Examples:
  roomy-agent task progress --message "Scaffolding RSS app"
  roomy-agent task progress Running tests
`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }
  const { flags, positionals } = parseFlags(argv, [], []);
  const text = typeof flags["message"] === "string"
    ? flags["message"].trim()
    : positionals.join(" ").trim();
  if (!text) throw new CliError("INVALID_ARGS", "Missing progress message. Usage:\n" + usage);
  const result = await postJson("/sandbox/tasks/progress", { message: text });
  output(result);
}
