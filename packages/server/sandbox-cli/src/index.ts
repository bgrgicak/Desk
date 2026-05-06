import { writeErrorAndExit } from "./errors.js";

/**
 * `desk` — the in-sandbox CLI used by the OpenCode agent to call back into
 * the host desk-server. The only command today is `task schedule`; new
 * commands plug in through COMMANDS as additional `<group> <action>`
 * entries.
 */

interface Command {
  usage: string;
  help?: string;
  run(argv: string[]): Promise<void>;
}

const COMMANDS: Record<string, () => Promise<Command>> = {
  "app create": () => import("./commands/app-create.js"),
  "chat attach-artifact": () => import("./commands/chat-attach-artifact.js"),
  "file to-markdown": () => import("./commands/file-to-markdown.js"),
  "task schedule": () => import("./commands/task-schedule.js"),
};

export function output(data: unknown): void {
  const json = process.stdout.isTTY
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);
  process.stdout.write(json + "\n");
}

async function printHelp(): Promise<void> {
  const lines: string[] = ["Usage: desk <command> [options]", "", "Commands:"];
  for (const loader of Object.values(COMMANDS)) {
    const cmd = await loader();
    lines.push(`  ${cmd.usage}`);
  }
  lines.push("");
  lines.push("Run `desk-agent <command> --help` for full documentation.");
  process.stdout.write(lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    await printHelp();
    return;
  }

  if (args.length >= 2) {
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
