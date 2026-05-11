import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { KeyRound, Lock, Plus, Pencil } from 'lucide-react'
import { Button, Input, Textarea, cn } from '@agent-desk/ui'
import {
  useGetVaultStatusQuery,
  useSetupVaultMutation,
  useUnlockVaultMutation,
  useLockVaultMutation,
  useGetSecretsQuery,
  useCreateSecretMutation,
  useUpdateSecretMutation,
} from '@/store/api'
import { describeApiError } from '@/components/settings/errors'

/**
 * Settings → Secrets. The user's KDBX-backed credentials vault.
 *
 * Three states:
 *   1. No vault yet            → setup form (master password + confirm)
 *   2. Vault exists, locked    → unlock form (master password)
 *   3. Vault exists, unlocked  → list + add/edit form
 *
 * Secrets are write-only from the SPA: there is no reveal endpoint by
 * design. Only sandboxed agents can read plaintext, via the host API.
 */
export function SecretsSection() {
  const { data: status, isLoading } = useGetVaultStatusQuery()

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading vault status…</div>
  }
  if (!status) {
    return <div className="text-sm text-muted-foreground">Vault status unavailable.</div>
  }

  if (!status.exists) return <SetupForm />
  if (status.locked) return <UnlockForm />
  return <UnlockedView />
}

// ── Setup ────────────────────────────────────────────────────────────────────

function SetupForm() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [setupVault, { isLoading }] = useSetupVaultMutation()

  const canSubmit = password.length >= 8 && password === confirm

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    try {
      await setupVault({ password }).unwrap()
      toast.success('Secrets vault created')
      setPassword('')
      setConfirm('')
    } catch (err) {
      toast.error('Could not set up vault', { description: describeApiError(err) })
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-md space-y-4">
      <div className="rounded-xl border border-dashed p-6">
        <div className="flex items-center gap-2 mb-3">
          <KeyRound className="h-5 w-5" />
          <h3 className="text-sm font-medium">Set up your secrets vault</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Pick a master password. It encrypts a KDBX file on this host
          and is held in server memory only — re-enter it after every
          server restart and on each new login. The master password
          cannot be recovered if you lose it.
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Master password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
            />
            <p className="text-xs text-muted-foreground/80 mt-1">At least 8 characters.</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Confirm</label>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
      </div>
      <Button type="submit" disabled={!canSubmit || isLoading}>
        {isLoading ? 'Creating…' : 'Create vault'}
      </Button>
    </form>
  )
}

// ── Unlock ──────────────────────────────────────────────────────────────────

function UnlockForm() {
  const [password, setPassword] = useState('')
  const [unlockVault, { isLoading }] = useUnlockVaultMutation()

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password) return
    try {
      await unlockVault({ password }).unwrap()
      setPassword('')
      toast.success('Vault unlocked')
    } catch (err) {
      toast.error('Could not unlock vault', { description: describeApiError(err) })
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-md space-y-4">
      <div className="rounded-xl border border-dashed p-6">
        <div className="flex items-center gap-2 mb-3">
          <Lock className="h-5 w-5" />
          <h3 className="text-sm font-medium">Vault is locked</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Enter your master password to unlock the vault. Agents that
          need stored credentials will fail with a "vault locked" error
          until you do.
        </p>
        <Input
          type="password"
          placeholder="Master password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </div>
      <Button type="submit" disabled={!password || isLoading}>
        {isLoading ? 'Unlocking…' : 'Unlock'}
      </Button>
    </form>
  )
}

// ── Unlocked: list + add/edit ───────────────────────────────────────────────

interface DraftSecret {
  /** Set when editing an existing entry; the title becomes immutable. */
  existingTitle?: string
  title: string
  username: string
  password: string
  url: string
  notes: string
}

const EMPTY_DRAFT: DraftSecret = {
  title: '',
  username: '',
  password: '',
  url: '',
  notes: '',
}

