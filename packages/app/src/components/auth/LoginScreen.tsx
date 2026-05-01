import { useState } from 'react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setSessionToken } from '@/auth/session'

export function LoginScreen() {
  return (
    <div className="relative flex min-h-screen items-center justify-center">
      {/* Full-screen background */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: 'url(/background2.jpg)' }}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-sm mx-4"
      >
        <LoginCard />
      </motion.div>
    </div>
  )
}

// ── Login card ────────────────────────────────────────────────────────────────

function LoginCard() {
  const [username, setUsername] = useState('')
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
        body: JSON.stringify({ username, password }),
      })
      if (res.status !== 200) {
        if (res.status === 401) {
          setError('Invalid username or password.')
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

      {/* Logo */}
      <div className="flex flex-col items-center gap-5">
        <DeskLogo className="h-7 w-auto text-foreground" />
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in to your account</p>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="username" className="text-sm font-medium">Username</label>
          <Input
            id="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={e => setUsername(e.target.value)}
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

      {/* Sign up — disabled until multi-user signup ships server-side */}
      <p className="text-center text-sm text-muted-foreground" data-testid="signup-coming-soon">
        Don&apos;t have an account?{' '}
        <span className="text-muted-foreground/70 font-medium" title="Account signup coming soon">
          Sign up — coming soon
        </span>
      </p>
    </div>
  )
}

// ── Desk logo ─────────────────────────────────────────────────────────────────

function DeskLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 58 21"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Desk"
    >
      <path d="M47.3203 0C47.919 0 48.3184 0.499147 48.3184 0.998047C48.3178 1.69716 46.6553 4.79062 46.6553 11.9736C46.6553 14.0024 46.9877 15.7653 47.3535 17.0957C48.6839 13.9694 50.3473 12.0071 54.2051 10.0781C54.3381 10.0116 54.4383 9.97755 54.6045 9.97754C55.1034 9.97754 55.6357 10.377 55.6357 10.9756C55.6357 11.3082 55.4693 11.6081 55.1699 11.8076C55.0021 11.9083 53.3076 12.9728 53.3076 15.2998C53.3078 17.9932 56.599 18.9244 56.8994 18.9912C57.2985 19.1243 57.6309 19.4904 57.6309 19.9561C57.6308 20.5545 57.1325 20.9539 56.6338 20.9541C56.4675 20.9541 51.3117 19.9892 51.3115 15.2998C51.3115 14.9672 51.3447 14.5677 51.3779 14.3682C50.0145 15.765 49.2829 17.3948 48.252 20.2881C48.1189 20.6872 47.7194 20.9541 47.3203 20.9541C46.8883 20.9539 46.5891 20.6546 46.4561 20.4219C46.3895 20.2556 44.6602 16.8628 44.6602 11.9736C44.6602 9.37935 44.9263 7.0507 45.1924 5.3877C43.1303 7.78242 40.8021 10.1779 38.873 12.373C39.3718 13.2377 39.6709 14.2689 39.6709 15.2998C39.6708 17.2954 38.7728 20.9537 36.0127 20.9541C34.2167 20.9541 33.3516 19.3236 33.3516 17.96C33.3517 16.1973 34.6488 14.4016 36.2451 12.4395C35.8127 12.1401 35.2803 11.9736 34.6816 11.9736C31.9211 11.9738 29.0937 14.6348 27.3975 16.3311C25.801 17.9276 23.0076 20.9538 20.0479 20.9541C20.0464 20.9541 20.0445 20.9531 20.043 20.9531L20.04 20.9541C16.2485 20.9541 12.3898 19.2575 12.3896 15.2998C12.3896 12.506 14.4188 9.97754 17.3789 9.97754C19.2414 9.97758 20.705 11.4413 20.7051 13.3037C20.7051 15.5987 18.8754 17.561 16.9131 18.459C17.8111 18.7916 18.9425 18.958 20.04 18.958H20.0479C21.7441 18.9576 24.2716 16.663 26.001 14.9336C27.6307 13.3039 30.7903 9.97766 34.6816 9.97754C35.7459 9.97754 36.7106 10.3438 37.5088 10.9092C40.5354 7.45019 44.4936 3.55898 46.4893 0.46582C46.6887 0.166587 46.9879 0.000116897 47.3203 0ZM5.98633 0.332031C9.27907 0.332031 13.3037 2.49443 13.3037 6.31934C13.3037 10.5433 10.077 13.171 7.2832 15.3994C5.62029 16.7297 3.95717 18.0604 2.69336 19.3242C2.49386 19.5236 2.26108 19.623 1.99512 19.623C1.46314 19.623 0.997336 19.1579 0.99707 18.626C0.99707 18.3599 1.09731 18.1263 1.29688 17.9268C2.69375 16.5299 4.35662 15.1995 6.01953 13.8691C8.87988 11.5742 11.3076 9.4125 11.3076 6.31934C11.3076 4.15743 8.68039 2.32812 5.98633 2.32812C3.95752 2.32814 3.42577 2.89392 2.86035 3.8252C2.36148 4.65677 1.99512 6.71889 1.99512 8.98047C1.99513 11.2752 2.12864 13.603 2.29492 14.4346C2.29492 14.5011 2.32812 14.5682 2.32812 14.6348C2.32789 15.1335 1.92853 15.6318 1.33008 15.6318C0.864457 15.6318 0.465035 15.2996 0.365234 14.834C0.132426 13.6699 1.34625e-05 11.3418 0 8.98047C0 4.09127 0.964121 0.332064 5.98633 0.332031ZM37.4756 14.0693C36.0791 15.8317 35.3469 17.2946 35.3467 17.96C35.3467 18.7249 35.6801 18.958 36.0127 18.958C36.5782 18.9571 37.6747 17.2948 37.6748 15.2998C37.6748 14.8676 37.6085 14.4351 37.4756 14.0693ZM17.3789 11.9736C15.6826 11.9736 14.3857 13.4372 14.3857 15.2998C14.3858 15.9981 14.5513 16.5306 14.8506 16.9629C16.6466 16.8631 18.709 14.9002 18.709 13.3037C18.7089 12.5056 18.177 11.9737 17.3789 11.9736Z" />
    </svg>
  )
}
