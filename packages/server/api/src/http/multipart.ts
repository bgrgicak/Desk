import { type IncomingMessage } from "node:http";
import { type Readable } from "node:stream";
import Busboy from "busboy";
import { ValidationError } from "@roomy-ai/shared";

/**
 * Streaming multipart parser for single-file uploads. Text fields must
 * appear before the file part in the body (the client must append them
 * first). The returned stream is busboy's raw file stream — callers must
 * consume it fully so the underlying HTTP request drains.
 */
export function parseMultipartFileStream(req: IncomingMessage): Promise<{
  name: string;
  mime: string;
  stream: Readable;
  subpath?: string;
}> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return Promise.reject(new ValidationError("Expected multipart/form-data body"));
  }
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const fields: Record<string, string> = {};
    let resolved = false;

    bb.on("field", (fieldname, value) => { fields[fieldname] = value; });

    bb.on("file", (fieldname, fileStream, info) => {
      if (fieldname !== "file" || resolved) {
        fileStream.resume();
        return;
      }
      resolved = true;
      const name = info.filename || fields["name"] || "upload";
      const mime = info.mimeType || "application/octet-stream";
      const subpath = fields["subpath"] && fields["subpath"] !== "" ? fields["subpath"] : undefined;
      resolve({ name, mime, stream: fileStream, subpath });
    });

    bb.on("error", reject);
    bb.on("close", () => {
      if (!resolved) reject(new ValidationError("Missing 'file' part in multipart body"));
    });

    req.pipe(bb);
  });
}
