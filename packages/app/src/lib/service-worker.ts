import { toast } from 'sonner'

// Registers the production service worker and surfaces a Reload toast
// when a new build is sitting in the SW "waiting" slot. In dev we leave
// SW registration off entirely — Vite HMR already keeps modules fresh,
// and an active SW intercepts the dev module URLs and breaks reloads.
//
// Flow:
//   1. register('/sw.js')
//   2. If a worker is already `waiting` AND we have a controller, this
//      is the "user opened the app and there's an update queued from a
//      previous visit" case. Prompt immediately.
//   3. On `updatefound`, watch the installing worker. Once it reaches
//      `installed`, if there's already a controller, the new worker is
//      an update (not a first install). Prompt.
//   4. When the user accepts, postMessage SKIP_WAITING. The SW activates
//      and `controllerchange` fires on this page; we reload so the new
//      assets are loaded fresh.
//   5. Poll `registration.update()` periodically so a tab left open for
//      hours still notices a deploy without a full restart.
export function setupServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  // First-install on a fresh browser: our SW calls clients.claim() in
  // activate, which fires controllerchange even though there was no
  // prior version — that's the initial handoff, not an update. Reloading
  // there would surprise the user with a refresh seconds after they
  // opened the app. Swallow exactly one such event when no SW was
  // controlling at startup; every subsequent controllerchange is a real
  // upgrade and triggers the reload.
  let pendingInitialClaim = !navigator.serviceWorker.controller
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (pendingInitialClaim) {
      pendingInitialClaim = false
      return
    }
    if (reloading) return
    reloading = true
    window.location.reload()
  })

  void (async () => {
    let registration: ServiceWorkerRegistration
    try {
      registration = await navigator.serviceWorker.register('/sw.js')
    } catch {
      // Registration can fail on insecure origins (Safari) or when the
      // SW file is blocked by a CSP / network policy. The app works
      // fine without it; just give up silently.
      return
    }

    if (registration.waiting && navigator.serviceWorker.controller) {
      void promptForUpdate(registration.waiting)
    }

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        if (
          installing.state === 'installed' &&
          navigator.serviceWorker.controller
        ) {
          void promptForUpdate(installing)
        }
      })
    })

    // 30 minutes — long enough to be cheap, short enough that a tab
    // someone left open overnight notices a deploy by morning.
    const POLL_INTERVAL_MS = 30 * 60 * 1000
    setInterval(() => {
      registration.update().catch(() => {})
    }, POLL_INTERVAL_MS)
  })()
}

async function promptForUpdate(worker: ServiceWorker): Promise<void> {
  // The running bundle only knows the OLD version (it was inlined when the
  // bundle was built). Ask the waiting worker for its own VERSION constant
  // so the toast can name the new version the user is upgrading to.
  const newVersion = await fetchWorkerVersion(worker)
  toast('A new version of Roomy is available', {
    id: 'sw-update', // de-dupe in case updatefound fires twice
    description: newVersion
      ? `Reload to update from ${__APP_VERSION__} to ${newVersion}.`
      : 'Reload to apply the update.',
    duration: Infinity,
    action: {
      label: 'Reload',
      onClick: () => worker.postMessage({ type: 'SKIP_WAITING' }),
    },
  })
}

function fetchWorkerVersion(worker: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    // 800ms is generous — the SW handler runs synchronously on
    // postMessage receipt, so this resolves almost immediately. The
    // timeout exists for the case where an older SW is in waiting that
    // doesn't know how to answer GET_VERSION; we just show the
    // version-less toast instead of hanging.
    const timer = setTimeout(() => resolve(null), 800)
    channel.port1.onmessage = (event) => {
      clearTimeout(timer)
      const data = event.data as { version?: unknown } | null
      resolve(typeof data?.version === 'string' ? data.version : null)
    }
    try {
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2])
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}
