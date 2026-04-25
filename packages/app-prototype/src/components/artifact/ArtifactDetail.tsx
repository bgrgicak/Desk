import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  MoreHorizontal,
  Pencil,
  Check,
  ChevronRight,
  History,
  Share,
  RotateCw,
  Play,
  Trash2,
  PanelRight,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  BookmarkPlus,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SidebarTrigger } from '@/components/ui/sidebar'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ArtifactPreview } from './ArtifactPreview'
import { ConversationPanel } from './ConversationPanel'
import type { Artifact, ArtifactUpdate } from '@/data/ui-types'
import { getArtifactIcon } from '@/data/ui-types'
import { fetchLibraryContent } from '@/store/library-download'

interface ArtifactDetailProps {
  artifact: Artifact
  onBack: () => void
  onDelete?: () => void
  update?: ArtifactUpdate | null
  isUpdateRead?: boolean
  onDismissUpdate?: (id: string) => void
  transitionFrom?: 'compose' | 'chat'
  isSaved?: boolean
  onSave?: () => void
}

export function ArtifactDetail({ artifact, onBack, onDelete, update, isUpdateRead, onDismissUpdate, transitionFrom, isSaved = true, onSave }: ArtifactDetailProps) {
  const { wsId: activeWorkspaceId } = useParams<{ wsId: string }>()
  const [panelCollapsed, setPanelCollapsed] = useState(false)

  // Mark update as read as soon as the panel is visible
  useEffect(() => {
    if (!panelCollapsed && update && !isUpdateRead) {
      onDismissUpdate?.(update.id)
    }
  }, [panelCollapsed, update, isUpdateRead, onDismissUpdate])
  const [isEditingName, setIsEditingName] = useState(false)
  const [name, setName] = useState(artifact.name)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const zoomIn  = () => setZoom(z => Math.min(z + 0.25, 4))
  const zoomOut = () => setZoom(z => Math.max(z - 0.25, 0.25))
  const zoomReset = () => setZoom(1)

  // Artifacts are library files; fetch the body when the detail opens so
  // document/spreadsheet/image previews can render real content instead of
  // the placeholder that the list-shape selector provides.
  const [artifactContent, setArtifactContent] = useState<string | null>(null)
  const [artifactBlobUrl, setArtifactBlobUrl] = useState<string | null>(null)
  useEffect(() => {
    setArtifactContent(null)
    setArtifactBlobUrl(null)
    if (!activeWorkspaceId) return
    if (artifact.type !== 'document' && artifact.type !== 'spreadsheet' && artifact.type !== 'image') return
    let cancelled = false
    let createdUrl: string | null = null
    void fetchLibraryContent({ workspaceId: activeWorkspaceId, path: artifact.id })
      .then(async (blob) => {
        if (cancelled) return
        if (artifact.type === 'image') {
          createdUrl = URL.createObjectURL(blob)
          setArtifactBlobUrl(createdUrl)
        } else {
          const text = await blob.text()
          if (!cancelled) setArtifactContent(text)
        }
      })
      .catch(() => {
        // Preview failure is non-fatal — the placeholder shows instead.
      })
    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [activeWorkspaceId, artifact.id, artifact.type])

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Main content area */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Header — breadcrumb style */}
        <div className="h-[52px] flex items-center gap-3 border-b px-4 shrink-0">
          <SidebarTrigger className="h-8 w-8 rounded-md shrink-0" />

          {/* Breadcrumb */}
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="flex-nowrap">
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <button
                    onClick={onBack}
                    className="text-sm font-semibold text-foreground hover:text-foreground/70 transition-colors"
                  >
                    Desk
                  </button>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>
                <ChevronRight className="h-3.5 w-3.5" />
              </BreadcrumbSeparator>
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="flex items-center gap-1.5 text-sm font-semibold text-foreground min-w-0">
                  {(() => { const Icon = getArtifactIcon(artifact.type); return <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> })()}
                  {isEditingName ? (
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setIsEditingName(false)
                          if (e.key === 'Escape') { setName(artifact.name); setIsEditingName(false) }
                        }}
                        className="flex-1 min-w-0 bg-transparent text-sm font-semibold outline-none border-b-2 border-primary pb-0.5"
                        autoFocus
                      />
                      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setIsEditingName(false)}>
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setIsEditingName(true)}
                      className="flex items-center gap-1 min-w-0 group hover:text-foreground/70 transition-colors"
                    >
                      <span className="truncate">{name}</span>
                      <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    </button>
                  )}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          <div className="flex items-center gap-2 shrink-0">
            {/* Save to desk — shown only when opened from chat/compose and not yet saved */}
            {transitionFrom && !isSaved && (
              <Button
                size="sm"
                variant="default"
                className="h-8 gap-1.5 text-xs"
                onClick={() => {
                  onSave?.()
                  toast.success(`"${name}" saved to your Desk`)
                }}
              >
                <BookmarkPlus className="h-3.5 w-3.5" />
                Save to Desk
              </Button>
            )}
            {transitionFrom && isSaved && (
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled>
                <Check className="h-3.5 w-3.5" />
                Saved
              </Button>
            )}

            {/* Zoom controls — image artifacts only */}
            {artifact.type === 'image' && (
              <div className="flex items-center rounded-md border divide-x overflow-hidden">
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-none border-0" onClick={zoomOut} disabled={zoom <= 0.25}>
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-none border-0" onClick={zoomReset} disabled={zoom === 1}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-none border-0" onClick={zoomIn} disabled={zoom >= 4}>
                  <ZoomIn className="h-4 w-4" />
                </Button>
              </div>
            )}

            {/* Overflow menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem>
                  <History className="h-4 w-4 mr-2" />
                  Version history
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Play className="h-4 w-4 mr-2" />
                  Convert to recurring task
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <Share className="h-4 w-4 mr-2" />
                  Share or export
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <RotateCw className="h-4 w-4 mr-2" />
                  Run again with {artifact.agentName}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setDeleteDialogOpen(true)}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {panelCollapsed && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setPanelCollapsed(false)}
              >
                <PanelRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Artifact content */}
        <motion.div
          className="flex-1 overflow-y-auto flex flex-col"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
        >
          <ArtifactPreview artifact={artifact} zoom={zoom} content={artifactContent} blobUrl={artifactBlobUrl} />
        </motion.div>
      </div>

      {/* Conversation panel — desktop only */}
      <div className={`hidden lg:block shrink-0 transition-all duration-300 ${panelCollapsed ? 'w-0 overflow-hidden' : 'w-[380px]'}`}>
        <ConversationPanel
          initialMessages={artifact.conversation}
          agentModel={artifact.agentModel}
          collapsed={panelCollapsed}
          onCollapse={() => setPanelCollapsed(!panelCollapsed)}
          artifact={artifact}
          update={update}
          isUpdateRead={isUpdateRead}
          onDismissUpdate={onDismissUpdate}
          transitionFrom={transitionFrom}
        />
      </div>

      {/* Mobile: collapsed panel toggle */}
      <div className="lg:hidden">
        <ConversationPanel
          initialMessages={artifact.conversation}
          agentModel={artifact.agentModel}
          collapsed={panelCollapsed}
          onCollapse={() => setPanelCollapsed(!panelCollapsed)}
          update={update}
          isUpdateRead={isUpdateRead}
          onDismissUpdate={onDismissUpdate}
          transitionFrom={transitionFrom}
        />
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This artifact will be permanently removed from your Desk. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { onDelete?.(); onBack() }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
