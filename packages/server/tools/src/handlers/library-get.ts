import type { HandlerContext } from "../server.js";
import { queries } from "@desk/db";
import { NotFoundError, type File } from "@desk/shared";

export async function handleLibraryGet(
  ctx: HandlerContext,
  req: { fileId: string },
): Promise<File & { previewUrl?: string }> {
  const file = await queries.files.findById(ctx.pool, req.fileId);
  if (!file) {
    throw new NotFoundError(`File not found: ${req.fileId}`);
  }
  return { ...file, previewUrl: undefined };
}
