import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, FolderKanban, Lock, ShieldCheck, Sparkles, UserRound } from 'lucide-react'
import { Button, Input, cn } from '@roomy-ai/ui'
import { setSessionToken } from '@/auth/session'
import { extractApiError } from '@/lib/api-error'
import { BackgroundBlobs } from '@/components/layout/BackgroundBlobs'
import { WorkspaceForm } from '@/components/workspace/WorkspaceForm'
import { ROOM_PALETTE } from '@/components/rooms/palette'
import { ModelsSection } from '@/components/settings/ModelsSection'
import type { ModelsFocus } from '@/router/nav'

// ── Step model ────────────────────────────────────────────────────────────────

type StepId = 'account' | 'room' | 'vault' | 'models'
const STEPS: readonly StepId[] = ['account', 'room', 'vault', 'models']

interface StepMeta {
  title: string
  description: string
}

const STEP_META: Record<StepId, StepMeta> = {
  account: {
    title: 'Create your account',
    description: 'Your information is used to access and secure your private data.',
  },
  room: {
    title: 'Add a room (optional)',
    description: 'Rooms keep a project’s chats, tasks and library together. You can run everything from Home and add rooms whenever you need them.',
  },
  vault: {
    title: 'Secure your credentials',
    description: 'Roomy encrypts every API key and OAuth token with a password only you know.',
  },
  models: {
    title: 'Add AI providers',
    description: 'Connect a provider so your agents can think. OpenCode’s free models work out of the box — add Claude or ChatGPT for stronger reasoning.',
  },
}

// ── Right panel explainer cards ──────────────────────────────────────────────

interface ExplainerCard {
  icon: typeof Sparkles
  eyebrow: string
  heading: string
  bullets: string[]
}

const EXPLAINER: Record<StepId, ExplainerCard> = {
  account: {
    icon: UserRound,
    eyebrow: 'Welcome to Roomy',
    heading: 'Your private workspace for agents and knowledge',
    bullets: [
      'One account, all your chats, tasks and files in one place.',
      'Everything stays on this server unless you connect a provider.',
      'Sign in from any browser once your account is set up.',
    ],
  },
  room: {
    icon: FolderKanban,
    eyebrow: 'About rooms',
    heading: 'Rooms separate projects so context never leaks',
    bullets: [
      'A room scopes its chats, tasks, library and agent permissions.',
      'Home runs alongside rooms — use it for one-off chats without a project.',
      'Skip this step if you only need Home for now; create rooms later.',
    ],
  },
  vault: {
    icon: ShieldCheck,
    eyebrow: 'About the vault',
    heading: 'Credentials are encrypted with a password only you know',
    bullets: [
      'API keys and OAuth tokens are encrypted at rest with this password.',
      'We never see it after this step, so it can’t be recovered.',
      'You’ll re-enter it after signing in on a new browser.',
    ],
  },
  models: {
    icon: Bot,
    eyebrow: 'About AI providers',
    heading: 'Pick which models power your agents',
    bullets: [
      'OpenCode’s free models are ready to use without a key.',
      'Add Claude or ChatGPT for stronger reasoning — keys stay on this server.',
      'Manage models anytime from My account → AI providers.',
    ],
  },
}

// ── Password strength (account step) ─────────────────────────────────────────

function getStrength(pw: string): number {
  if (!pw) return 0
  let s = 0
  if (pw.length >= 8)             s++
  if (pw.length >= 12)            s++
  if (/[A-Z]/.test(pw))           s++
  if (/[0-9]/.test(pw))           s++
  if (/[^A-Za-z0-9]/.test(pw))    s++
  return Math.min(s, 4)
}

const STRENGTH_LABEL = ['', 'Weak', 'Fair', 'Good', 'Strong']
const STRENGTH_COLOR = ['', 'bg-red-400', 'bg-orange-400', 'bg-yellow-400', 'bg-green-500']

const ACCOUNT_PASSWORD_MIN = 12
const VAULT_PASSWORD_MIN = 8

// ── Step bodies ──────────────────────────────────────────────────────────────

interface AccountData {
  // Stored on the server as `username` but presented to the user as
  // their display name — what the agent calls them in conversation.
  username: string
  email: string
  password: string
  confirmPassword: string
}

