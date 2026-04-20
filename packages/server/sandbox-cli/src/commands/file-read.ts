import { callTool } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = "desk file read <fileId>";

export async function run(argv: string[]): Promise<void> {
  const { positionals } = parseFlags(argv);
  const fileId = positionals[0];
  if (!fileId) {
    throw new CliError("INVALID_ARGS", "Usage: " + usage);
  }
  const result = await callTool("file.read", { fileId });
  output(result);
}
