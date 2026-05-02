import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

// ── Constants ─────────────────────────────────────────────────────────────────

const CAROUSEL_SLIDES = [
  { bg: '#EEF2FF' },
  { bg: '#F0FDF4' },
  { bg: '#FFF7ED' },
  { bg: '#FDF4FF' },
  { bg: '#F0F9FF' },
]

const EMOJI_OPTIONS = [
  '🏡','💼','🎨','📚','🚀','💡','🌿','⚡',
  '🎯','🔬','💻','🎵','🌍','⭐','🏆','🔒',
  '🌊','🦋','🍀','🔥','🧠','🌸','🎭','🐝',
]

const COLOR_OPTIONS = [
  { value: '#fef3c7', label: 'Amber'  },
  { value: '#dbeafe', label: 'Blue'   },
  { value: '#fce7f3', label: 'Pink'   },
  { value: '#d1fae5', label: 'Green'  },
  { value: '#ede9fe', label: 'Purple' },
  { value: '#ffedd5', label: 'Orange' },
  { value: '#fee2e2', label: 'Red'    },
  { value: '#ccfbf1', label: 'Teal'   },
]

type ProviderKind = 'claude' | 'chatgpt'

const PROVIDERS: { kind: ProviderKind; name: string; placeholder: string }[] = [
  { kind: 'claude',  name: 'Claude',   placeholder: 'sk-ant-…' },
  { kind: 'chatgpt', name: 'ChatGPT',  placeholder: 'sk-…'     },
]

type Step = 0 | 1 | 2

const STEP_META: { title: string; description: string }[] = [
  { title: 'Create your account',    description: 'Your information is used to access and secure your private data.'              },
  { title: 'Set up your workspace',  description: 'Workspaces keep your projects, agents, and context organized and separate.'    },
  { title: 'Connect an AI provider', description: 'Connect an AI provider to power your agents. You can add more later in Settings.' },
]

// ── Password strength ─────────────────────────────────────────────────────────

function getStrength(pw: string): number {
  if (!pw) return 0
  let s = 0
  if (pw.length >= 8)             s++
  if (pw.length >= 12)            s++
  if (/[A-Z]/.test(pw))          s++
  if (/[0-9]/.test(pw))          s++
  if (/[^A-Za-z0-9]/.test(pw))   s++
  return Math.min(s, 4)
}

const STRENGTH_LABEL = ['', 'Weak', 'Fair', 'Good', 'Strong']
const STRENGTH_COLOR = ['', 'bg-red-400', 'bg-orange-400', 'bg-yellow-400', 'bg-green-500']

// ── Brand glyphs ──────────────────────────────────────────────────────────────

function ClaudeLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden className={className}>
      <path fill="currentColor" d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zM6.569 3.52h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.673 20H0L6.569 3.52zm4.132 9.959L8.453 7.687 6.205 13.479z" />
    </svg>
  )
}

function OpenAILogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden className={className}>
      <path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.748-7.073zm-9.022 12.608a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.759a.795.795 0 0 0 .393-.681v-6.737l2.02 1.169a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494zm-9.66-4.126a4.471 4.471 0 0 1-.535-3.013l.142.085 4.783 2.758a.771.771 0 0 0 .78 0l5.843-3.368v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.499 4.499 0 0 1-6.14-1.647zM2.341 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.814 3.354-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786a4.504 4.504 0 0 1-1.647-6.14zm16.597 3.856L13.104 8.364l2.015-1.164a.076.076 0 0 1 .071 0l4.83 2.79a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.41 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.499 4.499 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.056V6.074A4.499 4.499 0 0 1 13.626 2.62l-.142.08L8.7 5.46a.795.795 0 0 0-.393.681zm1.098-2.365 2.602-1.5 2.607 1.5v3l-2.598 1.5-2.607-1.5z" />
    </svg>
  )
}

// ── Right carousel panel ──────────────────────────────────────────────────────

