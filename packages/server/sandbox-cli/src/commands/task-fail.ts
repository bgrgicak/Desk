import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = 'roomy-agent task fail --message <text>';

export const help = `\
roomy-agent task fail — mark the current task failed with a visible reason.

Use this when execution cannot continue. The current task is inferred from the
sandbox session.

Examples:
  roomy-agent task fail --message "Docker container is marked for removal"
  roomy-agent task fail Provider timed out
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
  if (!text) throw new CliError("INVALID_ARGS", "Missing failure message. Usage:\n" + usage);
  const result = await postJson("/sandbox/tasks/fail", { message: text });
  output(result);
}
