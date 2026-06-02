import type { MouseEvent } from 'react'
import { File, Folder, Zap } from 'lucide-react'
import { Link } from 'react-router-dom'
import { isAppDirectory } from '@/data/file-kind'
import { SANDBOX_HOME } from '@/lib/remark-sandbox-paths'
import { buildPath } from '@/router/nav'
import { useGetLibraryFileQuery } from '@/store/api'
import { useAppDispatch } from '@/store/hooks'
import { openArtifact } from '@/store/slices/previewPanelSlice'

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
  const normalizedRel = normalizeLibraryPath(rel)
  const isAppDir = isAppDirectory(displayBasename(normalizedRel))
  return isDir && !isAppDir
    ? buildPath(workspaceId, 'context', { folder: normalizedRel })
    : buildPath(workspaceId, 'context', { item: isAppDir ? normalizedRel : rel })
}

export function looksLikeDirectoryPath(path: string): boolean {
  const name = displayBasename(path)
  if (!name || name === '/') return false
  if (name.endsWith('.app')) return true
  // Agent messages often mention directories without a trailing slash
  // (`/home/agent/roomy`). Until `/library/meta` returns, treat a basename
  // without an extension as a directory so plain clicks do not open the right
  // preview panel with an unpreviewable folder. Once metadata is available it
  // wins, so extensionless files like LICENSE still open in the sidebar.
  return !name.includes('.')
}

export function PathChip({ sandboxPath, displayPath, workspaceId }: PathChipProps) {
  const dispatch = useAppDispatch()
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
  const isKnownDir = sandboxPath.endsWith('/') || !rel || !!meta?.isDir
  const isDir = isKnownDir || (!meta && looksLikeDirectoryPath(rel))
  const isAppDir = isAppDirectory(displayBasename(rel))
  const Icon = isAppDir ? Zap : isDir ? Folder : File
  const href = pathChipHref(workspaceId, sandboxPath, isDir)
  // A file chip opens the in-chat preview panel on plain click rather
  // than navigating to the Library detail page. Directories keep Library
  // navigation; modifier clicks fall through to the <Link> so the detail
  // page can still open in a new tab.
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (isDir || !workspaceId) return
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    e.preventDefault()
    dispatch(openArtifact({ workspaceId, path: rel, name: displayBasename(displayPath), mime: meta?.mime }))
  }
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
      onClick={handleClick}
      title={workspaceId ? `Open in library: ${displayPath}` : displayPath}
      className={className}
    >
      {contents}
    </Link>
  )
}
