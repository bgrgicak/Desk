import { callTool } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = "desk file read <path>";

export async function run(argv: string[]): Promise<void> {
  const { positionals } = parseFlags(argv);
  const path = positionals[0];
  if (!path) {
    throw new CliError("INVALID_ARGS", "Usage: " + usage);
  }
  const result = await callTool("file.read", { path });
  output(result);
}
