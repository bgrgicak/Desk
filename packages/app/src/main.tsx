import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { store } from './store/store'
import { ensureSession } from './auth/session'
import { wsConnect } from './store/ws/middleware'

async function boot(): Promise<void> {
  const token = await ensureSession()

  // Connect the WS middleware once we actually have a token. With no
  // token `ensureSession()` returns null and we render the LoginScreen
  // instead — re-trying the WS would just 1008-close.
  if (token) store.dispatch(wsConnect())

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </Provider>
    </StrictMode>,
  )

  // Register the service worker only in built bundles — in `vite dev` the
  // SW would intercept module URLs and break HMR. Wrap in try/catch
  // because Safari throws on `serviceWorker.register` for insecure origins
  // even when the property exists.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js')
    } catch {
      /* registration failed (insecure origin, blocked, etc.) — app works without it */
    }
  }
}

void boot()
