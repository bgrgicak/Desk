import {
  clearSessionToken,
  getSessionToken,
  setSessionToken,
} from "./session";

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

/**
 * Boot gate. Reads `sessionStorage`; if missing, pops two window.prompt()
 * dialogs for username/password, POSTs /auth/login, stores the token.
 *
 * Retries on auth failure so a mistyped password doesn't leave the app
 * without a session. Throws only on network errors.
 *
 * Intentionally not a designed screen — see plan §4.
 */
export async function ensureSession(): Promise<string> {
  const existing = getSessionToken();
  if (existing) return existing;

  while (true) {
    const username = window.prompt("Desk username");
    if (!username) continue;
    const password = window.prompt("Desk password");
    if (!password) continue;

    try {
      const token = await login(username, password);
      setSessionToken(token);
      return token;
    } catch {
      window.alert("Invalid credentials. Try again.");
    }
  }
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
