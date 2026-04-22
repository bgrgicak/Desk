import type { HandlerContext } from "../server.js";
import { readFile } from "@desk/storage";

export async function handleFileRead(
  ctx: HandlerContext,
  req: { path: string },
): Promise<{ content: string; mime: string }> {
  const { stream, file } = await readFile(ctx.storage, req.path);

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
