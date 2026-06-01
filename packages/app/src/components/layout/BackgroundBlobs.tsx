import type { CSSProperties } from 'react'
import { cn } from '@roomy-ai/ui'

// Full-viewport static blob backdrop. The blur is real, but it is applied to a
// non-animated synthetic layer instead of using backdrop-filter or animating
// filtered pixels every frame.

const BLOB_LAYOUTS = [
  { className: 'backgroundBlob-1', cx: 80, cy: 1000, rx: 380, ry: 260, opacity: 0.55 },
  { className: 'backgroundBlob-2', cx: 1520, cy: 1000, rx: 380, ry: 260, opacity: 0.55 },
  { className: 'backgroundBlob-3', cx: 800, cy: 1040, rx: 440, ry: 240, opacity: 0.4 },
  { className: 'backgroundBlob-4', cx: 1180, cy: 1020, rx: 300, ry: 200, opacity: 0.35 },
  { className: 'backgroundBlob-5', cx: 420, cy: 1020, rx: 300, ry: 200, opacity: 0.35 },
] as const

const PALETTE = ['#86efac', '#f9a8d4', '#c4b5fd', '#fed7aa', '#bfdbfe', '#fde68a'] as const

type RandomFn = () => number
type PageLoadBlob = (typeof BLOB_LAYOUTS)[number] & { color: string }

export function createPageLoadBlobs(random: RandomFn = Math.random): PageLoadBlob[] {
  const colors = [...PALETTE]

  for (let index = colors.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.min(index, Math.floor(random() * (index + 1)))
    const current = colors[index]
    colors[index] = colors[swapIndex]
    colors[swapIndex] = current
  }

  return BLOB_LAYOUTS.map((blob, index) => ({
    ...blob,
    color: colors[index],
  }))
}

const PAGE_LOAD_BLOBS = createPageLoadBlobs()

type BlobStyle = CSSProperties & {
  '--blob-left': string
  '--blob-top': string
  '--blob-width': string
  '--blob-height': string
  '--blob-opacity': number
  '--blob-color': string
}

function blobStyle(blob: PageLoadBlob): BlobStyle {
  return {
    '--blob-left': `${blob.cx - blob.rx}px`,
    '--blob-top': `${blob.cy - blob.ry}px`,
    '--blob-width': `${blob.rx * 2}px`,
    '--blob-height': `${blob.ry * 2}px`,
    '--blob-opacity': blob.opacity,
    '--blob-color': blob.color,
  }
}

export function BackgroundBlobs({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden -z-10',
        className,
      )}
    >
      <div className="backgroundBlobStage">
        {PAGE_LOAD_BLOBS.map(blob => (
          <div
            key={blob.className}
            className={cn('backgroundBlob', blob.className)}
            style={blobStyle(blob)}
          />
        ))}
      </div>
      <div className="backgroundBlobWash" />
      <style>{`
        .backgroundBlobStage {
          position: absolute;
          left: 50%;
          bottom: 0;
          width: max(100%, 160dvh);
          aspect-ratio: 16 / 10;
          transform: translateX(-50%);
          filter: blur(120px);
          overflow: visible;
        }
        .backgroundBlobWash {
          position: absolute;
          inset: 0;
          background:
            linear-gradient(
              to bottom,
              oklch(1 0 0 / 0.68) 0%,
              oklch(1 0 0 / 0.24) 48%,
              oklch(1 0 0 / 0.04) 100%
            ),
            radial-gradient(
              ellipse at 50% 100%,
              oklch(0.98 0.03 120 / 0.16) 0%,
              transparent 64%
            );
        }
        .dark .backgroundBlobWash {
          background:
            linear-gradient(
              to bottom,
              oklch(0.14 0.006 286 / 0.56) 0%,
              oklch(0.14 0.006 286 / 0.2) 48%,
              oklch(0.14 0.006 286 / 0.04) 100%
            ),
            radial-gradient(
              ellipse at 50% 100%,
              oklch(0.38 0.055 165 / 0.18) 0%,
              transparent 64%
            );
        }
        .backgroundBlob {
          position: absolute;
          left: var(--blob-left);
          top: var(--blob-top);
          width: var(--blob-width);
          height: var(--blob-height);
          opacity: var(--blob-opacity);
          border-radius: 50%;
          background: var(--blob-color);
          contain: layout paint style;
        }
      `}</style>
    </div>
  )
}
