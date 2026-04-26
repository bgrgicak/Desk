import type { HandlerContext } from "../server.js";
import { queries } from "@desk/db";
import { listLibrary } from "@desk/storage";
import { NotFoundError, type File } from "@desk/shared";

export async function handleLibraryList(
  ctx: HandlerContext,
  req: { workspaceId: string; cursor?: string; limit?: number; showHidden?: boolean },
): Promise<{ items: File[]; nextCursor?: string }> {
  const ws = await queries.workspaces.findById(ctx.storage.pool, req.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${req.workspaceId}`);
  return listLibrary(ctx.storage, ws.path, {
    cursor: req.cursor,
    limit: req.limit,
    showHidden: req.showHidden,
  });
}
