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

/**
 * Slug suffixes reserved for server-internal workspace kinds. The API
 * rejects user-created workspaces whose slug ends in one of these so a
 * user cannot impersonate or hijack an internal slot (e.g. another
 * user's hub). Future kinds add their own suffix here.
 */
export const RESERVED_WORKSPACE_SLUG_SUFFIXES = ["-hub"] as const;

/** Returns true when `slug` ends with any reserved suffix. */
export function isReservedWorkspaceSlug(slug: string): boolean {
  return RESERVED_WORKSPACE_SLUG_SUFFIXES.some((suffix) => slug.endsWith(suffix));
}

/**
 * Builds the slug for a user's hub workspace. The `{user-slug}-hub` shape
 * lets a user identify their slice of `~/Roomy/` from the host filesystem,
 * since project workspaces stay anonymous on disk.
 */
export function hubSlugForUser(userSlug: string): string {
  const base = slugifyWorkspaceName(userSlug);
  return `${base}-hub`;
}
