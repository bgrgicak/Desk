import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { store } from './store/store'
import { ensureSession } from './auth/session'
import { setupServiceWorker } from './lib/service-worker'

async function boot(): Promise<void> {
  // ensureSession populates the session token (cookie/storage) so
  // subsequent fetch calls authenticate.  WS connection is deferred
  // to `MustChangeGate` in App.tsx — kicking it off here would race
  // the must-change-password check (the WS upgrade refuses gated
  // users with HTTP 403, which browsers surface as close code 1006;
  // the WS reconnect loop would then back-off-and-retry while the
  // user is stuck on the password-change screen).
  await ensureSession()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </Provider>
    </StrictMode>,
  )

  // Production-only — registers /sw.js, hooks up update detection, and
  // surfaces a Reload toast when a new build is waiting. Dev keeps SW off
  // so HMR module URLs aren't intercepted.
  setupServiceWorker()
}

void boot()
