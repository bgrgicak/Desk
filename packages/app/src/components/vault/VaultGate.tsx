import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Toaster, TooltipProvider } from '@agent-desk/ui'
import { useGetVaultStatusQuery } from '@/store/api'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { closeVaultDialog } from '@/store/slices/uiSlice'
import { VaultDialog } from './VaultDialog'

/**
 * App-level vault gate. Renders children only when the per-user vault
 * is unlocked. Whenever it's locked (including the "no vault yet" case
 * where `exists: false`) the gate replaces the app with the
 * VaultDialog — same shape as MustChangeGate's password screen, just
 * for the credential store. Encrypted credentials are part of the
 * shell; "no unlocked vault" means "no app".
 *
 * - exists: false → dialog renders in setup mode (pick a password + confirm)
 * - exists: true, locked: true → dialog renders in unlock mode
 * - locked: false → children render
 *
 * Ad-hoc opens (e.g. a save mutation that returned 423 mid-session)
 * still go through `openVaultDialog` in Redux. They are redundant with
 * the gate in steady state but useful as a belt-and-braces if the
 * status cache lags.
 */
export function VaultGate({ children }: { children: React.ReactNode }) {
  const dispatch = useAppDispatch()
  const dialogState = useAppSelector((s) => s.ui.vaultDialog)
  const { data: status, isLoading } = useGetVaultStatusQuery()

  // Clear any leftover forced state once the vault is actually unlocked
  // — the dialog isn't visible at that point anyway, this just keeps
  // the slice from leaking the flag into future ad-hoc opens.
  useEffect(() => {
    if (status && !status.locked && dialogState.forced) {
      dispatch(closeVaultDialog())
    }
  }, [status, dialogState.forced, dispatch])

  if (isLoading || !status) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <div className="h-dvh w-full flex items-center justify-center bg-muted/40">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
        </div>
      </TooltipProvider>
    )
  }

  if (status.locked) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <div className="h-dvh w-full bg-muted/40" aria-hidden="true" />
        <VaultDialog open onOpenChange={() => { /* gated, can't dismiss */ }} dismissable={false} />
      </TooltipProvider>
    )
  }

  return (
    <>
      {children}
      <VaultDialog
        open={dialogState.open}
        onOpenChange={(next) => { if (!next) dispatch(closeVaultDialog()) }}
        dismissable={!dialogState.forced}
      />
    </>
  )
}
