import { callTool } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "desk library list --workspace <id> [--cursor <str>] [--limit <n>]";

export async function run(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv);
  const workspaceId = flags["workspace"];

  if (typeof workspaceId !== "string") {
    throw new CliError("INVALID_ARGS", "Usage: " + usage);
  }

  const request: Record<string, unknown> = { workspaceId };
  if (typeof flags["cursor"] === "string") {
    request.cursor = flags["cursor"];
  }
  if (typeof flags["limit"] === "string") {
    const limit = parseInt(flags["limit"], 10);
    if (isNaN(limit)) {
      throw new CliError("INVALID_ARGS", "--limit must be a number");
    }
    request.limit = limit;
  }

  const result = await callTool("library.list", request);
  output(result);
}
