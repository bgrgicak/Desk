import type { HandlerContext } from "../server.js";
import { queries } from "@desk/db";
import { generateId, NotFoundError, type Message } from "@desk/shared";

export async function handleChatAttachArtifact(
  ctx: HandlerContext,
  req: { chatId: string; fileId: string },
): Promise<Message> {
  // Verify the file exists
  const file = await queries.files.findById(ctx.pool, req.fileId);
  if (!file) {
    throw new NotFoundError(`File not found: ${req.fileId}`);
  }

  const message = await queries.messages.insert(ctx.pool, {
    id: generateId("message"),
    chatId: req.chatId,
    role: "agent",
    content: { type: "artifactRef", fileId: req.fileId },
  });

  ctx.emit({
    type: "message.appended",
    payload: message,
  });

  return message;
}
