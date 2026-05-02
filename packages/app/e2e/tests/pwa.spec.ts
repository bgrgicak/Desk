import { test, expect } from "../fixtures";

// PWA installability boils down to four assets the platform fetches: the
// manifest, the SW script, and the two PNG icons named in the manifest.
// If any of these regresses (404, wrong MIME, bad shape) the install
// prompt silently goes away — these checks are deliberately literal so
// that breakage shows up here, not as "the install button is gone."

test("manifest is served with the manifest MIME and valid shape", async ({ baseURL }) => {
  const res = await fetch(`${baseURL}/manifest.webmanifest`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toMatch(/manifest\+json|application\/json/);
  const manifest = (await res.json()) as {
    name?: string;
    start_url?: string;
    display?: string;
    icons?: Array<{ sizes?: string; type?: string }>;
  };
  expect(manifest.name).toBeTruthy();
  expect(manifest.start_url).toBe("/");
  expect(manifest.display).toBe("standalone");
  // Chrome installability needs at least one PNG icon ≥192px.
  const png192 = manifest.icons?.some((i) => i.type === "image/png" && i.sizes === "192x192");
  expect(png192).toBe(true);
});

test("service worker script is served as JavaScript", async ({ baseURL }) => {
  const res = await fetch(`${baseURL}/sw.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toMatch(/javascript/);
  const body = await res.text();
  expect(body).toContain("addEventListener");
});

test("icon-192 and icon-512 PNGs are served", async ({ baseURL }) => {
  for (const path of ["/icon-192.png", "/icon-512.png"]) {
    const res = await fetch(`${baseURL}${path}`);
    expect(res.status, `${path} status`).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("image/png");
  }
});

test("index.html links the manifest and theme color", async ({ baseURL }) => {
  const res = await fetch(`${baseURL}/`);
  const html = await res.text();
  expect(html).toContain('rel="manifest"');
  expect(html).toContain('href="/manifest.webmanifest"');
  expect(html).toContain('name="theme-color"');
});
