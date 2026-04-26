import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { store } from './store/store'
import { ensureSession } from './auth/auto-login'
import { wsConnect } from './store/ws/middleware'

async function boot(): Promise<void> {
  const token = await ensureSession()

  // Connect the WS middleware once we actually have a token. After an
  // explicit sign-out `ensureSession()` returns null and we render the
  // LoginScreen instead — re-trying the WS would just 1008-close.
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
}

void boot()
