import { useState } from 'react'
import { motion } from 'framer-motion'
import { Button, Input } from '@roomy-ai/ui'
import { setSessionToken } from '@/auth/session'
import { BackgroundBlobs } from '@/components/layout/BackgroundBlobs'

interface LoginScreenProps {
  // The signup-status probe lives in UnauthenticatedRoot so it can
  // pick the initial screen (signup vs login) before mount. LoginScreen
  // is handed the result so it doesn't duplicate the fetch.
  signupEnabled?: boolean
  onSignUp?: () => void
}

export function LoginScreen({ signupEnabled = false, onSignUp }: LoginScreenProps = {}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center">
      <BackgroundBlobs />

      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-sm mx-4"
      >
        <LoginCard signupEnabled={signupEnabled} onSignUp={onSignUp} />
      </motion.div>
    </div>
  )
}

// ── Login card ────────────────────────────────────────────────────────────────

function LoginCard({ signupEnabled, onSignUp }: { signupEnabled: boolean; onSignUp?: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.status !== 200) {
        if (res.status === 401) {
          setError('Invalid email or password.')
        } else {
          setError(`Login failed (${res.status}).`)
        }
        setIsLoading(false)
        return
      }
      const body = (await res.json()) as { token: string }
      setSessionToken(body.token)
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.')
      setIsLoading(false)
    }
  }

  return (
    <div className="rounded-2xl bg-background/95 backdrop-blur-sm border border-border/60 shadow-2xl px-8 py-10 flex flex-col gap-6">

      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted-foreground mt-1">Sign in to your account</p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium">Email</label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium">Password</label>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              tabIndex={-1}
            >
              Forgot password?
            </button>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </div>

        {error && (
          <p data-testid="login-error" className="text-sm text-destructive">{error}</p>
        )}

        <Button type="submit" className="w-full mt-1" disabled={isLoading} data-testid="login-submit">
          {isLoading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {/* Sign-up link only renders when the server reports signup is
          open — ROOMY_ENABLE_SIGNUP=1, or first-run with no users yet.
          Single-user installs see no signup affordance at all. */}
      {signupEnabled && onSignUp && (
        <p className="text-center text-sm text-muted-foreground" data-testid="signup-link">
          Don&apos;t have an account?{' '}
          <button
            type="button"
            onClick={onSignUp}
            className="text-foreground font-medium hover:underline underline-offset-4 transition-colors"
          >
            Sign up
          </button>
        </p>
      )}
    </div>
  )
}

