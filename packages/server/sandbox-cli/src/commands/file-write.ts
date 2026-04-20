import { callTool } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "desk file write --workspace <id> --name <str> --mime <str> [--chat <id>] < stdin";

export async function run(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv);
  const workspaceId = flags["workspace"];
  const name = flags["name"];
  const mime = flags["mime"];
  const chatId = flags["chat"];

  if (
    typeof workspaceId !== "string" ||
    typeof name !== "string" ||
    typeof mime !== "string"
  ) {
    throw new CliError("INVALID_ARGS", "Usage: " + usage);
  }

  // Stream stdin and base64-encode
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const contentBase64 = Buffer.concat(chunks).toString("base64");

  const request: Record<string, unknown> = {
    workspaceId,
    name,
    mime,
    contentBase64,
  };
  if (typeof chatId === "string") {
    request.chatId = chatId;
  }

  const result = await callTool("file.write", request);
  output(result);
}
