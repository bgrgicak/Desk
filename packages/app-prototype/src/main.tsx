import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import './index.css'
import App from './App.tsx'
import { store } from './store/store'
import { ensureSession } from './auth/login-prompt'
import { wsConnect } from './store/ws/middleware'

async function boot(): Promise<void> {
  await ensureSession()

  // Connect the WS middleware. It manages its own socket lifecycle +
  // exponential-backoff reconnect, dispatches ws/event actions, and
  // patches RTK Query caches for server-pushed events.
  store.dispatch(wsConnect())

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </StrictMode>,
  )
}

void boot()
