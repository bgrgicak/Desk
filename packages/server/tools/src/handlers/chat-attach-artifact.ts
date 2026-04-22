import type { HandlerContext } from "../server.js";
import { queries } from "@desk/db";
import { generateId, NotFoundError, type Message } from "@desk/shared";
import { statFile } from "@desk/storage";

export async function handleChatAttachArtifact(
  ctx: HandlerContext,
  req: { chatId: string; path: string },
): Promise<Message> {
  // Verify the file exists on disk.
  const file = await statFile(ctx.storage, req.path).catch(() => null);
  if (!file) {
    throw new NotFoundError(`File not found: ${req.path}`);
  }

  const message = await queries.messages.insert(ctx.pool, {
    id: generateId("message"),
    chatId: req.chatId,
    role: "agent",
    content: { type: "artifactRef", path: req.path, name: file.name, mime: file.mime },
  });

  ctx.emit({
    type: "message.appended",
    payload: message,
  });

  return message;
}
