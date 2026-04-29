import { Bot } from 'lucide-react'
import { AppCard } from '@/components/ui/app-card'
import type { Artifact, ArtifactUpdate } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { ArtifactThumbnail } from './ArtifactThumbnail'

interface ArtifactCardProps {
  artifact: Artifact
  onClick: () => void
  index?: number
  update?: ArtifactUpdate
  onDismissUpdate?: (id: string) => void
}

export function ArtifactCard({ artifact, onClick, index = 0, update }: ArtifactCardProps) {
  return (
    <AppCard onClick={onClick} index={index}>
      <ArtifactThumbnail artifact={artifact} />
      <div className="p-4 pt-3">
        <h3 className="text-sm font-medium text-foreground truncate mb-2 group-hover:text-foreground/90">
          {artifact.name}
        </h3>
        <div className="flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
          <span className="text-xs text-muted-foreground">{artifact.agentName}</span>
          {update && (
            <>
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0 ml-1" />
              <span className="text-xs text-blue-500">1 update</span>
            </>
          )}
          <span className="ml-auto text-xs text-muted-foreground shrink-0">{getRelativeTime(artifact.createdAt)}</span>
        </div>
      </div>
    </AppCard>
  )
}
