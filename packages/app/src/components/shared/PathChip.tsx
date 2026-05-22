import { File, Folder } from 'lucide-react'
import { Link } from 'react-router-dom'
import { SANDBOX_HOME } from '@/lib/remark-sandbox-paths'
import { buildPath } from '@/router/nav'
import { useGetLibraryFileQuery } from '@/store/api'

interface PathChipProps {
  /** Original sandbox-absolute path, e.g. /home/agent/report.md */
  sandboxPath: string
  /** User-visible translated path, e.g. ~/Roomy/roomy/report.md */
  displayPath: string
  /** Workspace UUID — when provided, clicking opens the file in the library. */
  workspaceId?: string
}

function normalizeLibraryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}

export function workspaceRelativePath(sandboxPath: string): string {
  if (sandboxPath.startsWith(SANDBOX_HOME + '/')) return sandboxPath.slice(SANDBOX_HOME.length + 1)
  if (sandboxPath.startsWith('~/')) return sandboxPath.slice(2)
  return sandboxPath
}

export function displayBasename(displayPath: string): string {
  const trimmed = displayPath.replace(/\/+$/, '')
  const basename = trimmed.split('/').pop()
  return basename || displayPath
}

export function pathChipHref(workspaceId: string | undefined, sandboxPath: string, isDir: boolean): string | undefined {
  if (!workspaceId) return undefined
  const rel = workspaceRelativePath(sandboxPath)
  return isDir
    ? buildPath(workspaceId, 'context', { folder: normalizeLibraryPath(rel) })
    : buildPath(workspaceId, 'context', { item: rel })
}

export function PathChip({ sandboxPath, displayPath, workspaceId }: PathChipProps) {
  // Per-path metadata lookup. Replaced the previous workspace-wide
  // listing scan because that endpoint no longer returns the full tree —
  // and PathChip is rendered many times in a long chat, making the
  // dedicated /library/meta call far cheaper than re-walking the library.
  const rel = normalizeLibraryPath(workspaceRelativePath(sandboxPath))
  const skipMeta = !workspaceId || !rel || sandboxPath.endsWith('/')
  const { currentData: meta } = useGetLibraryFileQuery(
    { workspaceId: workspaceId ?? '', path: rel },
    { skip: skipMeta },
  )
  const isDir = sandboxPath.endsWith('/') || !rel || !!meta?.isDir
  const Icon = isDir ? Folder : File
  const href = pathChipHref(workspaceId, sandboxPath, isDir)
  const className = "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono bg-muted hover:bg-muted/80 text-foreground border border-border/50 transition-colors cursor-pointer align-baseline no-underline"
  const contents = (
    <>
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span>{displayBasename(displayPath)}</span>
    </>
  )

  if (!href) {
    return (
      <span
        title={displayPath}
        className={className}
      >
        {contents}
      </span>
    )
  }

  return (
    <Link
      to={href}
      title={workspaceId ? `Open in library: ${displayPath}` : displayPath}
      className={className}
    >
      {contents}
    </Link>
  )
}
