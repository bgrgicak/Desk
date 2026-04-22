const SESSION_KEY = "desk_session";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

let _token: string | null = null;
let _baseUrl: string = "";

export function setToken(t: string | null) {
  _token = t;
  if (t) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: t, storedAt: Date.now() }));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

export function getToken(): string | null {
  return _token;
}

/** Try to restore a saved session token. Returns true if a valid token was found. */
export function restoreToken(): boolean {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const { token, storedAt } = JSON.parse(raw) as { token: string; storedAt: number };
    if (Date.now() - storedAt > SESSION_MAX_AGE_MS) {
      localStorage.removeItem(SESSION_KEY);
      return false;
    }
    _token = token;
    return true;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return false;
  }
}

export function setBaseUrl(url: string) {
  _baseUrl = url;
}

export function getBaseUrl(): string {
  return _baseUrl;
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  if (_token) headers["Authorization"] = `Bearer ${_token}`;

  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    // Let the browser set Content-Type with the multipart boundary.
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${_baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body,
  });

  let data: T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    data = (await res.json()) as T;
  } else {
    data = (await res.text()) as unknown as T;
  }

  if (res.status === 401) {
    _token = null;
    localStorage.removeItem(SESSION_KEY);
    window.location.href = "/";
  }

  return { status: res.status, data };
}
