import {
  clearSessionToken,
  getSessionToken,
  setSessionToken,
} from "./session";

// TODO: Replace this auto-login with a real login screen. The prototype
// boots straight into the seeded `desk` user so iteration isn't blocked
// on an auth UI; once we ship multi-user or remote use, wire in a
// routed /login page that renders when ensureSession can't silently
// authenticate.
const DEV_USERNAME = "desk";
const DEV_PASSWORD = "change-me-before-first-boot";

// Persistent flag set by `logout()`. When present, ensureSession()
// short-circuits and does NOT auto-login — so the LoginScreen renders
// after an explicit sign-out instead of immediately re-authenticating.
const SIGNED_OUT_KEY = "desk.session.signed_out";

function readSignedOut(): boolean {
  try {
    return localStorage.getItem(SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function setSignedOut(value: boolean): void {
  try {
    if (value) localStorage.setItem(SIGNED_OUT_KEY, "1");
    else localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    /* ignore */
  }
}

async function login(
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
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
    setSignedOut(false);
    return existing;
  }
  if (readSignedOut()) {
    // The user explicitly signed out; surface the LoginScreen instead of
    // silently re-authenticating with the dev creds.
    clearSessionToken();
    return null;
  }
  clearSessionToken();
  const token = await login(DEV_USERNAME, DEV_PASSWORD);
  setSessionToken(token);
  return token;
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
  setSignedOut(true);
  window.location.reload();
}

/** Called from LoginScreen on a successful login to clear the signed-out
 * sticky flag so the next boot can auto-resume the session. */
export function markSignedIn(): void {
  setSignedOut(false);
}
