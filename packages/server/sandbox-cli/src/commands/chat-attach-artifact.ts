import { callTool } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = "desk chat attach-artifact --chat <id> --file <id>";

export async function run(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv);
  const chatId = flags["chat"];
  const fileId = flags["file"];

  if (typeof chatId !== "string" || typeof fileId !== "string") {
    throw new CliError("INVALID_ARGS", "Usage: " + usage);
  }

  const result = await callTool("chat.attach_artifact", { chatId, fileId });
  output(result);
}
