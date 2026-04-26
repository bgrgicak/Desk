/**
 * Converts a workspace name into a filesystem-safe slug:
 * lowercase, alnum + hyphens, collapsed consecutive hyphens, no leading/
 * trailing hyphen. Empty result falls back to `workspace` so we always
 * return a usable directory name.
 */
export function slugifyWorkspaceName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "workspace";
}
