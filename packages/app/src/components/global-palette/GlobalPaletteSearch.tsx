import { useMemo } from 'react'
import { MessageSquare, FileText, Sparkles, Briefcase } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@agent-desk/ui'
import { useGetLibraryQuery, useGetWorkspacesQuery, useSearchQuery } from '@/store/api'
import { useAppSelector } from '@/store/hooks'
import { useGlobalPalette } from './GlobalPaletteProvider'
import { useGlobalChats } from './globalChatStore'
import {
  filterSettingsTargets, filterWorkspaceTargets,
  SETTINGS_TARGETS, WORKSPACE_TARGETS,
  type NavTarget, type SearchTarget, type SettingsTarget,
} from './searchTargets'
import type { ServerFile } from '@/store/types'

interface GlobalPaletteSearchProps {
  activeWorkspaceId?: string
  onNavigatePage: (target: NavTarget) => void
  onNavigateSettings: (target: SettingsTarget) => void
  onNavigateWorkspace: (workspaceId: string) => void
  onSelectChat: (chat: { id: string; workspaceId: string }) => void
  onSelectFile: (file: { path: string; workspaceId: string }) => void
}

// Match the visual weight of the previous chat search palette: taller input
// + larger items. These are the same overrides that CommandDialog applies.
const PALETTE_SIZING = [
  '**:data-[slot=command-input-wrapper]:h-12',
  '[&_[cmdk-input]]:h-12',
  '[&_[cmdk-input-wrapper]_svg]:h-5',
  '[&_[cmdk-input-wrapper]_svg]:w-5',
  '[&_[cmdk-item]]:px-2',
  '[&_[cmdk-item]]:py-3',
  '[&_[cmdk-item]_svg]:h-5',
  '[&_[cmdk-item]_svg]:w-5',
].join(' ')

