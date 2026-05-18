import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = "desk-agent task cancel --chat <id> <message-id>";

export const help = `\
desk-agent task cancel — cancel a pending scheduled, recurring, or manual task
message that belongs to the given chat.

Required:
  --chat <id>            Chat containing the task message.
  <message-id>           ID of the task message to cancel.

Examples:
  desk-agent task cancel --chat ch_abc msg_123

Exit codes:
  0 on success — JSON message row on stdout.
  Non-zero on failure — JSON {code, message} on stderr.`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }

  const { flags, positionals } = parseFlags(argv);
  const chatId = flags["chat"];
  const messageId = positionals.join(" ").trim();

  if (typeof chatId !== "string" || !chatId) {
    throw new CliError("INVALID_ARGS", "Missing --chat <id>. Usage:\n" + usage);
  }
  if (!messageId) {
    throw new CliError("INVALID_ARGS", "Missing <message-id>. Usage:\n" + usage);
  }
  if (messageId.includes(" ")) {
    throw new CliError("INVALID_ARGS", "<message-id> must be a single id. Usage:\n" + usage);
  }

  const result = await postJson("/sandbox/messages/cancel", { chatId, messageId });
  output(result);
}
