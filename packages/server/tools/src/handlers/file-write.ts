import { Readable } from "node:stream";
import type { HandlerContext } from "../server.js";
import { uploadArtifact } from "@desk/storage";
import { NotFoundError, type File } from "@desk/shared";
import { queries } from "@desk/db";

export async function handleFileWrite(
  ctx: HandlerContext,
  req: { workspaceId: string; name: string; mime: string; contentBase64: string; chatId?: string },
): Promise<File> {
  const buf = Buffer.from(req.contentBase64, "base64");
  const stream = Readable.from(buf);
  const ws = await queries.workspaces.findById(ctx.storage.pool, req.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${req.workspaceId}`);

  return uploadArtifact(ctx.storage, {
    workspaceId: req.workspaceId,
    workspaceSlug: ws.path,
    chatId: req.chatId,
    name: req.name,
    mime: req.mime,
    stream,
  });
}
