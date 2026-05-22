import { useRef } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@roomy-ai/ui'
import { useCreateWorkspaceMutation } from '@/store/api'
import type { ServerWorkspace } from '@/store/types'
import { ROOM_PALETTE } from '@/components/rooms/palette'
import { WorkspaceForm, type WorkspaceFormValues } from '@/components/workspace/WorkspaceForm'

function errMsg(err: unknown): string | undefined {
  if (typeof err === 'object' && err && 'data' in err) {
    const data = (err as { data?: unknown }).data
    if (typeof data === 'string') return data
    if (typeof data === 'object' && data && 'message' in data) {
      const m = (data as { message?: unknown }).message
      if (typeof m === 'string') return m
    }
  }
  return undefined
}

interface CreateWorkspaceModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a room is created (and its icon attached) so the
   *  parent can navigate into it. */
  onCreated: (ws: ServerWorkspace) => void
}

/**
 * Room (workspace) creation dialog opened from the Home sidebar's
 * "Rooms +" button. Uses the shared `WorkspaceForm` so it matches the
 * Settings → Workspace panel (and the My account tab) exactly.
 */
export function CreateWorkspaceModal({
  open,
  onOpenChange,
  onCreated,
}: CreateWorkspaceModalProps) {
  const [createWorkspace, { isLoading }] = useCreateWorkspaceMutation()
  const createdRef = useRef<ServerWorkspace | null>(null)

  const handleSubmit = async (vals: WorkspaceFormValues): Promise<string | undefined> => {
    try {
      const ws = await createWorkspace({
        name: vals.name,
        description: vals.description || undefined,
        color: vals.color,
      }).unwrap()
      createdRef.current = ws
      return ws.id
    } catch (err) {
      toast.error('Failed to create room', { description: errMsg(err) })
      return undefined
    }
  }

  const handleDone = () => {
    const ws = createdRef.current
    createdRef.current = null
    onOpenChange(false)
    if (ws) onCreated(ws)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] p-0 gap-0 sm:max-w-[640px] overflow-hidden"
        style={{ height: 'min(560px, calc(100dvh - 1rem))' }}
      >
        {/* Header inlined (not <DialogHeader>) — the primitive bakes in
            a `gap-2` on its flex column that twMerge respects but
            still surprises visually when we want a very tight title
            + description block. Writing the layout directly gives us
            exact control over the gap and the bottom padding. */}
        <div className="border-b px-4 pt-3 pb-2">
          <DialogTitle className="leading-tight">Create a room</DialogTitle>
          <DialogDescription className="text-xs leading-snug text-muted-foreground">
            A room keeps a workspace's chats, tasks and library together.
          </DialogDescription>
        </div>

        {/* Remount on open so a cancelled draft doesn't persist. */}
        {open && (
          <WorkspaceForm
            key="create"
            mode="create"
            initial={{ name: '', description: '', color: ROOM_PALETTE[0].value }}
            submitLabel="Create room"
            busy={isLoading}
            onSubmit={handleSubmit}
            onDone={handleDone}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