export function GlobalPaletteSearch({
  activeWorkspaceId,
  onNavigatePage,
  onNavigateSettings,
  onNavigateWorkspace,
  onSelectChat,
  onSelectFile,
}: GlobalPaletteSearchProps) {
  const { query, setQuery, startNewChat, openChat } = useGlobalPalette()
  const trimmed = query.trim()
  const isSearching = trimmed.length > 0

  const globalChats = useGlobalChats()
  const savedArtifactIds = useAppSelector(s => s.ui.savedArtifactIds)

  const { data: libraryResp } = useGetLibraryQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId },
  )
  const libraryFiles = libraryResp?.items ?? []

  const { data: workspaces = [] } = useGetWorkspacesQuery()

  const { data: searchResults = [] } = useSearchQuery(
    { q: trimmed, scope: 'all' },
    { skip: !isSearching || trimmed.length < 2 },
  )

  // First section (no heading): up to 8 most recent global Ask AI chats.
  // Workspace chats are intentionally excluded — they live in their
  // workspace's sidebar; this surface is for cross-workspace AI history.
  const recentChats = useMemo(() => {
    if (isSearching) return null
    return [...globalChats]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
  }, [isSearching, globalChats])

  // "Recently viewed" — saved artifacts only (sorted by createdAt desc).
  const recentArtifacts = useMemo<ServerFile[] | null>(() => {
    if (isSearching) return null
    const saved = new Set(savedArtifactIds)
    return libraryFiles
      .filter(f => saved.has(f.path))
      .slice()
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, 8)
  }, [isSearching, libraryFiles, savedArtifactIds])

  const workspaceMatches = useMemo(() => filterWorkspaceTargets(trimmed), [trimmed])
  const settingsMatches  = useMemo(() => filterSettingsTargets(trimmed), [trimmed])
  const workspaceListMatches = useMemo(() => {
    if (!isSearching) return []
    const needle = trimmed.toLowerCase()
    return workspaces.filter(w => w.name.toLowerCase().includes(needle))
  }, [isSearching, workspaces, trimmed])

  const chatResults = useMemo(() => searchResults.filter(r => r.type === 'chat'), [searchResults])
  const fileResults = useMemo(() => searchResults.filter(r => r.type === 'file'), [searchResults])

  const hasAnyResults =
    workspaceMatches.length + settingsMatches.length + workspaceListMatches.length +
    chatResults.length + fileResults.length > 0

  const renderTarget = (t: SearchTarget) => {
    const onSelect = t.kind === 'page'
      ? () => onNavigatePage(t)
      : () => onNavigateSettings(t)
    return (
      <CommandItem key={t.id} value={t.id} onSelect={onSelect}>
        <t.icon className="text-muted-foreground" />
        <span>{t.label}</span>
      </CommandItem>
    )
  }

  return (
    <Command shouldFilter={false} className={PALETTE_SIZING}>
      <CommandInput
        placeholder="Ask a question or search across all workspaces"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[576px]">
        <CommandEmpty>No results found.</CommandEmpty>

        {/* No-results path: lead with Ask AI */}
        {isSearching && !hasAnyResults && (
          <CommandGroup heading="Ask AI">
            <CommandItem value={`ask-ai:${trimmed}`} onSelect={() => startNewChat(trimmed)}>
              <Sparkles className="text-muted-foreground" />
              <span className="truncate">{trimmed}</span>
            </CommandItem>
          </CommandGroup>
        )}

        {/* Default view ─ no query: recent global Ask AI chats. */}
        {!isSearching && recentChats && recentChats.length > 0 && (
          <CommandGroup>
            {recentChats.map(c => (
              <CommandItem
                key={`gchat:${c.id}`}
                value={`gchat:${c.id}`}
                onSelect={() => openChat(c.id)}
              >
                <Sparkles className="text-muted-foreground" />
                <span className="truncate">{c.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {!isSearching && recentArtifacts && recentArtifacts.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recently viewed">
              {recentArtifacts.map(f => {
                const ws = activeWorkspaceId ?? ''
                const wsInfo = workspaces.find(w => w.id === ws)
                return (
                  <CommandItem
                    key={`art:${f.path}`}
                    value={`art:${f.path}`}
                    onSelect={() => onSelectFile({ path: f.path, workspaceId: ws })}
                  >
                    <FileText className="text-muted-foreground" />
                    <span className="truncate">{f.name}</span>
                    {wsInfo && (
                      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                        <span className="leading-none">{wsInfo.icon}</span>
                        <span className="truncate max-w-[140px]">{wsInfo.name}</span>
                      </span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </>
        )}

        {!isSearching && (
          <>
            <CommandSeparator />
            <CommandGroup heading="This workspace">
              {WORKSPACE_TARGETS.map(renderTarget)}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Settings">
              {SETTINGS_TARGETS.map(renderTarget)}
            </CommandGroup>
          </>
        )}

        {/* Search state */}
        {isSearching && chatResults.length > 0 && (
          <CommandGroup heading="Chats">
            {chatResults.map(r => {
              const ws = activeWorkspaceId ?? ''
              return (
                <CommandItem
                  key={`s-chat:${r.id}`}
                  value={`s-chat:${r.id}`}
                  onSelect={() => onSelectChat({ id: r.id, workspaceId: ws })}
                >
                  <MessageSquare className="text-muted-foreground" />
                  <span className="truncate">{r.title}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
        {isSearching && fileResults.length > 0 && (
          <CommandGroup heading="Files">
            {fileResults.map(r => {
              const ws = activeWorkspaceId ?? ''
              return (
                <CommandItem
                  key={`s-file:${r.id}`}
                  value={`s-file:${r.id}`}
                  onSelect={() => onSelectFile({ path: r.id, workspaceId: ws })}
                >
                  <FileText className="text-muted-foreground" />
                  <span className="truncate">{r.title}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
        {isSearching && workspaceMatches.length > 0 && (
          <CommandGroup heading="This workspace">
            {workspaceMatches.map(renderTarget)}
          </CommandGroup>
        )}
        {isSearching && settingsMatches.length > 0 && (
          <CommandGroup heading="Settings">
            {settingsMatches.map(renderTarget)}
          </CommandGroup>
        )}
        {isSearching && workspaceListMatches.length > 0 && (
          <CommandGroup heading="Workspaces">
            {workspaceListMatches.map(w => (
              <CommandItem key={`ws:${w.id}`} value={`ws:${w.id}`} onSelect={() => onNavigateWorkspace(w.id)}>
                <Briefcase className="text-muted-foreground" />
                <span className="truncate">{w.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {isSearching && hasAnyResults && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Ask AI">
              <CommandItem value={`ask-ai:${trimmed}`} onSelect={() => startNewChat(trimmed)}>
                <Sparkles className="text-muted-foreground" />
                <span className="truncate">{trimmed}</span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  )
}