function AccountStepBody({ data, onChange }: {
  data: AccountData
  onChange: (next: Partial<AccountData>) => void
}) {
  const strength = getStrength(data.password)
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Your name</label>
        <Input
          autoFocus
          autoComplete="name"
          value={data.username}
          onChange={e => onChange({ username: e.target.value })}
          placeholder="What should we call you?"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Email address</label>
        <Input
          type="email"
          autoComplete="email"
          value={data.email}
          onChange={e => onChange({ email: e.target.value })}
          placeholder="you@example.com"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Password</label>
        <Input
          type="password"
          autoComplete="new-password"
          value={data.password}
          onChange={e => onChange({ password: e.target.value })}
        />
        {data.password.length > 0 && (
          <div className="space-y-1">
            <div className="flex gap-1">
              {[1, 2, 3, 4].map(level => (
                <div
                  key={level}
                  className={cn(
                    'h-1 flex-1 rounded-full transition-colors duration-300',
                    strength >= level ? STRENGTH_COLOR[strength] : 'bg-muted',
                  )}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {STRENGTH_LABEL[strength]}
              {data.password.length < ACCOUNT_PASSWORD_MIN && (
                <span className="ml-1 opacity-70">
                  &middot; minimum {ACCOUNT_PASSWORD_MIN} characters
                </span>
              )}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Confirm password</label>
        <Input
          type="password"
          autoComplete="new-password"
          value={data.confirmPassword}
          onChange={e => onChange({ confirmPassword: e.target.value })}
        />
        {data.confirmPassword.length > 0 && data.password !== data.confirmPassword && (
          <p className="text-xs text-red-500">Passwords don&apos;t match</p>
        )}
      </div>
    </div>
  )
}

function VaultStepBody({
  password, confirmPassword, onPasswordChange, onConfirmChange, error,
}: {
  password: string
  confirmPassword: string
  onPasswordChange: (v: string) => void
  onConfirmChange: (v: string) => void
  error: string | null
}) {
  const tooShort = password.length > 0 && password.length < VAULT_PASSWORD_MIN
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/30 p-3">
        <Lock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Pick a password you can remember. Desk never sees it after this step, so
          if you lose it the encrypted credentials cannot be recovered.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="vault-password" className="text-xs font-medium text-muted-foreground">
          Vault password
        </label>
        <Input
          id="vault-password"
          type="password"
          autoFocus
          autoComplete="new-password"
          value={password}
          onChange={e => onPasswordChange(e.target.value)}
          data-testid="vault-password-input"
        />
        {tooShort && (
          <p className="text-xs text-destructive">Minimum {VAULT_PASSWORD_MIN} characters.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="vault-password-confirm" className="text-xs font-medium text-muted-foreground">
          Confirm vault password
        </label>
        <Input
          id="vault-password-confirm"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={e => onConfirmChange(e.target.value)}
          data-testid="vault-password-confirm"
        />
        {mismatch && <p className="text-xs text-destructive">Passwords don&apos;t match.</p>}
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert">{error}</p>
      )}
    </div>
  )
}

// ── Right panel ──────────────────────────────────────────────────────────────

function ExplainerPanel({ step }: { step: StepId }) {
  const card = EXPLAINER[step]
  const Icon = card.icon
  return (
    <div className="relative flex-1 hidden md:flex flex-col overflow-hidden rounded-r-2xl border-l border-border/50 bg-gradient-to-br from-muted/20 to-muted/40">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className="flex flex-1 flex-col justify-center px-8 py-10"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-background/80 border border-border/60 shadow-sm">
            <Icon className="h-5 w-5 text-foreground/70" />
          </div>
          <p className="mt-5 text-xs font-medium uppercase tracking-wider text-muted-foreground/80">
            {card.eyebrow}
          </p>
          <h2 className="mt-2 text-lg font-semibold leading-snug text-foreground">
            {card.heading}
          </h2>
          <ul className="mt-5 space-y-2.5">
            {card.bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/40" />
                <span className="leading-relaxed">{b}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────

interface SignupScreenProps {
  onSignIn: () => void
  onComplete: () => void
}

interface RoomDraft {
  name: string
  description: string
  color: string
}

export function SignupScreen({ onSignIn, onComplete }: SignupScreenProps) {
  const [stepIndex, setStepIndex] = useState(0)
  const [modelsFocus, setModelsFocus] = useState<ModelsFocus>(null)
  const step = STEPS[stepIndex]
  const totalSteps = STEPS.length
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 0 — account details (collected, not submitted, until the
  // vault step). Holding all wizard input in component state means
  // the only network call that creates server-side state is the final
  // /auth/signup POST. Nothing lands in the DB or on disk if the user
  // abandons the wizard halfway through.
  const [account, setAccount] = useState<AccountData>({
    username: '', email: '', password: '', confirmPassword: '',
  })

  // Step 1 — optional first room. `null` means the user skipped or
  // hasn't visited this step; an object means they filled it in.
  const [roomDraft, setRoomDraft] = useState<RoomDraft | null>(null)

  // Step 2 — vault password. Same deferral story: collected here,
  // submitted with the rest of the wizard.
  const [vaultPassword, setVaultPassword] = useState('')
  const [vaultConfirm, setVaultConfirm] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [stepIndex])

  const goNext = () => {
    setError(null)
    setStepIndex(i => Math.min(i + 1, totalSteps - 1))
  }

  const accountReady = (
    account.username.trim().length > 0
    && account.email.trim().length > 0
    && account.password.length >= ACCOUNT_PASSWORD_MIN
    && account.password === account.confirmPassword
  )

  const vaultReady = (
    vaultPassword.length >= VAULT_PASSWORD_MIN
    && vaultPassword === vaultConfirm
  )

  // Final atomic submit — fires at the end of the vault step. Sends
  // account credentials, optional first room, and vault password in
  // a single request. The server creates the user, hub, optional
  // room, and vault as one unit (with rollback on partial failure)
  // and returns a session token.
  const submitWizard = async () => {
    if (!vaultReady || isSubmitting) return
    setError(null)
    setIsSubmitting(true)
    try {
      const payload: Record<string, unknown> = {
        username: account.username.trim(),
        email: account.email.trim(),
        password: account.password,
        vaultPassword,
      }
      if (roomDraft && roomDraft.name.trim().length > 0) {
        payload.workspace = {
          name: roomDraft.name.trim(),
          description: roomDraft.description.trim() || undefined,
          color: roomDraft.color,
        }
      }
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.status !== 200) {
        let message = `Signup failed (${res.status}).`
        try {
          const body = (await res.json()) as { message?: string }
          if (body.message) message = body.message
        } catch { /* non-JSON */ }
        // Account-level conflicts (409 — username / email taken) need
        // the user back at step 0 to edit their credentials; vault /
        // workspace errors stay on the current step.
        if (res.status === 409) {
          setStepIndex(0)
        }
        setError(message)
        return
      }
      const body = (await res.json()) as { token: string }
      setSessionToken(body.token)
      goNext()
    } catch (err) {
      setError(extractApiError(err) ?? 'Network error while creating account.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Per-step primary action. The room step renders no wizard footer at
  // all — its primary lives inside WorkspaceForm.
  let primary: { label: string; disabled: boolean; onClick: () => void } | null = null
  if (step === 'account') {
    primary = {
      label: 'Continue',
      disabled: !accountReady,
      onClick: goNext,
    }
  } else if (step === 'vault') {
    primary = {
      label: isSubmitting ? 'Creating account…' : 'Create account',
      disabled: !vaultReady || isSubmitting,
      onClick: () => void submitWizard(),
    }
  } else if (step === 'models') {
    primary = {
      label: 'Go to Roomy',
      disabled: false,
      onClick: onComplete,
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center">
      <BackgroundBlobs />

      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-[920px] mx-4"
        style={{ maxHeight: 'calc(100vh - 48px)' }}
      >
        <div
          className="flex rounded-2xl bg-background/95 backdrop-blur-sm border border-border/60 shadow-2xl overflow-hidden"
          style={{ height: '640px' }}
        >
          {/* Left: form */}
          <div className="flex flex-col w-full md:w-[500px] md:shrink-0">
            <div className="shrink-0 px-6 pt-6 pb-4">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={step}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  <p className="text-sm text-muted-foreground mb-3">
                    Step {stepIndex + 1} of {totalSteps}
                  </p>
                  <h1 className="text-xl font-semibold tracking-tight">{STEP_META[step].title}</h1>
                  <p className="text-sm text-muted-foreground mt-1">{STEP_META[step].description}</p>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Body — most steps use the wizard’s scroll container; the
                room and models steps embed components that scroll
                themselves, so we render them outside the scroll wrapper. */}
            {step === 'room' && (
              <RoomStep
                initial={roomDraft ?? { name: '', description: '', color: ROOM_PALETTE[0].value }}
                onContinue={(draft) => {
                  setRoomDraft(draft.name.trim().length > 0 ? draft : null)
                  goNext()
                }}
                onSkip={() => {
                  setRoomDraft(null)
                  goNext()
                }}
              />
            )}
            {step === 'models' && (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <ModelsSection focus={modelsFocus} onChangeFocus={setModelsFocus} />
              </div>
            )}
            {(step === 'account' || step === 'vault') && (
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-5">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={step}
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                  >
                    {step === 'account' && (
                      <AccountStepBody
                        data={account}
                        onChange={d => setAccount(p => ({ ...p, ...d }))}
                      />
                    )}
                    {step === 'vault' && (
                      <VaultStepBody
                        password={vaultPassword}
                        confirmPassword={vaultConfirm}
                        onPasswordChange={setVaultPassword}
                        onConfirmChange={setVaultConfirm}
                        error={null}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            )}

            {/* Footer — the room step renders its own (WorkspaceForm’s
                sticky save bar). Errors for the room step are shown
                inline above WorkspaceForm’s footer via this same block. */}
            {primary !== null ? (
              <div className="shrink-0 px-6 pb-6 pt-4 space-y-3">
                {error && (
                  <p data-testid="signup-error" className="text-sm text-destructive">{error}</p>
                )}
                <Button
                  className="w-full"
                  disabled={primary.disabled}
                  onClick={primary.onClick}
                  data-testid="signup-primary"
                >
                  {primary.label}
                </Button>
                {step === 'account' && (
                  <p className="text-center text-sm text-muted-foreground">
                    Already have an account?{' '}
                    <button
                      type="button"
                      onClick={onSignIn}
                      className="text-foreground font-medium hover:underline underline-offset-4 transition-colors"
                    >
                      Sign in
                    </button>
                  </p>
                )}
              </div>
            ) : error ? (
              <div className="shrink-0 px-6 pb-3">
                <p data-testid="signup-error" className="text-sm text-destructive">{error}</p>
              </div>
            ) : null}
          </div>

          {/* Right: explainer panel */}
          <ExplainerPanel step={step} />
        </div>
      </motion.div>
    </div>
  )
}

// ── Room step (uses the shared WorkspaceForm) ────────────────────────────────

/**
 * The room step is a pure data-collection surface — it does NOT
 * create the workspace server-side. Values are captured and bubbled
 * to the wizard via `onContinue`, which advances to the vault step;
 * the actual workspace creation happens in the final atomic
 * /auth/signup call at the end of the wizard, alongside user + vault
 * creation.
 *
 * The shared WorkspaceForm's `onSubmit` returns a workspace id in
 * its normal usage so the form can attach a freshly uploaded icon to
 * the just-created workspace. During onboarding there's no workspace
 * id yet (creation is deferred), so a custom icon picked at this
 * step would be silently dropped if WorkspaceForm tried to persist
 * it. That's a deliberate, minor trade-off: the user can set the
 * icon from Settings → Workspace right after onboarding finishes,
 * and the alternative (plumbing pending-icon state through the
 * wizard and reattaching after the atomic signup returns) added
 * more surface area than the prototype warrants.
 */
function RoomStep({
  initial, onContinue, onSkip,
}: {
  initial: { name: string; description: string; color: string }
  onContinue: (draft: { name: string; description: string; color: string }) => void
  onSkip: () => void
}) {
  return (
    <WorkspaceForm
      key="onboarding-room"
      mode="create"
      initial={initial}
      submitLabel="Continue"
      onSubmit={async (vals) => {
        onContinue({
          name: vals.name,
          description: vals.description,
          color: vals.color,
        })
        // No server-side id yet — the wizard atomically creates the
        // workspace at the very end alongside the user account.
        return undefined
      }}
      footerStart={
        <Button
          variant="ghost"
          size="sm"
          onClick={onSkip}
          data-testid="signup-skip-room"
        >
          Skip for now
        </Button>
      }
    />
  )
}
