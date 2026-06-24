import { createHash } from "node:crypto";
import * as path from "node:path";

export const LIBRARY_COOKIE_PREFIX = "roomy_libapp_";

export function librarySessionAppKey(appPath: string): string {
  return appPath.endsWith(".app") ? appPath.slice(0, -".app".length) : appPath;
}

function libraryCookieKey(appPathOrName: string): string {
  const appPath = appPathOrName.endsWith(".app") || appPathOrName.includes("/")
    ? appPathOrName
    : `${appPathOrName}.app`;
  return librarySessionAppKey(appPath);
}

function libraryCookieAppName(appPathOrName: string): string {
  const appPath = appPathOrName.endsWith(".app") || appPathOrName.includes("/")
    ? appPathOrName
    : `${appPathOrName}.app`;
  return path.basename(appPath, ".app");
}

export function libraryCookieNameFor(workspaceId: string, appPathOrName: string): string {
  const appName = libraryCookieAppName(appPathOrName);
  const appHash = createHash("sha256")
    .update(libraryCookieKey(appPathOrName))
    .digest("hex")
    .slice(0, 16);
  return `${LIBRARY_COOKIE_PREFIX}${workspaceId}_${appHash}_${appName}`;
}

function legacyLibraryCookieNameFor(workspaceId: string, appName: string): string {
  return `${LIBRARY_COOKIE_PREFIX}${workspaceId}_${appName}`;
}

function isRootLibraryAppPath(appPath: string): boolean {
  return !libraryCookieKey(appPath).includes("/");
}

export function libraryCookieWorkspaceId(cookieName: string, appName: string): string | null {
  const suffix = `_${appName}`;
  if (!cookieName.startsWith(LIBRARY_COOKIE_PREFIX) || !cookieName.endsWith(suffix)) {
    return null;
  }
  const middle = cookieName.slice(
    LIBRARY_COOKIE_PREFIX.length,
    cookieName.length - suffix.length,
  );
  const pathAware = /^(.*)_[a-f0-9]{16}$/.exec(middle);
  return pathAware?.[1] ?? middle;
}

export function findLibraryCookieEntry(
  cookies: Record<string, string>,
  opts: { workspaceId?: string | null; appPath: string; appName: string },
): [string, string] | undefined {
  if (opts.workspaceId) {
    const exact = libraryCookieNameFor(opts.workspaceId, opts.appPath);
    if (cookies[exact]) return [exact, cookies[exact]];
    const legacy = legacyLibraryCookieNameFor(opts.workspaceId, opts.appName);
    if (isRootLibraryAppPath(opts.appPath) && cookies[legacy]) {
      return [legacy, cookies[legacy]];
    }
    return undefined;
  }

  return Object.entries(cookies).find(
    ([name]) => libraryCookieWorkspaceId(name, opts.appName) !== null,
  );
}
