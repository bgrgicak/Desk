import { useState, type FormEvent } from 'react'
import { Toaster, toast } from 'sonner'
import { Button, Input, TooltipProvider } from '@agent-desk/ui'
import { useChangePasswordMutation } from '@/store/api'
import { extractApiError } from '@/lib/api-error'

/**
 * Forced password-change gate.
 *
 * Rendered at the App root when `me.mustChangePassword` is true.  The
 * server-side `enforceMustChangePassword` middleware refuses every
 * route outside a narrow allowlist (GET /me, POST /me/password,
 * /auth/logout, /auth/signup-status, /health, /ready, /openapi.json)
 * while the flag is set, so the SPA cannot render its normal UI
 * until the user changes the seed password.  This screen is the
 * only thing the user sees in that state.
 *
 * On success the mutation invalidates the User tag; getMe refetches
 * with `mustChangePassword: false`, and the App root falls through
 * to the regular routed UI.
 */
export function ForcedPasswordChangeScreen() {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changePassword, { isLoading }] = useChangePasswordMutation()

  // Mirror the server-side password policy: min length 12 +
  // refuse the documented public seed string verbatim.  Keeps the
  // inline-validation messages from drifting away from what
  // POST /me/password will accept.
  const SEED_PASSWORD = 'change-me-before-first-boot'
  const passwordMismatch =
    newPassword.length > 0 &&
    confirmPassword.length > 0 &&
    newPassword !== confirmPassword
  const tooShort = newPassword.length > 0 && newPassword.length < 12
  const isSeed = newPassword === SEED_PASSWORD
  const canSubmit =
    newPassword.length >= 12 &&
    !isSeed &&
    !passwordMismatch &&
    confirmPassword.length > 0

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!canSubmit) return
    try {
      // `currentPassword` is the documented public seed value — the
      // very fact that the must-change flag is set means the user
      // logged in with it.
      await changePassword({
        currentPassword: SEED_PASSWORD,
        newPassword,
      }).unwrap()
      toast.success('Password updated')
      // getMe invalidation refetches with mustChangePassword=false;
      // App root drops this screen and renders the normal UI.
    } catch (err) {
      toast.error('Could not change password', {
        description: extractApiError(err),
      })
    }
  }

  return (
    <TooltipProvider>
      <Toaster position="bottom-right" />
      <div className="relative flex min-h-screen items-center justify-center bg-muted/40">
        <div className="relative z-10 w-full max-w-sm mx-4">
          <div className="rounded-2xl bg-background/95 backdrop-blur-sm border border-border/60 shadow-2xl px-8 py-10 flex flex-col gap-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-xl font-semibold tracking-tight">
                Choose a new password
              </h1>
              <p className="text-sm text-muted-foreground">
                This installation booted with the documented seed
                password. Pick a new one before continuing — the rest
                of the app is locked until then.
              </p>
            </div>

            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="new-password" className="text-sm font-medium">
                  New password
                </label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={12}
                />
                {tooShort && (
                  <p className="text-xs text-destructive">
                    Minimum 12 characters.
                  </p>
                )}
                {isSeed && (
                  <p className="text-xs text-destructive">
                    Cannot reuse the documented seed password.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="confirm-password" className="text-sm font-medium">
                  Confirm password
                </label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                {passwordMismatch && (
                  <p className="text-xs text-destructive">
                    Passwords don&apos;t match.
                  </p>
                )}
              </div>

              <Button
                type="submit"
                disabled={!canSubmit || isLoading}
                className="w-full mt-1"
              >
                {isLoading ? 'Updating…' : 'Update password and continue'}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
