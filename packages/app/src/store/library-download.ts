import { getSessionToken } from "@/auth/session";

export async function downloadLibraryFile(opts: {
  workspaceId: string;
  path: string;
  filename: string;
}): Promise<void> {
  const params = new URLSearchParams({
    workspaceId: opts.workspaceId,
    path: opts.path,
  });
  const token = getSessionToken();
  const res = await fetch(`/api/library/download?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = opts.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Fetches a library file's content for in-app preview. Returns the blob and
 * the ETag from the response (mtime in ms, unquoted) so callers can detect
 * conflicts on subsequent saves.
 */
export async function fetchLibraryContent(opts: {
  workspaceId: string;
  path: string;
}): Promise<{ blob: Blob; etag: string | null }> {
  const params = new URLSearchParams({
    workspaceId: opts.workspaceId,
    path: opts.path,
  });
  const token = getSessionToken();
  const res = await fetch(`/api/library/content?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`Preview failed (${res.status})`);
  }
  const raw = res.headers.get("etag");
  const etag = raw ? raw.replace(/^"|"$/g, "") : null;
  return { blob: await res.blob(), etag };
}

export type SaveResult =
  | { conflict: false; etag: string | null }
  | { conflict: true; content: string; etag: string };

/**
 * Overwrites an existing library file's contents. When `etag` is provided it
 * is sent as `If-Match`; a mismatch returns `{ conflict: true, content, etag }`
 * with the server's current content so the caller can show a merge view.
 */
export async function saveLibraryContent(opts: {
  workspaceId: string;
  path: string;
  body: string | Blob;
  contentType?: string;
  etag?: string | null;
}): Promise<SaveResult> {
  const params = new URLSearchParams({
    workspaceId: opts.workspaceId,
    path: opts.path,
  });
  const token = getSessionToken();
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType ?? "application/octet-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.etag) headers["If-Match"] = `"${opts.etag}"`;
  const res = await fetch(`/api/library/content?${params.toString()}`, {
    method: "PUT",
    headers,
    body: opts.body,
  });
  if (res.status === 409) {
    const body = await res.json() as { conflict: boolean; content: string; etag: string };
    return { conflict: true, content: body.content, etag: body.etag };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail ? `Save failed (${res.status}): ${detail}` : `Save failed (${res.status})`);
  }
  const raw = res.headers.get("etag");
  const etag = raw ? raw.replace(/^"|"$/g, "") : null;
  return { conflict: false, etag };
}