function UnlockedView() {
  const { data: secrets } = useGetSecretsQuery()
  const [lockVault] = useLockVaultMutation()
  const [draft, setDraft] = useState<DraftSecret | null>(null)

  const onLock = async () => {
    try {
      await lockVault().unwrap()
      toast.success('Vault locked')
    } catch (err) {
      toast.error('Could not lock vault', { description: describeApiError(err) })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Secrets</h3>
          <p className="text-xs text-muted-foreground">
            Stored credentials your agents can read. Plaintext is never
            shown here — only sandboxed agents can read the values.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onLock}>
            <Lock className="mr-1.5 h-3.5 w-3.5" /> Lock
          </Button>
          <Button size="sm" onClick={() => setDraft(EMPTY_DRAFT)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add secret
          </Button>
        </div>
      </div>

      {(!secrets || secrets.length === 0) && !draft && (
        <div className="rounded-xl border border-dashed px-6 py-10 text-center">
          <p className="text-sm font-medium">No secrets yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Add a secret to make it available to your agents.
          </p>
        </div>
      )}

      {secrets && secrets.length > 0 && (
        <div className="rounded-xl border divide-y">
          {secrets.map((s) => (
            <div key={s.title} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{s.title}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {[s.username, s.url].filter(Boolean).join(' · ') || 'No username or URL'}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft({
                  existingTitle: s.title,
                  title: s.title,
                  username: s.username ?? '',
                  password: '',
                  url: s.url ?? '',
                  notes: '',
                })}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" /> Update
              </Button>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <DraftEditor
          draft={draft}
          onCancel={() => setDraft(null)}
          onSaved={() => setDraft(null)}
        />
      )}
    </div>
  )
}

function DraftEditor({
  draft, onCancel, onSaved,
}: { draft: DraftSecret; onCancel: () => void; onSaved: () => void }) {
  const [d, setD] = useState(draft)
  useEffect(() => { setD(draft) }, [draft])
  const [createSecret, { isLoading: creating }] = useCreateSecretMutation()
  const [updateSecret, { isLoading: updating }] = useUpdateSecretMutation()

  const isEdit = !!draft.existingTitle
  const isLoading = creating || updating
  const canSubmit = d.title.length > 0 && d.password.length > 0

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    const body = {
      title: d.title,
      password: d.password,
      ...(d.username ? { username: d.username } : {}),
      ...(d.url ? { url: d.url } : {}),
      ...(d.notes ? { notes: d.notes } : {}),
    }
    try {
      if (isEdit) {
        await updateSecret(body).unwrap()
        toast.success(`Updated ${body.title}`)
      } else {
        await createSecret(body).unwrap()
        toast.success(`Saved ${body.title}`)
      }
      onSaved()
    } catch (err) {
      toast.error(isEdit ? 'Could not update secret' : 'Could not save secret', {
        description: describeApiError(err),
      })
    }
  }

  return (
    <form onSubmit={onSubmit} className="rounded-xl border p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Title</label>
          <Input
            value={d.title}
            onChange={(e) => setD({ ...d, title: e.target.value })}
            disabled={isEdit}
            placeholder="e.g. wordpress.org"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Username</label>
          <Input
            value={d.username}
            onChange={(e) => setD({ ...d, username: e.target.value })}
            placeholder="optional"
          />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">
          {isEdit ? 'New password' : 'Password'}
        </label>
        <Input
          type="password"
          value={d.password}
          onChange={(e) => setD({ ...d, password: e.target.value })}
          autoComplete="new-password"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">URL</label>
        <Input
          value={d.url}
          onChange={(e) => setD({ ...d, url: e.target.value })}
          placeholder="optional"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">Notes</label>
        <Textarea
          value={d.notes}
          onChange={(e) => setD({ ...d, notes: e.target.value })}
          rows={3}
          placeholder="optional"
        />
      </div>
      {isEdit && (
        <p className={cn('text-xs', 'text-muted-foreground')}>
          Saving overwrites every field. Leave a field blank to clear it.
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={!canSubmit || isLoading}>
          {isLoading ? 'Saving…' : isEdit ? 'Save changes' : 'Save secret'}
        </Button>
      </div>
    </form>
  )
}
