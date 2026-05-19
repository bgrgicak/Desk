export interface Command {
  usage: string;
  help?: string;
  run(argv: string[]): Promise<void>;
}

export const COMMANDS: Record<string, () => Promise<Command>> = {
  "app create": () => import("./commands/app-create.js"),
  "chat attach-artifact": () => import("./commands/chat-attach-artifact.js"),
  "chat search-messages": () => import("./commands/chat-search-messages.js"),
  "file to-markdown": () => import("./commands/file-to-markdown.js"),
  "find artifacts": () => import("./commands/find-library.js"),
  "find library": () => import("./commands/find-library.js"),
  "secret get": () => import("./commands/secret-get.js"),
  "secret list": () => import("./commands/secret-list.js"),
  "task cancel": () => import("./commands/task-cancel.js"),
  "task schedule": () => import("./commands/task-schedule.js"),
};
