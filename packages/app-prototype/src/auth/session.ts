/**
 * Bearer-token session storage.
 *
 * The token is held in sessionStorage — dies with the tab, no CSRF vector
 * (we send it as an Authorization header, not a cookie), lower XSS blast
 * radius than localStorage for a local prototype.
 */
const KEY = "desk.session.token";

export function getSessionToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* private mode / quota — token is gone, caller will re-prompt */
  }
}

export function clearSessionToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
