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
 * Fetches a library file's content for in-app preview. The blob carries
 * the server-sent MIME type so callers can branch on it. Callers that
 * render via `<img>`/`<iframe>` should pass the blob to `URL.createObjectURL`
 * and revoke on unmount; callers rendering text should use `blob.text()`.
 */
export async function fetchLibraryContent(opts: {
  workspaceId: string;
  path: string;
}): Promise<Blob> {
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
  return res.blob();
}

/**
 * Overwrites an existing library file's contents. Fails if the path doesn't
 * already exist on the server — use the upload mutation for new files.
 */
export async function saveLibraryContent(opts: {
  workspaceId: string;
  path: string;
  body: string | Blob;
  contentType?: string;
}): Promise<void> {
  const params = new URLSearchParams({
    workspaceId: opts.workspaceId,
    path: opts.path,
  });
  const token = getSessionToken();
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType ?? "application/octet-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/library/content?${params.toString()}`, {
    method: "PUT",
    headers,
    body: opts.body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail ? `Save failed (${res.status}): ${detail}` : `Save failed (${res.status})`);
  }
}
