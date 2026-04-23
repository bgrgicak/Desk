import { Bot, BookmarkPlus, Check } from 'lucide-react'
import { toast } from 'sonner'
import type { Artifact } from '@/data/ui-types'
import { getArtifactIcon } from '@/data/ui-types'

const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  document: 'Doc', app: 'App', image: 'Image', spreadsheet: 'Sheet', site: 'Site',
}

function getArtifactDescription(artifact: Artifact): string {
  if (artifact.type === 'app')         return 'Interactive application — ready to use'
  if (artifact.type === 'image')       return 'Visual design — ready to review'
  if (artifact.type === 'site')        return 'Website — ready to publish'
  if (artifact.type === 'spreadsheet') return 'Spreadsheet — ready to use'
  const lines = artifact.content.split('\n').filter(l => l.trim() && !l.startsWith('#'))
  return lines[0]?.slice(0, 120) || 'Document ready to review'
}

interface ArtifactInlineCardProps {
  artifact: Artifact
  isSaved: boolean
  onOpen: () => void
  /** Called when user clicks Save — parent is responsible for updating isSaved */
  onSave?: () => void
}

export function ArtifactInlineCard({ artifact, isSaved, onOpen, onSave }: ArtifactInlineCardProps) {
  const Icon = getArtifactIcon(artifact.type)
  const description = getArtifactDescription(artifact)

  return (
    <div className="w-full rounded-xl border-2 border-border bg-background">
      {/* Clickable top section */}
      <button
        onClick={onOpen}
        className="w-full text-left p-4 hover:bg-muted/30 transition-colors rounded-t-xl"
      >
        <div className="flex items-start gap-3">
          <div className="h-11 w-11 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Icon className="h-5 w-5 text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-foreground truncate">{artifact.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{description}</p>
          </div>
        </div>
      </button>

      {/* Footer: agent info + Open + Save */}
      <div className="px-4 py-2.5 border-t flex items-center gap-1.5">
        <Bot className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{artifact.agentName}</span>
        <span className="text-muted-foreground/40 mx-0.5 text-xs">·</span>
        <span className="text-xs text-muted-foreground">{ARTIFACT_TYPE_LABELS[artifact.type] ?? artifact.type}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onOpen}
            className="flex items-center gap-1.5 text-xs font-medium border border-border rounded-md px-2.5 py-1 hover:bg-muted/50 transition-colors"
          >
            Open
          </button>
          {isSaved ? (
            <button
              disabled
              className="flex items-center gap-1.5 text-xs font-medium bg-primary/60 text-primary-foreground rounded-md px-2.5 py-1 cursor-default"
            >
              <Check className="h-3 w-3" />
              Saved to Desk
            </button>
          ) : (
            <button
              onClick={() => {
                onSave?.()
                toast.success(`"${artifact.name}" saved to your Desk`)
              }}
              className="flex items-center gap-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md px-2.5 py-1 hover:bg-primary/90 transition-colors"
            >
              <BookmarkPlus className="h-3 w-3" />
              Save to Desk
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
