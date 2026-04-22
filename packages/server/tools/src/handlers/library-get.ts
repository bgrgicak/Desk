import type { HandlerContext } from "../server.js";
import { NotFoundError, type File } from "@desk/shared";
import { statFile } from "@desk/storage";

export async function handleLibraryGet(
  ctx: HandlerContext,
  req: { path: string },
): Promise<File & { previewUrl?: string }> {
  try {
    const ref = await statFile(ctx.storage, req.path);
    return { ...ref, previewUrl: undefined };
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    throw new NotFoundError(`File not found: ${req.path}`);
  }
}