function CarouselPanel() {
  const [active, setActive] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setActive(i => (i + 1) % CAROUSEL_SLIDES.length), 10_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="relative flex-1 overflow-hidden rounded-r-2xl border-l border-border/50">
      <AnimatePresence initial={false}>
        <motion.div
          key={active}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6, ease: 'easeInOut' }}
          className="absolute inset-0"
          style={{ backgroundColor: CAROUSEL_SLIDES[active].bg }}
        />
      </AnimatePresence>

      {/* Dot indicators */}
      <div className="absolute bottom-5 left-0 right-0 flex justify-center gap-1.5">
        {CAROUSEL_SLIDES.map((_, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            aria-label={`Slide ${i + 1}`}
            className={cn(
              'h-1.5 rounded-full transition-all duration-300',
              i === active ? 'w-4 bg-foreground/50' : 'w-1.5 bg-foreground/20 hover:bg-foreground/35',
            )}
          />
        ))}
      </div>
    </div>
  )
}

// ── Step forms ────────────────────────────────────────────────────────────────

interface AccountData {
  username: string
  email: string
  password: string
  confirmPassword: string
}

function AccountStep({ data, onChange }: {
  data: AccountData
  onChange: (next: Partial<AccountData>) => void
}) {
  const strength = getStrength(data.password)
  const strengthLabel = STRENGTH_LABEL[strength]
  const strengthColor = STRENGTH_COLOR[strength]

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Username</label>
        <Input
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          value={data.username}
          onChange={e => onChange({ username: e.target.value })}
          placeholder="e.g. jsmith"
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
                    strength >= level ? strengthColor : 'bg-muted',
                  )}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{strengthLabel}</p>
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
          <p className="text-xs text-red-500">Passwords don't match</p>
        )}
      </div>
    </div>
  )
}

interface WorkspaceData {
  name: string
  emoji: string
  color: string
  description: string
}

