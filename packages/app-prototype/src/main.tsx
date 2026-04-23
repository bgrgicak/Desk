import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import './index.css'
import App from './App.tsx'
import { store } from './store/store'
import { ensureSession } from './auth/login-prompt'

async function boot(): Promise<void> {
  await ensureSession()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </StrictMode>,
  )
}

void boot()
