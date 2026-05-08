import { File, Folder } from 'lucide-react'
import { toast } from 'sonner'
import { SANDBOX_HOME } from '@/lib/remark-sandbox-paths'

interface PathChipProps {
  /** Original sandbox-absolute path, e.g. /home/agent/report.md */
  sandboxPath: string
  /** User-visible translated path, e.g. ~/Desk/workspaces/desk/report.md */
  displayPath: string
}

function isDirectory(path: string): boolean {
  // Heuristic: no extension → treat as directory.
  const last = path.split('/').pop() ?? ''
  return !last.includes('.')
}

function workspaceRelativePath(sandboxPath: string): string {
  return sandboxPath.startsWith(SANDBOX_HOME + '/')
    ? sandboxPath.slice(SANDBOX_HOME.length + 1)
    : sandboxPath
}

export function PathChip({ sandboxPath, displayPath }: PathChipProps) {
  const isDir = isDirectory(sandboxPath)
  const Icon = isDir ? Folder : File

  function handleClick() {
    void navigator.clipboard.writeText(workspaceRelativePath(sandboxPath)).then(() => {
      toast.success('Path copied')
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`Copy path: ${displayPath}`}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono bg-muted hover:bg-muted/80 text-foreground border border-border/50 transition-colors cursor-pointer align-baseline"
    >
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span>{displayPath}</span>
    </button>
  )
}
