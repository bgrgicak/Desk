let _token: string | null = null;
let _baseUrl: string = "";

export function setToken(t: string | null) {
  _token = t;
}

export function getToken(): string | null {
  return _token;
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

  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }

  const res = await fetch(`${_baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: bodyStr,
  });

  let data: T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    data = (await res.json()) as T;
  } else {
    data = (await res.text()) as unknown as T;
  }

  return { status: res.status, data };
}
