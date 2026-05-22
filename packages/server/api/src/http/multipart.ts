import { type IncomingMessage } from "node:http";
import { type Readable } from "node:stream";
import Busboy from "busboy";
import { ValidationError } from "@roomy-ai/shared";
import { readRawBody } from "./io.js";

/**
 * Parses a multipart/form-data body using Node's built-in Fetch API.
 * Returns a FormData instance; callers pull out parts by field name.
 */
export async function parseMultipart(req: IncomingMessage): Promise<FormData> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new ValidationError("Expected multipart/form-data body");
  }
  const body = await readRawBody(req);
  const r = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Blob([new Uint8Array(body)]),
  });
  try {
    return await r.formData();
  } catch {
    throw new ValidationError("Malformed multipart body");
  }
}

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
