import type { HandlerContext } from "../server.js";
import { queries } from "@desk/db";
import { generateId, type Message } from "@desk/shared";

export async function handleChatSendMessage(
  ctx: HandlerContext,
  req: { chatId: string; content: string },
): Promise<Message> {
  const message = await queries.messages.insert(ctx.pool, {
    id: generateId("message"),
    chatId: req.chatId,
    role: "agent",
    content: { type: "text", text: req.content },
  });

  ctx.emit({
    type: "message.appended",
    payload: message,
  });

  return message;
}
