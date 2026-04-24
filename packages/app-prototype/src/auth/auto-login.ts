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

export async function ensureSession(): Promise<string> {
  const existing = getSessionToken();
  if (existing && (await tokenStillAccepted(existing))) return existing;

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
  window.location.reload();
}
