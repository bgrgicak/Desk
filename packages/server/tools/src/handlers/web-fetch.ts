import type { HandlerContext } from "../server.js";
import { ForbiddenError } from "@desk/shared";

// Minimal SSRF guard: block private/link-local/loopback ranges
const BLOCKED_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd00:/i,
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(hostname));
}

export async function handleWebFetch(
  _ctx: HandlerContext,
  req: { url: string; method?: string; headers?: Record<string, string>; bodyBase64?: string },
): Promise<{ status: number; headers: Record<string, string>; bodyBase64: string }> {
  const url = new URL(req.url);
  if (isBlockedHost(url.hostname)) {
    throw new ForbiddenError(`Blocked host: ${url.hostname}`);
  }

  const fetchOpts: RequestInit = {
    method: req.method ?? "GET",
    headers: req.headers,
  };

  if (req.bodyBase64) {
    fetchOpts.body = Buffer.from(req.bodyBase64, "base64");
  }

  const response = await fetch(req.url, fetchOpts);
  const body = Buffer.from(await response.arrayBuffer());

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    headers: responseHeaders,
    bodyBase64: body.toString("base64"),
  };
}
