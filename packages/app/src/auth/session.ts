/**
 * Bearer-token session storage and lifecycle.
 *
 * The token is held in sessionStorage — dies with the tab, no CSRF vector
 * (we send it as an Authorization header, not a cookie), lower XSS blast
 * radius than localStorage for a local prototype.
 */
const KEY = "desk.session.token";
const AUTO_LOGIN_DISABLED_KEY = "desk.session.autologin.disabled";
const DEV_USERNAME = "desk";
const DEV_PASSWORD = "change-me-before-first-boot";

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
    sessionStorage.removeItem(AUTO_LOGIN_DISABLED_KEY);
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

function autoLoginEnabled(): boolean {
  try {
    if (sessionStorage.getItem(AUTO_LOGIN_DISABLED_KEY) === "1") return false;
  } catch {
    return false;
  }

  return import.meta.env.VITE_DESK_AUTO_LOGIN !== "off";
}

async function tryAutoLogin(): Promise<string | null> {
  if (!autoLoginEnabled()) return null;

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: DEV_USERNAME, password: DEV_PASSWORD }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) return null;
    setSessionToken(body.token);
    return body.token;
  } catch {
    return null;
  }
}

export async function ensureSession(): Promise<string | null> {
  const existing = getSessionToken();
  if (existing && (await tokenStillAccepted(existing))) {
    return existing;
  }
  clearSessionToken();
  return tryAutoLogin();
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
  try {
    sessionStorage.setItem(AUTO_LOGIN_DISABLED_KEY, "1");
  } catch {
    /* ignore */
  }
  window.location.reload();
}
