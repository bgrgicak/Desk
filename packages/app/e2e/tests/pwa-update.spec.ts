import { test, expect } from "../fixtures";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The built SW lives under packages/app/dist and is what `vite preview`
// serves at /sw.js. Tests rewrite the VERSION constant in-place to
// simulate a re-deploy without re-running `vite build`. The browser only
// uses the SW bytes to decide "is this an update", so a few-byte flip is
// indistinguishable from a real build.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SW_PATH = resolve(__dirname, "..", "..", "dist", "sw.js");

function readSw(): string {
  return readFileSync(SW_PATH, "utf8");
}

function readSwVersion(): string {
  const match = readSw().match(/const VERSION = '([^']+)'/);
  if (!match) throw new Error(`Could not find VERSION constant in ${SW_PATH}`);
  return match[1];
}

function readSwStaticAssetRevision(): string {
  const match = readSw().match(/const STATIC_ASSET_REVISION = '([^']+)'/);
  if (!match) throw new Error(`Could not find STATIC_ASSET_REVISION constant in ${SW_PATH}`);
  return match[1];
}

function swCacheName(version: string): string {
  return `roomy-app-${version}-${readSwStaticAssetRevision()}`;
}

function rewriteSwVersion(newVersion: string): void {
  const replaced = readSw().replace(
    /const VERSION = '[^']+'/,
    `const VERSION = '${newVersion}'`,
  );
  writeFileSync(SW_PATH, replaced);
}

test.describe.serial("PWA update flow", () => {
  // Snapshot the original SW bytes so we can restore them even if a test
  // mid-flow fails after mutating them. Otherwise the mutated VERSION
  // would leak into other specs that share dist/.
  let originalSw: string;
  let originalVersion: string;
  let originalCacheName: string;

  test.beforeAll(() => {
    originalSw = readSw();
    originalVersion = readSwVersion();
    originalCacheName = swCacheName(originalVersion);
  });

  test.afterAll(() => {
    writeFileSync(SW_PATH, originalSw);
  });

  test.beforeEach(() => {
    // Some other test in this describe may have mutated dist/sw.js.
    // Reset to the original so each test starts from a known baseline
    // and only this test's rewrite is what the browser sees.
    writeFileSync(SW_PATH, originalSw);
  });

  test("first install activates the SW, populates the cache, and does NOT prompt", async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return {
        active: reg.active?.scriptURL ?? null,
        waiting: reg.waiting?.scriptURL ?? null,
        caches: await caches.keys(),
      };
    });
    expect(state.active).toContain("/sw.js");
    expect(state.waiting).toBeNull();
    const appCaches = state.caches.filter((k) => k.startsWith("roomy-app-"));
    expect(appCaches).toHaveLength(1);
    expect(appCaches[0]).toBe(originalCacheName);

    // The prompt MUST NOT appear on a cold install — that's how we
    // distinguish "this is your first visit" from "an update arrived
    // while you weren't looking". The toast logic gates on
    // `navigator.serviceWorker.controller` being truthy at install
    // time, which is only the case for updates.
    await expect(
      page.getByText("A new version of Roomy is available"),
    ).toBeHidden({ timeout: 1500 });
  });

  test("an updated SW activates immediately and the page reloads automatically", async ({ page, baseURL }) => {
    // Cold visit → install the baseline SW.
    await page.goto(baseURL!);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      // Wait until this page is actually under SW control. clients.claim()
      // in activate races the navigation; without this the .update() below
      // may install a new SW with no controller present, so the
      // controllerchange reload is skipped and the test would time out.
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
        });
      }
    });

    // Simulate a deploy by flipping the VERSION constant in dist/sw.js.
    const newVersion = `${originalVersion}-test-${Date.now()}`;
    rewriteSwVersion(newVersion);
    const newCacheName = swCacheName(newVersion);

    // Force the browser to refetch /sw.js. The new SW calls skipWaiting()
    // during install, so it activates immediately (no "waiting" phase).
    // service-worker.ts's controllerchange handler then reloads the page.
    const reloadPromise = page.waitForNavigation({ timeout: 10_000 });
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      // Don't await — the page reload triggered by controllerchange will
      // destroy the execution context before reg.update() resolves.
      void reg.update();
    });
    await reloadPromise;

    // The update is silent — no "A new version of Roomy is available" toast.
    await expect(
      page.getByText("A new version of Roomy is available"),
    ).toBeHidden({ timeout: 2000 });

    // After the automatic reload the new SW is active with no worker waiting,
    // and the old cache has been dropped by the activate handler.
    await expect.poll(
      async () => {
        try {
          return await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            return {
              waiting: reg?.waiting?.scriptURL ?? null,
              caches: await caches.keys(),
            };
          });
        } catch (err) {
          if (String((err as Error)?.message ?? err).includes("Execution context was destroyed")) {
            return { waiting: "navigation-in-progress", caches: [] };
          }
          throw err;
        }
      },
      { timeout: 8000, message: "waiting for new SW to activate and old cache to be dropped" },
    ).toEqual({
      waiting: null,
      caches: [newCacheName],
    });
  });
});
