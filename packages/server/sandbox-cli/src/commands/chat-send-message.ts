import { callTool } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = "desk chat send-message --chat <id> <content>";

export async function run(argv: string[]): Promise<void> {
  const { flags, positionals } = parseFlags(argv);
  const chatId = flags["chat"];
  const content = positionals[0];

  if (typeof chatId !== "string" || !content) {
    throw new CliError("INVALID_ARGS", "Usage: " + usage);
  }

  const result = await callTool("chat.send_message", { chatId, content });
  output(result);
}
