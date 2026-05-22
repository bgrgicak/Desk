import { useState, useRef, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { usePersistedState } from '@/hooks/use-persisted-state'
import { useSelector, useDispatch } from 'react-redux'
import { getSessionToken } from '@/auth/session'
import {
  Link2,
  Download,
  MoreHorizontal,
  ExternalLink,
  MessageSquare,
  X,
  Eye,
  Code,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Input,
} from '@agent-desk/ui'
import { TopBarActions, TopBarContentActions } from '@/components/layout/TopBar'
import type { ContextItem, Artifact } from '@/data/ui-types'
import { getArtifactIcon } from '@/data/ui-types'
import { fileKindForItem, fileKindFrom, iconForItem, isMarkdownFile, isHtmlFile } from '@/data/file-kind'
import {
  useDeleteLibraryFileMutation,
  useGetLibraryFoldersQuery,
  useMoveLibraryEntryMutation,
} from '@/store/api'
import { downloadLibraryFile, fetchLibraryContent, saveLibraryContent } from '@/store/library-download'
import { TextFileEditor } from './TextFileEditor'
import { MergeEditor } from './MergeEditor'
import {
  AppPreview,
  parseChatAppDirPath,
  parseChatAppFragmentPath,
  parseChatAppManifestPath,
  parseLibraryAppDirPath,
  parseLibraryAppFragmentPath,
  parseLibraryAppManifestPath,
} from './AppPreview'
import { MarkdownContent } from '@/components/MarkdownContent'
import { FileChatPanel } from '@/components/context/FileChatPanel'
import { toFolderList, type MoveTarget } from '@/store/selectors/library'
import { FileActionMenuItems } from '@/components/library/FileActionMenuItems'
import { MoveToFolderDialog } from '@/components/library/MoveToFolderDialog'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import type { RootState } from '@/store/store'
import { selectFileChangeCounter, selectWorkspaceChangeCounter } from '@/store/slices/derivedSlice'
import { GENERATED_APP_IFRAME_SANDBOX } from '@/lib/iframe-sandbox'
import { previewBlobFor } from '@/lib/preview-blob'
import {
  DESKTOP_RIGHT_PANEL_BREAKPOINT,
  isSmallRightPanelViewport,
  shouldOpenRightPanelsByDefault,
} from '@/components/shared/rightPanelLayout'
import { SplitResizeHandle } from '@/components/shared/SplitResizeHandle'
import { useSplitResize, useContentAreaInsets } from '@/components/shared/splitPane'
import {
  LIBRARY_DETAIL_SPLIT_RATIO_STORAGE_KEY_EXPORT,
  PREVIEW_MIN_CHAT_WIDTH,
  PREVIEW_MIN_PANEL_WIDTH,
  selectLibraryDetailSplitRatio,
  setLibraryDetailSplitRatio,
} from '@/store/slices/previewPanelSlice'

const AUTO_SAVE_DEBOUNCE_MS = 600

function useIsSmallRightPanelScreen() {
  const [smallScreen, setSmallScreen] = useState(() => isSmallRightPanelViewport())

  useEffect(() => {
    if (typeof window === 'undefined') return

    const query = window.matchMedia(`(max-width: ${DESKTOP_RIGHT_PANEL_BREAKPOINT - 1}px)`)
    const update = () => setSmallScreen(isSmallRightPanelViewport())

    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return smallScreen
}

type ContextDetailAppPreviewRef =
  | { scope: 'chat'; chatId: string; appName: string; fragment?: string }
  | { scope: 'library'; appName: string; appPath?: string; workspaceId?: string; fragment?: string }

export function appPreviewRefForContextItem(
  item: Pick<ContextItem, 'id' | 'type'>,
): ContextDetailAppPreviewRef | null {
  const chatAppManifestRef = parseChatAppManifestPath(item.id)
  const chatAppDirRef = item.type === 'app' ? parseChatAppDirPath(item.id) : null
  const chatFragmentRef = parseChatAppFragmentPath(item.id)
  if (chatFragmentRef) return { scope: 'chat', chatId: chatFragmentRef.chatId, appName: chatFragmentRef.appName, fragment: chatFragmentRef.fragment }
  const chatAppRef = chatAppManifestRef ?? chatAppDirRef
  if (chatAppRef) return { scope: 'chat', chatId: chatAppRef.chatId, appName: chatAppRef.appName }

  const libraryFragmentRef = parseLibraryAppFragmentPath(item.id)
  if (libraryFragmentRef) return { scope: 'library', appName: libraryFragmentRef.appName, appPath: libraryFragmentRef.appPath, fragment: libraryFragmentRef.fragment }

  const libraryManifestRef = parseLibraryAppManifestPath(item.id)
  if (libraryManifestRef) return { scope: 'library', appName: libraryManifestRef.appName, appPath: item.id.slice(0, -'/desk.app.json'.length) }

  const libraryAppDirRef =
    item.type === 'app' && !libraryManifestRef
      ? parseLibraryAppDirPath(item.id)
      : null
  if (libraryAppDirRef) return { scope: 'library', appName: libraryAppDirRef.appName, appPath: item.id }

  return null
}

interface ContextDetailProps {
  item: ContextItem
  onBack: () => void
  onCompose: (items: ContextItem[]) => void
  onArtifactClick?: (artifact: Artifact) => void
  /** Jump back to the Library view with the given folder open.
   * Pass `null` to land on the Library root. */
  onNavigateToFolder: (folderId: string | null) => void
  /** Called after a successful rename (note title auto-rename or file
   * rename modal) so the parent can update the URL to the new path. */
  onRenameItem?: (newPath: string) => void
  /** Pin/unpin wiring (mirrors the Library list) so the file-detail
   *  kebab offers the same actions. Pin row hidden if neither given. */
  isPinned?: boolean
  onPin?: () => void
  onUnpin?: () => void
  previewParams?: Record<string, string>
}

function canPreview(item: ContextItem): boolean {
  if (item.type === 'note' || item.type === 'link') return true
  const k = fileKindForItem(item)
  return k !== 'unknown' && k !== 'app'
}

export function ContextDetail({ item, onBack, onCompose, onRenameItem, isPinned, onPin, onUnpin, previewParams }: ContextDetailProps) {
  const { wsId: activeWorkspaceId } = useParams<{ wsId: string }>()
  const [deleteLibraryFile, deleteState] = useDeleteLibraryFileMutation()
  const [moveLibraryEntry, moveState] = useMoveLibraryEntryMutation()

  const rightPanelOpenKey = `desk.library.${item.id}.rightPanelOpen`
  const [panelOpen, setPanelOpen] = usePersistedState<boolean>(rightPanelOpenKey, shouldOpenRightPanelsByDefault())
  const isSmallViewport = useIsSmallRightPanelScreen()

  // ── Resizable two-pane split (mirror of the chat-view preview) ──
  // The file card is the growing LEFT pane (its viewport fraction =
  // libraryDetailSplitRatio); the chat panel is the fixed right pane.
  // Only a docked desktop panel resizes — when it's closed the file
  // card is full-width (no handle), and on small screens the panel is
  // a full-screen overlay (no handle).
  const dispatch = useDispatch()
  const splitRatio = useSelector(selectLibraryDetailSplitRatio)
  const dockedSplit = panelOpen && !isSmallViewport
  const fileWidth = `${Math.round(splitRatio * 100)}vw`
  const chatWidth = `${Math.round((1 - splitRatio) * 100)}vw`
  const { isResizing, onMouseDown: onResizeStart } = useSplitResize({
    getStartRatio: () => splitRatio,
    onRatio: (r) => dispatch(setLibraryDetailSplitRatio(r)),
    onCommit: (r) => {
      try {
        window.localStorage.setItem(
          LIBRARY_DETAIL_SPLIT_RATIO_STORAGE_KEY_EXPORT,
          String(r),
        )
      } catch {
        // localStorage unavailable — ratio still applies this session.
      }
    },
    // File card needs the larger min (it's the document surface); the
    // chat panel mirrors the chat-view min.
    minLeftPx: PREVIEW_MIN_PANEL_WIDTH,
    minRightPx: PREVIEW_MIN_CHAT_WIDTH,
  })
  // Keep the global avatar overlay centred over the chat panel. We
  // pass the *eventual* left inset (= file-card width) even while the
  // chat is closed, so opening it only fades + slides the stack down
  // in place — it never travels horizontally across the viewport.
  // `hidden` toggles only opacity/translateY.
  useContentAreaInsets(fileWidth, '0px', { hidden: !panelOpen })

  // Align the file-controls TopBar slot to the file preview's right
  // edge: at the file/chat seam while the chat is docked, the normal
  // 24 px gutter otherwise. The slot is absolute, so changing this
  // never reflows the breadcrumb.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty(
      '--topbar-content-actions-right',
      dockedSplit ? chatWidth : '1.5rem',
    )
    return () => {
      root.style.removeProperty('--topbar-content-actions-right')
    }
  }, [dockedSplit, chatWidth])

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [showPreview, setShowPreview] = usePersistedState(
    `desk.library.${item.id}.previewMode`,
    isMarkdownFile(item.name, item.mimeType) || isHtmlFile(item.name, item.mimeType),
  )

  const fileChangeCounter = useSelector((s: RootState) => selectFileChangeCounter(s, item.id))
  const workspaceChangeCounter = useSelector((s: RootState) =>
    selectWorkspaceChangeCounter(s, activeWorkspaceId ?? '')
  )

  // File content fetched on demand for preview. Text files (notes, uri-list
  // links, csv/json/code, …) arrive as `previewText`; binary previews (images,
  // PDFs, video, audio) arrive as an object URL we can hand to <img>/<iframe>/
  // <video>/<audio>. Both are keyed by the item's path so switching items drops
  // any stale blob. `mediaLoadFailed` catches formats the browser advertises it
  // might render but can't (e.g. HEIC in non-Safari browsers) so we fall back
  // to the download prompt.
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [previewEtag, setPreviewEtag] = useState<string | null>(null)
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [mediaLoadFailed, setMediaLoadFailed] = useState(false)
  // When non-null, the user's save conflicted with an agent write.
  // Holds the server's current content so the merge view can display it.
  const [conflictContent, setConflictContent] = useState<string | null>(null)

  const kind = fileKindForItem(item)
  // PR-C: when the open item is an app manifest inside a chat artifact's
  // `<name>.app/` directory, render the app live in an iframe instead of
  // the raw JSON. The bridge + capability checklist live inside
  // <AppPreview>.
  // PR-E extends this to library apps: clicking either the `<name>.app/`
  // library directory or its inner `desk.app.json` opens the same live
  // preview.
  const baseAppPreviewRef = appPreviewRefForContextItem(item)
  const appPreviewRef = baseAppPreviewRef
    ? {
        ...baseAppPreviewRef,
        ...(baseAppPreviewRef.scope === 'library' ? { workspaceId: activeWorkspaceId } : {}),
        ...(previewParams ? { params: previewParams } : {}),
      }
    : null

  // Refs that mirror the latest editorValue / previewText so the async fetch
  // callback can read current values without stale closures, and without
  // adding them as effect deps (which would re-run the fetch on every keystroke).
  const editorValueRef = useRef<string | null>(null)
  const previewTextRef = useRef<string | null>(null)
  // Tracks the previous item.id so the fetch effect can distinguish a file
  // switch (full reset required) from a background content refresh (preserve
  // local editor edits).
  const prevItemIdRef = useRef<string>(item.id)

  useEffect(() => {
    const isItemChange = prevItemIdRef.current !== item.id
    prevItemIdRef.current = item.id

    if (isItemChange) {
      // Switching to a different file: full reset including the editor.
      setPreviewText(null)
      setPreviewEtag(null)
      setPreviewBlobUrl(null)
      setPreviewError(null)
      setMediaLoadFailed(false)
      setEditorValue(null)
      setConflictContent(null)
      editorInitFor.current = null
    }

    if (!activeWorkspaceId) return
    if (!canPreview(item)) return
    let cancelled = false
    let createdUrl: string | null = null
    // Snapshot editor/preview state at fetch-start so the async .then()
    // can safely compare without a stale closure.
    const editorAtStart = editorValueRef.current
    const previewAtStart = previewTextRef.current
    void fetchLibraryContent({ workspaceId: activeWorkspaceId, path: item.id })
      .then(async ({ blob, etag }) => {
        if (cancelled) return
        const effectiveKind = fileKindFrom(item.name, blob.type || item.mimeType)
        if (effectiveKind === 'docx') {
          if (!isItemChange) return // don't re-render docx on background refresh
          // Convert docx → HTML in-browser via mammoth, then hand the
          // rendered HTML to the iframe as a blob URL. Lazy-imported so
          // users who never open a .docx don't pay the bundle cost.
          const mammoth = await import('mammoth/mammoth.browser')
          const arrayBuffer = await blob.arrayBuffer()
          const { value: html } = await mammoth.convertToHtml({ arrayBuffer })
          if (cancelled) return
          const htmlDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:780px;margin:0 auto;padding:2.5rem 1.5rem;line-height:1.6;color:#111}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}</style></head><body>${html}</body></html>`
          const htmlBlob = new Blob([htmlDoc], { type: 'text/html' })
          createdUrl = URL.createObjectURL(htmlBlob)
          setPreviewBlobUrl(createdUrl)
        } else if (effectiveKind === 'text' || effectiveKind === 'html' || item.type === 'link' || item.type === 'note') {
          const text = await blob.text()
          if (cancelled) return
          setPreviewText(text)
          setPreviewEtag(etag)
          // On initial load (item switch): always populate the editor.
          // On background refresh: only update the editor when the user has
          // no unsaved local changes — this preserves in-progress edits while
          // still reflecting the server's latest content. CodeMirror's internal
          // diffing keeps the cursor position stable across external updates.
          if (isItemChange || editorAtStart === previewAtStart) {
            setEditorValue(text)
            setConflictContent(null)
            editorInitFor.current = item.id
          }
        } else {
          const previewBlob = await previewBlobFor(effectiveKind, blob, item.name, item.id, blob.type || item.mimeType)
          if (cancelled) return
          createdUrl = URL.createObjectURL(previewBlob)
          setPreviewBlobUrl(createdUrl)
        }
      })
      .catch((err) => {
        if (cancelled) return
        // Only surface errors to the user on initial load; silently swallow
        // background refresh errors so the last known content stays visible.
        if (isItemChange) setPreviewError(err instanceof Error ? err.message : 'Preview failed')
      })
    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  // fileChangeCounter/workspaceChangeCounter trigger re-fetch on agent writes.
  // editorValue/previewText reads use refs so they don't need to be in deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, item.id, item.type, item.mimeType, item.name, fileChangeCounter, workspaceChangeCounter])

  const handleDownload = async () => {
    if (!activeWorkspaceId) return
    try {
      await downloadLibraryFile({
        workspaceId: activeWorkspaceId,
        path: item.id,
        filename: item.name,
      })
    } catch (err) {
      toast.error(`Download failed: ${item.name}`, {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  const handleDelete = async () => {
    if (!activeWorkspaceId) return
    try {
      await deleteLibraryFile({ workspaceId: activeWorkspaceId, path: item.id }).unwrap()
      setDeleteDialogOpen(false)
      toast.success(`Deleted ${item.name}`)
      onBack()
    } catch (err) {
      toast.error(`Delete failed: ${item.name}`, {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  // The breadcrumb now lives in the global TopBar (fed by the server
  // item name via App → AppShell). Note heading auto-rename persists
  // through `moveLibraryEntry` + `onRenameItem` below, which updates
  // the route and re-derives that name — so no local mirror is needed.

  // Rename modal (for file / link items — notes rename via the heading
  // editor). The parent re-keys this component on item.id, so initial state
  // is always fresh for the current item — no syncing effect needed.
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(item.name)

  const handleRename = async () => {
    if (!activeWorkspaceId) return
    const name = renameValue.trim()
    if (!name || name === item.name) {
      setRenameOpen(false)
      return
    }
    const slash = item.id.lastIndexOf('/')
    const parent = slash >= 0 ? item.id.slice(0, slash) : ''
    const to = parent ? `${parent}/${name}` : name
    try {
      await moveLibraryEntry({ workspaceId: activeWorkspaceId, from: item.id, to }).unwrap()
      toast.success(`Renamed to "${name}"`)
      setRenameOpen(false)
      onRenameItem?.(to)
    } catch (err) {
      toast.error(`Rename failed`, {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  // Move-to-folder — same shared dialog the Library list uses. Moving
  // keeps the file name but changes its parent path; mirror the
  // rename flow so the route/selection follows the new path.
  const [moveTargets, setMoveTargets] = useState<MoveTarget[] | null>(null)
  const handleMoveToFolder = async (destFolderId: string | null) => {
    if (!activeWorkspaceId) return
    const base = item.name
    const to = destFolderId ? `${destFolderId}/${base}` : base
    setMoveTargets(null)
    if (to === item.id) return
    try {
      await moveLibraryEntry({ workspaceId: activeWorkspaceId, from: item.id, to }).unwrap()
      toast.success(
        destFolderId ? `Moved to "${destFolderId}"` : 'Moved to Library root',
      )
      onRenameItem?.(to)
    } catch (err) {
      toast.error('Move failed', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  // Editable text content for text-kind files and notes. `editorValue`
  // is the working copy; when it diverges from `previewText` (the last
  // server-known content for this item) the Save button enables.
  const [editorValue, setEditorValue] = useState<string | null>(null)
  const editorInitFor = useRef<string | null>(null)

  // Keep refs in sync with state so async fetch callbacks can read current
  // values without creating stale closures.
  useEffect(() => { editorValueRef.current = editorValue }, [editorValue])
  useEffect(() => { previewTextRef.current = previewText }, [previewText])

  const isTextEditable =
    ((kind === 'text' || kind === 'html') && item.type === 'file') || item.type === 'note'
  const isMarkdown = isMarkdownFile(item.name, item.mimeType)
  const isHtml = isHtmlFile(item.name, item.mimeType)
  const isDirty = isTextEditable && editorValue != null && editorValue !== previewText

  const [isSaving, setIsSaving] = useState(false)

  const [htmlPreviewBlobUrl, setHtmlPreviewBlobUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!isHtml || !showPreview || editorValue == null) {
      setHtmlPreviewBlobUrl(null)
      return
    }
    const blob = new Blob([editorValue], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    setHtmlPreviewBlobUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [isHtml, showPreview, editorValue])

  const handleSave = useCallback(async () => {
    if (!activeWorkspaceId || !isDirty || editorValue == null) return
    setIsSaving(true)
    try {
      const result = await saveLibraryContent({
        workspaceId: activeWorkspaceId,
        path: item.id,
        body: editorValue,
        contentType: item.mimeType || 'text/plain',
        etag: previewEtag,
      })
      if (result.conflict) {
        setConflictContent(result.content)
        setPreviewEtag(result.etag)
      } else {
        setPreviewText(editorValue)
        if (result.etag) setPreviewEtag(result.etag)
        headingLinkedRef.current = false
        toast.success(`Saved ${item.name}`)
      }
    } catch (err) {
      toast.error(`Save failed: ${item.name}`, {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setIsSaving(false)
    }
  }, [activeWorkspaceId, editorValue, isDirty, item.id, item.mimeType, item.name, previewEtag])

  const saveLabel = isSaving ? 'Saving…' : 'Save'

  // Document editor state for notes: a separate heading textarea and body
  // textarea. Content is stored as `heading\n\nbody` in the file; on first
  // load we parse the two parts from previewText. Changes to either part
  // recompose editorValue so the existing auto-save mechanism just works.
  //
  // Heading → filename link: active only while the file still has its
  // default "Untitled" name. As soon as the content saves or the user opens
  // the header filename edit the link is severed.
  const noteExt = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.')) : ''
  const [noteHeading, setNoteHeading] = useState('')
  const [noteBody, setNoteBody] = useState('')
  const headingBodyInitFor = useRef<string | null>(null)
  const headingLinkedRef = useRef(/^Untitled(-\d+)?$/.test(item.name.replace(/\.[^/.]+$/, '')))
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const renameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (previewText == null) return
    if (headingBodyInitFor.current === item.id) return
    headingBodyInitFor.current = item.id
    const sep = previewText.indexOf('\n\n')
    if (sep === -1) {
      setNoteHeading(previewText)
      setNoteBody('')
    } else {
      setNoteHeading(previewText.slice(0, sep))
      setNoteBody(previewText.slice(sep + 2))
    }
  }, [previewText, item.id])

  const autoResize = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }
  useEffect(() => { autoResize(titleRef.current) }, [noteHeading])
  useEffect(() => { autoResize(bodyRef.current) }, [noteBody])

  const handleHeadingChange = (value: string) => {
    setNoteHeading(value)
    setEditorValue(value ? value + '\n\n' + noteBody : noteBody)
    if (!headingLinkedRef.current || !activeWorkspaceId) return
    if (renameTimerRef.current) clearTimeout(renameTimerRef.current)
    renameTimerRef.current = setTimeout(async () => {
      const stem = value.trim() || 'Untitled'
      const currentStem = item.name.replace(/\.[^/.]+$/, '') || item.name
      if (stem === currentStem) return
      const newName = `${stem}${noteExt}`
      const folder = item.folderId ?? ''
      const newPath = folder ? `${folder}/${newName}` : newName
      try {
        await moveLibraryEntry({ workspaceId: activeWorkspaceId, from: item.id, to: newPath }).unwrap()
        onRenameItem?.(newPath)
      } catch (err) {
        toast.error('Rename failed', {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    }, AUTO_SAVE_DEBOUNCE_MS)
  }

  const handleBodyChange = (value: string) => {
    setNoteBody(value)
    setEditorValue(noteHeading ? noteHeading + '\n\n' + value : value)
  }

  // "Related artifacts" — the server has no explicit artifact-to-context
  // relation yet and `relatedArtifactIds` is always empty for
  // server-backed items today. The previous client-side hydration
  // walked the whole library to resolve those ids, which is no longer
  // possible (and unnecessary while the list stays empty).
  const relatedArtifacts: Artifact[] = []
  // Destination folders for the shared Move dialog. Lazy: only fetch
  // when the move dialog is actually opened. The dialog mounts on
  // `moveTargets !== null`, so the data is in cache by the time it renders.
  const { data: foldersResp } = useGetLibraryFoldersQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId || moveTargets === null },
  )
  const folders = toFolderList(foldersResp?.folders ?? [], activeWorkspaceId ?? '')
  const FileIcon = iconForItem(item)

  return (
    <div className="relative flex flex-1 min-h-0 overflow-hidden">
      {/* File card column — always `flex-1`. The chat pane animates
          its own width (below), so this column simply yields space as
          the chat grows / reclaims it as the chat shrinks — one
          smooth flex transition, no competing width animation here. */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* File controls live in the *content-pane* TopBar slot —
            absolutely aligned to the file preview's right edge (the
            file/chat seam when docked, the 24 px gutter otherwise)
            via `--topbar-content-actions-right`. The chat sidebar's
            only control — the collapse X — is in the separate
            far-right slot below. Both slots are absolute so the
            breadcrumb never reflows between views. */}
        <TopBarContentActions>
          <div className="flex items-center gap-1.5 sm:gap-2">
              {isTextEditable && (isDirty || isSaving) && (
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={handleSave}
                  disabled={isSaving}
                  data-testid="library-save"
                  data-save-state={isSaving ? 'saving' : 'dirty'}
                >
                  {saveLabel}
                </Button>
              )}

              {isTextEditable && (isMarkdown || isHtml) && (
                // Segmented Preview/Code toggle — matches Figma
                // 628:7031 (accent track, 10px radius, 3px inset;
                // the active tab is a white, sm-shadowed 8px pill).
                // Hidden on mobile: with Save + kebab + Open-chat +
                // (when docked) Close-X already in the row, the
                // toggle pushed the file-name crumb to "CL…" on a
                // 375 px viewport. Mobile defaults to the preview
                // mode set by `showPreview`'s persisted state.
                <div className="hidden items-center gap-1 rounded-[10px] bg-accent p-[3px] sm:flex" data-testid="library-preview-toggle">
                  <button
                    onClick={() => setShowPreview(true)}
                    className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${showPreview ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                    aria-label="Preview"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setShowPreview(false)}
                    className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${!showPreview ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                    aria-label="Code"
                  >
                    <Code className="h-4 w-4" />
                  </button>
                </div>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="library-detail-more">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <FileActionMenuItems
                    onUseInChat={() => onCompose([item])}
                    isPinned={isPinned}
                    onPin={onPin}
                    onUnpin={onUnpin}
                    onDownload={
                      item.type === 'file' || item.type === 'note'
                        ? handleDownload
                        : undefined
                    }
                    onRename={
                      item.type !== 'note'
                        ? () => { setRenameValue(item.name); setRenameOpen(true) }
                        : undefined
                    }
                    onMove={() =>
                      setMoveTargets([{ path: item.id, name: item.name, kind: 'item' }])
                    }
                    homePin={
                      activeWorkspaceId
                        ? {
                            kind: item.type === 'app' ? 'artifact' : 'file',
                            id: item.id,
                            workspaceId: activeWorkspaceId,
                            label: item.name,
                          }
                        : undefined
                    }
                    onDelete={() => setDeleteDialogOpen(true)}
                  />
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Open-chat lives with the file controls (there's no
                  chat sidebar yet to host it). Once the chat is open
                  this disappears — the only chat-sidebar control is
                  the collapse X in the far-right slot below. */}
              {!panelOpen && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPanelOpen(true)}
                  aria-label="Open chat"
                >
                  <MessageSquare className="h-4 w-4" />
                </Button>
              )}
          </div>
        </TopBarContentActions>

        {/* Chat sidebar's sole control: the collapse X, pinned far
            right over the chat pane. Only present while open. */}
        {panelOpen && (
          <TopBarActions>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => setPanelOpen(false)}
              aria-label="Close chat"
            >
              <X className="h-4 w-4" />
            </Button>
          </TopBarActions>
        )}

        {/* Preview area — Figma 628:7033/7034. Content area padded
            `pl-5 pb-6` with NO right padding while the chat is docked
            so the card's right edge is flush with the pane seam: the
            only gap to the chat composer is then the chat's own
            `px-6` (24 px) gutter — matching the chat-view preview
            spacing exactly. When the chat is closed the card is
            symmetric (`px-5 pb-6`). No top padding — the global
            TopBar supplies it. */}
        <div className={`flex flex-1 min-h-0 pb-6 ${dockedSplit ? 'pl-5' : 'px-5'}`}>
        <div className="flex flex-1 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-md">
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          {appPreviewRef ? (
            <AppPreview {...appPreviewRef} />
          ) : item.type === 'note' && item.mimeType !== 'text/markdown' ? (
            <div className="flex-1 flex flex-col bg-background overflow-y-auto">
              <div className="mx-auto w-full max-w-[490px] px-4 pt-8 pb-16">
                {editorValue !== null ? (
                  <>
                    <textarea
                      ref={titleRef}
                      value={noteHeading}
                      onChange={(e) => handleHeadingChange(e.target.value)}
                      placeholder="Heading"
                      rows={1}
                      className="w-full resize-none overflow-hidden bg-transparent text-2xl font-semibold text-foreground placeholder:text-muted-foreground/30 outline-none leading-tight mb-4"
                    />
                    <textarea
                      ref={bodyRef}
                      value={noteBody}
                      onChange={(e) => handleBodyChange(e.target.value)}
                      placeholder="Start writing…"
                      rows={1}
                      className="w-full resize-none overflow-hidden bg-transparent text-sm text-foreground/80 placeholder:text-muted-foreground/30 outline-none leading-relaxed"
                    />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {previewError ? `Failed to load: ${previewError}` : 'Loading…'}
                  </p>
                )}
              </div>
            </div>
          ) : item.type === 'link' ? (
            (() => {
              // Link entries are stored in the host OS's native shortcut
              // format (.url INI on Windows, .webloc plist on macOS,
              // .desktop on Linux). All three embed an http(s) URL —
              // pull the first such substring out as the target.
              const linkUrl =
                previewText?.match(/https?:\/\/\S+?(?=[\s<"']|$)/)?.[0] ?? ''
              return (
                <div className="flex flex-col h-full">
                  {/* Link preview bar */}
                  <div className="flex items-center gap-2 border-b bg-background px-4 py-2">
                    <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                    {linkUrl ? (
                      <a
                        href={linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline flex items-center gap-1 truncate"
                      >
                        {linkUrl}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {previewError ? `Failed to load link: ${previewError}` : 'Loading…'}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <div className="mb-4 flex h-16 w-16 mx-auto items-center justify-center rounded-2xl bg-blue-500/10">
                        <Link2 className="h-8 w-8 text-blue-500/40" />
                      </div>
                      <h3 className="text-base font-semibold mb-1">{item.name}</h3>
                      {linkUrl ? (
                        <a
                          href={linkUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
                        >
                          Open in browser
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {previewError ? `Failed to load link: ${previewError}` : 'Loading…'}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })()
          ) : kind === 'app' ? (
            <div className="flex-1 flex flex-col bg-muted/30">
              <iframe
                title={item.name}
                src={`/api/apps/${activeWorkspaceId}/${item.id}/dist/index.html?token=${encodeURIComponent(getSessionToken() ?? '')}`}
                className="flex-1 w-full border-0 bg-white"
                sandbox={GENERATED_APP_IFRAME_SANDBOX}
              />
            </div>
          ) : kind === 'pdf' ? (
            <div className="flex-1 flex flex-col bg-muted/30">
              {previewBlobUrl ? (
                <iframe
                  title={item.name}
                  src={previewBlobUrl}
                  className="flex-1 w-full border-0 bg-white"
                />
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">
                    {previewError ? `Failed to load PDF: ${previewError}` : 'Loading PDF…'}
                  </p>
                </div>
              )}
            </div>
          ) : kind === 'html' ? (
            <div className="flex-1 min-h-0 bg-background">
              {conflictContent !== null && editorValue !== null ? (
                <MergeEditor
                  yours={editorValue}
                  theirs={conflictContent}
                  onChange={setEditorValue}
                  onResolve={() => setConflictContent(null)}
                  filename={item.name}
                />
              ) : showPreview && editorValue !== null ? (
                <div className="flex-1 flex flex-col bg-white h-full">
                  {htmlPreviewBlobUrl ? (
                    <iframe
                      title={item.name}
                      src={htmlPreviewBlobUrl}
                      sandbox={GENERATED_APP_IFRAME_SANDBOX}
                      className="flex-1 w-full border-0 bg-white"
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center">
                      <p className="text-sm text-muted-foreground">Loading…</p>
                    </div>
                  )}
                </div>
              ) : editorValue !== null ? (
                <TextFileEditor
                  value={editorValue}
                  onChange={setEditorValue}
                  filename={item.name}
                  mimeType={item.mimeType}
                />
              ) : (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-muted-foreground">
                    {previewError ? `Failed to load file: ${previewError}` : 'Loading…'}
                  </p>
                </div>
              )}
            </div>
          ) : kind === 'docx' ? (
            <div className="flex-1 flex flex-col bg-white">
              {previewBlobUrl ? (
                <iframe
                  title={item.name}
                  src={previewBlobUrl}
                  sandbox="allow-same-origin"
                  className="flex-1 w-full border-0 bg-white"
                />
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">
                    {previewError ? `Failed to load: ${previewError}` : 'Loading…'}
                  </p>
                </div>
              )}
            </div>
          ) : kind === 'image' && !mediaLoadFailed ? (
            <div className="flex-1 flex items-center justify-center bg-background overflow-auto">
              {previewBlobUrl ? (
                <img
                  src={previewBlobUrl}
                  alt={item.name}
                  className="h-auto w-auto max-h-full max-w-full object-contain"
                  onError={() => setMediaLoadFailed(true)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {previewError ? `Failed to load image: ${previewError}` : 'Loading image…'}
                </p>
              )}
            </div>
          ) : kind === 'video' && !mediaLoadFailed ? (
            <div className="flex-1 flex items-center justify-center bg-background overflow-auto">
              {previewBlobUrl ? (
                <video
                  src={previewBlobUrl}
                  controls
                  className="max-w-full max-h-full"
                  onError={() => setMediaLoadFailed(true)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {previewError ? `Failed to load video: ${previewError}` : 'Loading video…'}
                </p>
              )}
            </div>
          ) : kind === 'audio' && !mediaLoadFailed ? (
            <div className="flex-1 flex items-center justify-center px-6">
              {previewBlobUrl ? (
                <audio
                  src={previewBlobUrl}
                  controls
                  className="w-full max-w-lg"
                  onError={() => setMediaLoadFailed(true)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {previewError ? `Failed to load audio: ${previewError}` : 'Loading audio…'}
                </p>
              )}
            </div>
          ) : kind === 'text' && (item.type === 'file' || item.mimeType === 'text/markdown') ? (
            <div className="flex-1 min-h-0 bg-background">
              {conflictContent !== null && editorValue !== null ? (
                <MergeEditor
                  yours={editorValue}
                  theirs={conflictContent}
                  onChange={setEditorValue}
                  onResolve={() => setConflictContent(null)}
                  filename={item.name}
                />
              ) : showPreview && editorValue !== null ? (
                <div className="p-6 overflow-y-auto h-full">
                  <MarkdownContent text={editorValue} />
                </div>
              ) : editorValue !== null ? (
                <TextFileEditor
                  value={editorValue}
                  onChange={setEditorValue}
                  filename={item.name}
                  mimeType={item.mimeType}
                />
              ) : (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-muted-foreground">
                    {previewError ? `Failed to load file: ${previewError}` : 'Loading…'}
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* No in-app preview — offer a download instead. */
            <div className="flex-1 flex items-center justify-center min-h-0">
              <div className="text-center max-w-xs px-4">
                <div className="mb-5 flex h-16 w-16 mx-auto items-center justify-center rounded-2xl bg-muted/50">
                  <FileIcon className="h-8 w-8 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium text-muted-foreground mb-4">
                  {mediaLoadFailed
                    ? "Your browser can't display this file inline"
                    : 'Preview not available for this file type'}
                </p>
                {item.type === 'file' && (
                  <Button size="sm" variant="outline" className="text-xs" onClick={handleDownload}>
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    Download
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
        </div>
        </div>
      </div>

      {/* Right pane — the chat (mirror of the chat-view preview
          split, roles swapped). One element that animates as a single
          piece: desktop docks and animates its `width` 0↔chatWidth
          (the file column yields via flex, so the whole thing slides
          open/closed smoothly with no double animation); small
          screens slide in as a right overlay. The grab bar sits on
          the left seam, outside the overflow-hidden inner so its
          straddling hit area isn't clipped. */}
      <AnimatePresence initial={false}>
        {panelOpen && (isSmallViewport ? (
          <motion.div
            key="file-chat-overlay"
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="absolute inset-y-0 right-0 z-40 flex w-full max-w-[320px] flex-col bg-background shadow-xl"
          >
            <FileChatPanel item={item} workspaceId={activeWorkspaceId} />
          </motion.div>
        ) : (
          <motion.div
            key="file-chat"
            initial={{ width: 0 }}
            animate={{ width: chatWidth }}
            exit={{ width: 0 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="relative shrink-0 flex flex-col bg-transparent"
          >
            <SplitResizeHandle
              isResizing={isResizing}
              onMouseDown={onResizeStart}
              ariaLabel="Resize file and chat panels"
            />
            <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
              <FileChatPanel item={item} workspaceId={activeWorkspaceId} />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{item.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {relatedArtifacts.length > 0 ? (
                <>
                  This item was used to create {relatedArtifacts.length} {relatedArtifacts.length === 1 ? 'artifact' : 'artifacts'} in your Desk:
                  <span className="block mt-2 space-y-1">
                    {relatedArtifacts.map(a => (
                      <span key={a.id} className="flex items-center gap-2 text-foreground">
                        {(() => { const Icon = getArtifactIcon(a.type); return <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> })()}
                        <span className="font-medium">{a.name}</span>
                      </span>
                    ))}
                  </span>
                  <span className="block mt-2">
                    Those artifacts will remain in your Desk, but they will no longer reference this file as context.
                  </span>
                </>
              ) : (
                'This item is not used by any artifacts. It will be permanently removed from your context.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteState.isLoading}
              onClick={(e) => { e.preventDefault(); void handleDelete() }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename dialog */}
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          setRenameOpen(open)
          if (!open) setRenameValue(item.name)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename {item.type === 'link' ? 'link' : 'file'}</DialogTitle>
            <DialogDescription>
              Give the {item.type === 'link' ? 'link' : 'file'} a new name. Include the extension.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label className="text-sm font-medium text-foreground">Name</label>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRename()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button
              disabled={
                !renameValue.trim() ||
                renameValue.trim() === item.name ||
                moveState.isLoading
              }
              onClick={() => void handleRename()}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move-to-folder dialog (shared with the Library list) */}
      <MoveToFolderDialog
        targets={moveTargets}
        folders={folders}
        onClose={() => setMoveTargets(null)}
        onMove={handleMoveToFolder}
      />
    </div>
  )
}
