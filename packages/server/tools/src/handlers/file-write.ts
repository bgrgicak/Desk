import { Readable } from "node:stream";
import type { HandlerContext } from "../server.js";
import { uploadArtifact } from "@desk/storage";
import type { File } from "@desk/shared";

export async function handleFileWrite(
  ctx: HandlerContext,
  req: { workspaceId: string; name: string; mime: string; contentBase64: string; chatId?: string },
): Promise<File> {
  const buf = Buffer.from(req.contentBase64, "base64");
  const stream = Readable.from(buf);

  return uploadArtifact(ctx.storage, {
    workspaceId: req.workspaceId,
    chatId: req.chatId,
    name: req.name,
    mime: req.mime,
    stream,
  });
}
