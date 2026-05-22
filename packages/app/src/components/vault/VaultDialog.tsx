import { useEffect, useState, type FormEvent } from 'react'
import { Lock } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from '@roomy-ai/ui'
import {
  useGetVaultStatusQuery,
  useSetupVaultMutation,
  useUnlockVaultMutation,
} from '@/store/api'
import { extractApiError } from '@/lib/api-error'

interface VaultDialogProps {
  /** Controlled open state. */
  open: boolean
  /** Called when the user closes (only emits `false` — open is driven externally). */
  onOpenChange: (open: boolean) => void
  /**
   * When false, the dialog hides the close affordance and disables
   * escape-to-close — used by the app-load gate where the user must
   * either unlock or sign out. Defaults to true.
   */
  dismissable?: boolean
  /** Extra explanatory line shown above the form. */
  description?: string
  /** Fired once after a successful unlock or setup, before close. */
  onUnlocked?: () => void
}

const MIN_PASSWORD_LENGTH = 8

/**
 * Prompts for the per-user vault master password. Two modes, picked from
 * the live `/vault/status`:
 *
 *  - **unlock**   when the vault exists but is locked — single password
 *                 field.
 *  - **setup**    when no vault exists yet — password + confirm. The user
 *                 owns the secret; the server never sees it again after
 *                 this call.
 *
 * Failures stay inline. The dialog doesn't toast — the parent decides
 * how to react to the surrounding action (retry the original mutation,
 * etc.) via `onUnlocked`.
 */
export function VaultDialog({
  open,
  onOpenChange,
  dismissable = true,
  description,
  onUnlocked,
}: VaultDialogProps) {
  const { data: status, isLoading: statusLoading } = useGetVaultStatusQuery(undefined, {
    // Re-probe whenever the dialog opens, so a stale "locked" cache
    // can't render a misleading setup form.
    refetchOnMountOrArgChange: true,
    skip: !open,
  })

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Reset form whenever the dialog is opened — leftover state from a
  // previous attempt would otherwise leak into the next prompt.
  useEffect(() => {
    if (open) {
      setPassword('')
      setConfirmPassword('')
      setErrorMessage(null)
    }
  }, [open])

  const [unlockVault, { isLoading: unlocking }] = useUnlockVaultMutation()
  const [setupVault, { isLoading: settingUp }] = useSetupVaultMutation()
  const busy = unlocking || settingUp

  const mode: 'unlock' | 'setup' | 'loading' = statusLoading || !status
    ? 'loading'
    : status.exists ? 'unlock' : 'setup'

  const tooShort = mode === 'setup' && password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const passwordMismatch = mode === 'setup' && confirmPassword.length > 0 && password !== confirmPassword
  const canSubmit = mode === 'unlock'
    ? password.length > 0
    : password.length >= MIN_PASSWORD_LENGTH && password === confirmPassword

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!canSubmit || busy) return
    setErrorMessage(null)
    try {
      if (mode === 'setup') {
        await setupVault({ password }).unwrap()
      } else {
        await unlockVault({ password }).unwrap()
      }
      onUnlocked?.()
      onOpenChange(false)
    } catch (err) {
      setErrorMessage(extractApiError(err) ?? 'Something went wrong')
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && !dismissable) return
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={dismissable}
        onEscapeKeyDown={(e) => { if (!dismissable) e.preventDefault() }}
        onPointerDownOutside={(e) => { if (!dismissable) e.preventDefault() }}
        onInteractOutside={(e) => { if (!dismissable) e.preventDefault() }}
      >
        <DialogHeader>
          <div className="mx-auto sm:mx-0 mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-muted">
            <Lock className="h-4 w-4 text-muted-foreground" />
          </div>
          <DialogTitle>
            {mode === 'setup' ? 'Choose a vault password' : 'Unlock secrets vault'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'setup'
              ? 'Your API keys and OAuth tokens are encrypted with this password. Pick one you can remember — we never see it after this step, so it can’t be recovered.'
              : description
                ?? 'Your vault is locked. Enter your vault password to access stored API keys.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="vault-password" className="text-sm font-medium">
              {mode === 'setup' ? 'New password' : 'Password'}
            </label>
            <Input
              id="vault-password"
              type="password"
              autoFocus
              autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy || mode === 'loading'}
              data-testid="vault-password-input"
            />
            {tooShort && (
              <p className="text-xs text-destructive">
                Minimum {MIN_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>

          {mode === 'setup' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="vault-password-confirm" className="text-sm font-medium">
                Confirm password
              </label>
              <Input
                id="vault-password-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={busy}
                data-testid="vault-password-confirm"
              />
              {passwordMismatch && (
                <p className="text-xs text-destructive">Passwords don&apos;t match.</p>
              )}
            </div>
          )}

          {errorMessage && (
            <p className="text-xs text-destructive" role="alert">
              {errorMessage}
            </p>
          )}

          <Button
            type="submit"
            disabled={!canSubmit || busy || mode === 'loading'}
            className="w-full"
            data-testid="vault-submit"
          >
            {busy
              ? (mode === 'setup' ? 'Creating…' : 'Unlocking…')
              : mode === 'setup' ? 'Create vault' : 'Unlock'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
