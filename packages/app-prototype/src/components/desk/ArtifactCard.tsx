import { motion } from 'framer-motion'
import { Bot } from 'lucide-react'
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
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.04, duration: 0.2 }}
      onClick={onClick}
      className="group w-full text-left rounded-xl border border-border bg-background overflow-hidden hover:shadow-md hover:border-foreground/10 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring/20"
    >
      {/* Thumbnail */}
      <ArtifactThumbnail artifact={artifact} />

      {/* Content */}
      <div className="p-4 pt-3">
        {/* Name */}
        <h3 className="text-sm font-medium text-foreground line-clamp-2 mb-2 group-hover:text-foreground/90">
          {artifact.name}
        </h3>

        {/* Bot name + update indicator + timestamp */}
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
    </motion.button>
  )
}
