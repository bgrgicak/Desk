import type { ToolName } from "@desk/shared";
import type { HandlerContext } from "../server.js";
import { handleFileRead } from "./file-read.js";
import { handleFileWrite } from "./file-write.js";
import { handleLibraryList } from "./library-list.js";
import { handleLibraryGet } from "./library-get.js";
import { handleChatSendMessage } from "./chat-send-message.js";
import { handleChatAttachArtifact } from "./chat-attach-artifact.js";
import { handleWebFetch } from "./web-fetch.js";

type Handler = (ctx: HandlerContext, req: unknown) => Promise<unknown>;

export const handlers: Record<ToolName, Handler> = {
  "file.read": handleFileRead as Handler,
  "file.write": handleFileWrite as Handler,
  "library.list": handleLibraryList as Handler,
  "library.get": handleLibraryGet as Handler,
  "chat.send_message": handleChatSendMessage as Handler,
  "chat.attach_artifact": handleChatAttachArtifact as Handler,
  "web.fetch": handleWebFetch as Handler,
};
