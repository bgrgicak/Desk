import { TOOLS, type ToolName } from "@desk/shared";
import { writeErrorAndExit } from "./errors.js";

// Command registry: map tool-name-based subcommands to their modules.
// The CLI surface is "desk <group> <action>" where group.action = tool name.
interface Command {
  usage: string;
  run(argv: string[]): Promise<void>;
}

const COMMANDS: Record<string, () => Promise<Command>> = {
  "file read": () => import("./commands/file-read.js"),
  "file write": () => import("./commands/file-write.js"),
  "library list": () => import("./commands/library-list.js"),
  "library get": () => import("./commands/library-get.js"),
  "chat send-message": () => import("./commands/chat-send-message.js"),
  "chat attach-artifact": () => import("./commands/chat-attach-artifact.js"),
  "web fetch": () => import("./commands/web-fetch.js"),
};

// Map from tool name (e.g. "file.read") to subcommand key (e.g. "file read")
const TOOL_TO_SUBCOMMAND: Record<ToolName, string> = {
  "file.read": "file read",
  "file.write": "file write",
  "library.list": "library list",
  "library.get": "library get",
  "chat.send_message": "chat send-message",
  "chat.attach_artifact": "chat attach-artifact",
  "web.fetch": "web fetch",
};

// Verify all tools are covered
for (const toolName of Object.keys(TOOLS) as ToolName[]) {
  if (!(toolName in TOOL_TO_SUBCOMMAND)) {
    throw new Error(`Tool ${toolName} is not mapped to a subcommand`);
  }
}

export function output(data: unknown): void {
  const json = process.stdout.isTTY
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);
  process.stdout.write(json + "\n");
}

async function printHelp(): Promise<void> {
  const lines: string[] = ["Usage: desk <command> [options]", "", "Commands:"];
  for (const [sub, loader] of Object.entries(COMMANDS)) {
    const cmd = await loader();
    lines.push(`  ${cmd.usage}`);
  }
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    await printHelp();
    return;
  }

  // Try matching two-word subcommand first (e.g. "file read")
  if (args.length >= 2) {
    // Handle hyphenated subcommand: "chat send-message" = args[0]="chat", args[1]="send-message"
    const twoWord = `${args[0]} ${args[1]}`;
    if (twoWord in COMMANDS) {
      const cmd = await COMMANDS[twoWord]();
      await cmd.run(args.slice(2));
      return;
    }
  }

  process.stderr.write(`Unknown command: ${args.join(" ")}\n`);
  await printHelp();
  process.exit(1);
}

main().catch(writeErrorAndExit);
