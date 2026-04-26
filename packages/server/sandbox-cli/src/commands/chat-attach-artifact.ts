import { callTool } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = "desk chat attach-artifact --chat <id> --path <path>";

export async function run(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv);
  const chatId = flags["chat"];
  const path = flags["path"];

  if (typeof chatId !== "string" || typeof path !== "string") {
    throw new CliError("INVALID_ARGS", "Usage: " + usage);
  }

  const result = await callTool("chat.attach_artifact", { chatId, path });
  output(result);
}
