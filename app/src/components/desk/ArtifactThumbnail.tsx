import type { Artifact } from '@/data/mock-data'
import { ArtifactPreview } from '@/components/artifact/ArtifactPreview'

const SCALE = 0.25
const THUMB_HEIGHT = 134 // 96 * 1.4

interface Props {
  artifact: Artifact
}

export function ArtifactThumbnail({ artifact }: Props) {
  return (
    <div
      className="relative w-full border-b border-border overflow-hidden bg-background"
      style={{ height: THUMB_HEIGHT }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${100 / SCALE}%`,   // 400% — fills card width after scale
          transform: `scale(${SCALE})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        <ArtifactPreview artifact={artifact} />
      </div>
    </div>
  )
}
