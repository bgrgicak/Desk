import type { HandlerContext } from "../server.js";
import { listLibrary } from "@desk/storage";
import type { File } from "@desk/shared";

export async function handleLibraryList(
  ctx: HandlerContext,
  req: { workspaceId: string; cursor?: string; limit?: number },
): Promise<{ items: File[]; nextCursor?: string }> {
  return listLibrary(ctx.storage, req.workspaceId, {
    cursor: req.cursor,
    limit: req.limit,
  });
}
