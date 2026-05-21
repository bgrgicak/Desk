import { useMemo } from 'react'
import { Folder as FolderIcon } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@agent-desk/ui'
import type { Folder } from '@/data/ui-types'
import type { MoveTarget } from '@/store/selectors/library'

/**
 * Destination-folder picker shared by the Library list (single +
 * bulk, files & folders) and the file-detail view (single file).
 * `targets === null` keeps it closed. Excludes a target itself and
 * its descendants so an item can't be moved inside itself.
 */
export interface MoveToFolderDialogProps {
  targets: MoveTarget[] | null
  folders: Folder[]
  onClose: () => void
  onMove: (destFolderId: string | null) => void
}

export function MoveToFolderDialog(props: MoveToFolderDialogProps) {
  // Don't mount the dialog (or compute its folder list) until the user
  // actually opens it. The previous unconditional render filtered + sorted
  // the workspace folder list on every commit while closed, which the
  // profile pinned at ~500ms self time during a route change.
  if (props.targets === null) return null
  return <MoveToFolderDialogOpen {...props} targets={props.targets} />
}

function MoveToFolderDialogOpen({
  targets,
  folders,
  onClose,
  onMove,
}: MoveToFolderDialogProps & { targets: MoveTarget[] }) {
  const candidateFolders = useMemo(() => (
    folders
      .filter((f) => {
        for (const t of targets) {
          if (t.path === f.id) return false
          if (f.id.startsWith(`${t.path}/`)) return false
        }
        return true
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  ), [folders, targets])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {targets.length === 1
              ? `Move "${targets[0].name}"`
              : `Move ${targets.length} items`}
          </DialogTitle>
          <DialogDescription>Pick a destination folder.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto py-2 space-y-1">
          <button
            className="w-full text-left rounded-md px-3 py-2 text-sm hover:bg-muted"
            onClick={() => onMove(null)}
          >
            <FolderIcon className="h-4 w-4 mr-2 inline" />
            Library (root)
          </button>
          {candidateFolders.map((f) => (
            <button
              key={f.id}
              className="w-full text-left rounded-md px-3 py-2 text-sm hover:bg-muted"
              onClick={() => onMove(f.id)}
            >
              <FolderIcon className="h-4 w-4 mr-2 inline" />
              {f.id}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