function WorkspaceStep({ data, onChange }: {
  data: WorkspaceData
  onChange: (next: Partial<WorkspaceData>) => void
}) {
  return (
    <div className="space-y-4">
      {/* Preview + name */}
      <div className="flex items-center gap-3">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-2xl select-none"
          style={{ backgroundColor: data.color }}
        >
          {data.emoji}
        </div>
        <Input
          placeholder="Workspace name"
          value={data.name}
          onChange={e => onChange({ name: e.target.value })}
          className="flex-1"
        />
      </div>

      {/* Color */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">Color</p>
        <div className="flex gap-2 flex-wrap">
          {COLOR_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              title={label}
              onClick={() => onChange({ color: value })}
              className={cn(
                'h-6 w-6 rounded-full transition-all',
                data.color === value ? 'ring-2 ring-offset-2 ring-foreground/40 scale-110' : 'hover:scale-110',
              )}
              style={{ backgroundColor: value }}
            />
          ))}
        </div>
      </div>

      {/* Emoji */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">Icon</p>
        <div className="grid grid-cols-8 gap-1">
          {EMOJI_OPTIONS.map(e => (
            <button
              key={e}
              type="button"
              onClick={() => onChange({ emoji: e })}
              className={cn(
                'flex items-center justify-center h-8 w-8 rounded-md text-lg transition-colors',
                data.emoji === e ? 'bg-muted ring-1 ring-ring/40' : 'hover:bg-muted',
              )}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      {/* Description */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">
          Description <span className="opacity-50">(optional)</span>
        </p>
        <Textarea
          placeholder="What's this workspace for?"
          value={data.description}
          onChange={e => onChange({ description: e.target.value })}
          rows={2}
          className="resize-none"
        />
      </div>
    </div>
  )
}

interface AISetupData {
  kind: ProviderKind | null
  apiKey: string
}

function AISetupStep({ data, onChange }: {
  data: AISetupData
  onChange: (next: Partial<AISetupData>) => void
}) {
  return (
    <div className="space-y-5">
      {/* Provider picker */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Provider</p>
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map(p => (
            <button
              key={p.kind}
              type="button"
              onClick={() => onChange({ kind: p.kind, apiKey: '' })}
              className={cn(
                'flex items-center gap-2.5 rounded-xl border p-3.5 text-left transition-colors',
                data.kind === p.kind
                  ? 'border-foreground/30 bg-muted/50'
                  : 'hover:bg-muted/40',
              )}
            >
              <ProviderGlyph kind={p.kind} />
              <span className="text-sm font-medium">{p.name}</span>
              {data.kind === p.kind && (
                <Check className="ml-auto h-3.5 w-3.5 text-foreground/60" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* API key */}
      {data.kind && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="space-y-1.5"
        >
          <p className="text-xs font-medium text-muted-foreground">API key</p>
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            value={data.apiKey}
            onChange={e => onChange({ apiKey: e.target.value })}
            placeholder={PROVIDERS.find(p => p.kind === data.kind)?.placeholder}
          />
          <p className="text-xs text-muted-foreground/70">Stored locally and never sent to our servers.</p>
        </motion.div>
      )}
    </div>
  )
}

function ProviderGlyph({ kind }: { kind: ProviderKind }) {
  if (kind === 'claude') {
    return (
      <span className="shrink-0 h-8 w-8 rounded-lg flex items-center justify-center bg-[#F5E6DA] text-[#CC785C]">
        <ClaudeLogo className="h-[18px] w-[18px]" />
      </span>
    )
  }
  return (
    <span className="shrink-0 h-8 w-8 rounded-lg flex items-center justify-center bg-black text-white">
      <OpenAILogo className="h-[18px] w-[18px]" />
    </span>
  )
}


// ── Main export ───────────────────────────────────────────────────────────────

interface SignupScreenProps {
  onSignIn: () => void
  onComplete: () => void
}

export function SignupScreen({ onSignIn, onComplete }: SignupScreenProps) {
  const [step, setStep] = useState<Step>(0)

  const [account, setAccount] = useState<AccountData>({
    username: '', email: '', password: '', confirmPassword: '',
  })
  const [workspace, setWorkspace] = useState<WorkspaceData>({
    name: 'General', emoji: '🏡', color: '#fef3c7', description: '',
  })
  const [aiSetup, setAISetup] = useState<AISetupData>({ kind: null, apiKey: '' })

  const scrollRef = useRef<HTMLDivElement>(null)

  // Scroll form area back to top on step change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [step])

  const canProceed = (() => {
    if (step === 0) {
      return (
        account.username.trim() &&
        account.email.trim() &&
        account.password.length >= 6 &&
        account.password === account.confirmPassword
      )
    }
    if (step === 1) return !!workspace.name.trim()
    return true // AI setup is always skippable
  })()

  const primaryLabel = (() => {
    if (step === 0) return 'Set up workspace'
    if (step === 1) return 'Set up AI'
    const hasCredentials = aiSetup.kind && aiSetup.apiKey.trim()
    return hasCredentials ? 'Go to Desk' : 'Skip to Desk'
  })()

  const handlePrimary = async () => {
    if (step < 2) {
      setStep(s => (s + 1) as Step)
    } else {
      onComplete()
    }
  }

  return (
    <div
      className="relative z-10 w-full max-w-[860px] mx-4"
      style={{ maxHeight: 'calc(100vh - 48px)' }}
    >
      <div className="flex rounded-2xl bg-background/95 backdrop-blur-sm border border-border/60 shadow-2xl overflow-hidden" style={{ height: '600px' }}>

        {/* ── Left: form ── */}
        <div className="flex flex-col w-[480px] shrink-0">

          {/* Step counter + heading (non-scrolling) */}
          <div className="shrink-0 px-6 pt-6 pb-4">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <p className="text-sm text-muted-foreground mb-3">Step {step + 1} of 3</p>
                <h1 className="text-xl font-semibold tracking-tight">{STEP_META[step].title}</h1>
                <p className="text-sm text-muted-foreground mt-1">{STEP_META[step].description}</p>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Scrollable form body */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-5">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                {step === 0 && (
                  <AccountStep data={account} onChange={d => setAccount(p => ({ ...p, ...d }))} />
                )}
                {step === 1 && (
                  <WorkspaceStep data={workspace} onChange={d => setWorkspace(p => ({ ...p, ...d }))} />
                )}
                {step === 2 && (
                  <AISetupStep data={aiSetup} onChange={d => setAISetup(p => ({ ...p, ...d }))} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Footer — no top border, sticks at bottom via shrink-0 */}
          <div className="shrink-0 px-6 pb-6 pt-4 space-y-3">
            <div className="flex flex-col gap-2">
              <Button
                className="w-full"
                disabled={!canProceed}
                onClick={handlePrimary}
              >
                {primaryLabel}
              </Button>
              {step > 0 && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setStep(s => (s - 1) as Step)}
                >
                  Back
                </Button>
              )}
            </div>

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
          </div>
        </div>

        {/* ── Right: carousel ── */}
        <CarouselPanel />
      </div>
    </div>
  )
}
