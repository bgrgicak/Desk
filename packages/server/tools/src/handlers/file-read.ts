import type { HandlerContext } from "../server.js";
import { readFile } from "@desk/storage";
import { NotFoundError, UnauthorizedError } from "@desk/shared";
import { queries } from "@desk/db";

export async function handleFileRead(
  ctx: HandlerContext,
  req: { path: string },
): Promise<{ content: string; mime: string }> {
  const workspaceId = ctx.auth.session.workspaceId;
  if (!workspaceId) throw new UnauthorizedError("Session has no workspace");
  const ws = await queries.workspaces.findById(ctx.storage.pool, workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  const { stream, file } = await readFile(ctx.storage, ws.path, req.path);

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);

  // Return text for text/* mimes, base64 otherwise
  const content = file.mime.startsWith("text/")
    ? buf.toString("utf-8")
    : buf.toString("base64");

  return { content, mime: file.mime };
}
