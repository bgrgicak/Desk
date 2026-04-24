import type { HandlerContext } from "../server.js";
import { queries } from "@desk/db";
import { NotFoundError, UnauthorizedError, type File } from "@desk/shared";
import { statFile } from "@desk/storage";

export async function handleLibraryGet(
  ctx: HandlerContext,
  req: { path: string },
): Promise<File & { previewUrl?: string }> {
  const workspaceId = ctx.auth.session.workspaceId;
  if (!workspaceId) throw new UnauthorizedError("Session has no workspace");
  const ws = await queries.workspaces.findById(ctx.storage.pool, workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  try {
    const ref = await statFile(ctx.storage, ws.path, req.path);
    return { ...ref, previewUrl: undefined };
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    throw new NotFoundError(`File not found: ${req.path}`);
  }
}
