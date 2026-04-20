import { readFileSync } from "node:fs";
import { callTool } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "desk web fetch <url> [--method <m>] [--header k=v]... [--body-file <path>]";

export async function run(argv: string[]): Promise<void> {
  const { flags, positionals } = parseFlags(argv, ["header"]);
  const url = positionals[0];

  if (!url) {
    throw new CliError("INVALID_ARGS", "Usage: " + usage);
  }

  const request: Record<string, unknown> = { url };

  if (typeof flags["method"] === "string") {
    request.method = flags["method"];
  }

  const headerFlag = flags["header"];
  if (headerFlag) {
    const headers: Record<string, string> = {};
    const headerList = Array.isArray(headerFlag) ? headerFlag : [headerFlag];
    for (const h of headerList) {
      const eqIdx = h.indexOf("=");
      if (eqIdx === -1) {
        throw new CliError(
          "INVALID_ARGS",
          `Invalid header format: ${h} (expected key=value)`,
        );
      }
      headers[h.slice(0, eqIdx)] = h.slice(eqIdx + 1);
    }
    request.headers = headers;
  }

  if (typeof flags["body-file"] === "string") {
    const bodyBytes = readFileSync(flags["body-file"]);
    request.bodyBase64 = bodyBytes.toString("base64");
  }

  const result = await callTool("web.fetch", request);
  output(result);
}
