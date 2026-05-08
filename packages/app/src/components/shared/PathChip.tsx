import { File, Folder } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { SANDBOX_HOME } from '@/lib/remark-sandbox-paths'
import { buildPath } from '@/router/nav'

interface PathChipProps {
  /** Original sandbox-absolute path, e.g. /home/agent/report.md */
  sandboxPath: string
  /** User-visible translated path, e.g. ~/Desk/workspaces/desk/report.md */
  displayPath: string
  /** Workspace UUID — when provided, clicking opens the file in the library. */
  workspaceId?: string
}

function isDirectory(path: string): boolean {
  return path.endsWith('/')
}

function workspaceRelativePath(sandboxPath: string): string {
  if (sandboxPath.startsWith(SANDBOX_HOME + '/')) return sandboxPath.slice(SANDBOX_HOME.length + 1)
  if (sandboxPath.startsWith('~/')) return sandboxPath.slice(2)
  return sandboxPath
}

export function PathChip({ sandboxPath, displayPath, workspaceId }: PathChipProps) {
  const isDir = isDirectory(sandboxPath)
  const Icon = isDir ? Folder : File
  const navigate = useNavigate()

  function handleClick() {
    if (!workspaceId) return
    const rel = workspaceRelativePath(sandboxPath)
    if (isDir) {
      navigate(buildPath(workspaceId, 'context', { folder: rel }))
    } else {
      navigate(buildPath(workspaceId, 'context', { item: rel }))
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={workspaceId ? `Open in library: ${displayPath}` : displayPath}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono bg-muted hover:bg-muted/80 text-foreground border border-border/50 transition-colors cursor-pointer align-baseline"
    >
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span>{displayPath.split('/').pop() ?? displayPath}</span>
    </button>
  )
}
