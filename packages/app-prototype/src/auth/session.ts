/**
 * Bearer-token session storage and lifecycle.
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

// Sessions live in memory on the API server — a server restart wipes
// them even before the 7-day TTL kicks in. We probe /me before reusing
// a stored token so a stale one doesn't leave the app rendering 401s.
async function tokenStillAccepted(token: string): Promise<boolean> {
  try {
    const res = await fetch("/api/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureSession(): Promise<string | null> {
  const existing = getSessionToken();
  if (existing && (await tokenStillAccepted(existing))) {
    return existing;
  }
  clearSessionToken();
  return null;
}

export async function logout(): Promise<void> {
  const token = getSessionToken();
  if (token) {
    // Fire-and-forget — if the server rejects we still drop the client token.
    fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  clearSessionToken();
  window.location.reload();
}
