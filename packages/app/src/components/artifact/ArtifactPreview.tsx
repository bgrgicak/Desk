import type { Artifact } from '@/data/ui-types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileText } from 'lucide-react'
import { ImagePreview } from '@/components/ImagePreview'

interface ArtifactPreviewProps {
  artifact: Artifact
  zoom?: number
  /**
   * File body fetched by the caller (e.g. ArtifactDetail). When provided,
   * document/spreadsheet previews render it as markdown instead of the
   * empty `artifact.content` coming from the list-shape selector.
   */
  content?: string | null
  /**
   * Object URL for binary-body previews (images). When provided, the image
   * case renders a real `<img>`; otherwise it falls back to the placeholder.
   */
  blobUrl?: string | null
}

export function ArtifactPreview({ artifact, zoom = 1, content, blobUrl }: ArtifactPreviewProps) {
  switch (artifact.type) {
    case 'document':
    case 'spreadsheet':
      return (
        <div className="mx-auto max-w-3xl px-8 py-8">
          <div className="prose prose-neutral prose-sm max-w-none prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-lg prose-h3:text-base prose-p:text-sm prose-p:leading-relaxed prose-li:text-sm prose-code:text-foreground prose-pre:bg-muted prose-pre:text-foreground prose-table:text-sm prose-th:text-left prose-th:font-medium prose-th:bg-muted/50 prose-th:px-3 prose-th:py-2 prose-td:px-3 prose-td:py-2 prose-td:border-t">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content ?? artifact.content}</ReactMarkdown>
          </div>
        </div>
      )

    case 'app':
      return (
        <div className="flex min-h-full flex-col bg-background">
          {/* App top nav */}
          <div className="flex items-center gap-4 border-b px-5 py-3 shrink-0">
            <div className="h-5 w-28 rounded bg-muted animate-pulse" />
            <div className="flex gap-3 ml-4">
              {[56, 44, 52].map(w => (
                <div key={w} className="h-4 rounded bg-muted/60 animate-pulse" style={{ width: w }} />
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="h-7 w-20 rounded-md bg-muted/60 animate-pulse" />
              <div className="h-7 w-7 rounded-full bg-muted animate-pulse" />
            </div>
          </div>
          {/* App body */}
          <div className="flex flex-1">
            {/* Sidebar */}
            <div className="w-52 border-r px-3 py-4 space-y-1 shrink-0">
              <div className="h-3 w-16 rounded bg-muted/50 animate-pulse mb-3" />
              {[80, 64, 72, 60, 76].map((w, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <div className="h-4 w-4 rounded bg-muted/60 animate-pulse shrink-0" />
                  <div className="h-3 rounded bg-muted/50 animate-pulse" style={{ width: w }} />
                </div>
              ))}
              <div className="h-3 w-16 rounded bg-muted/50 animate-pulse mt-5 mb-3 ml-2" />
              {[68, 56, 72].map((w, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <div className="h-4 w-4 rounded bg-muted/60 animate-pulse shrink-0" />
                  <div className="h-3 rounded bg-muted/50 animate-pulse" style={{ width: w }} />
                </div>
              ))}
            </div>
            {/* Main content */}
            <div className="flex-1 p-6 space-y-5 overflow-y-auto">
              {/* Stat cards */}
              <div className="grid grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="rounded-xl border p-4 space-y-2">
                    <div className="h-3 w-16 rounded bg-muted/50 animate-pulse" />
                    <div className="h-6 w-20 rounded bg-muted animate-pulse" />
                    <div className="h-3 w-24 rounded bg-muted/40 animate-pulse" />
                  </div>
                ))}
              </div>
              {/* Chart area */}
              <div className="rounded-xl border p-5 space-y-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="h-4 w-32 rounded bg-muted animate-pulse" />
                  <div className="h-7 w-24 rounded-md bg-muted/50 animate-pulse" />
                </div>
                <div className="h-48 w-full rounded-lg bg-muted/30 animate-pulse" />
              </div>
              {/* Table */}
              <div className="rounded-xl border overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 border-b bg-muted/20">
                  {[120, 80, 96, 64].map((w, i) => (
                    <div key={i} className="h-3 rounded bg-muted/60 animate-pulse" style={{ width: w }} />
                  ))}
                </div>
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3 border-b last:border-0">
                    <div className="h-7 w-7 rounded-full bg-muted/50 animate-pulse shrink-0" />
                    {[100, 72, 88, 56].map((w, j) => (
                      <div key={j} className="h-3 rounded bg-muted/40 animate-pulse" style={{ width: w }} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )

    case 'image':
      return blobUrl ? (
        <div className="relative flex flex-1 min-h-full items-center justify-center bg-background overflow-auto">
          <img
            src={blobUrl}
            alt={artifact.name}
            style={{ transform: `scale(${zoom})` }}
            className="h-full w-full object-contain transition-transform duration-150 ease-out select-none"
          />
        </div>
      ) : (
        <ImagePreview zoom={zoom} />
      )

    case 'site':
      return (
        <div className="flex min-h-full flex-col bg-background overflow-y-auto">
          {/* Site nav */}
          <div className="flex items-center gap-6 border-b px-10 py-4 shrink-0">
            <div className="h-5 w-24 rounded bg-muted animate-pulse" />
            <div className="flex gap-5 ml-4">
              {[48, 40, 56, 44].map((w, i) => (
                <div key={i} className="h-3 rounded bg-muted/50 animate-pulse" style={{ width: w }} />
              ))}
            </div>
            <div className="ml-auto h-8 w-24 rounded-full bg-muted animate-pulse" />
          </div>
          {/* Hero */}
          <div className="flex flex-col items-center gap-5 px-10 py-20 bg-muted/20 border-b">
            <div className="h-3 w-28 rounded-full bg-muted animate-pulse" />
            <div className="h-10 w-2/3 rounded-lg bg-muted animate-pulse" />
            <div className="h-10 w-1/2 rounded-lg bg-muted/60 animate-pulse" />
            <div className="flex gap-4 mt-2">
              <div className="h-10 w-32 rounded-full bg-muted animate-pulse" />
              <div className="h-10 w-28 rounded-full bg-muted/50 animate-pulse" />
            </div>
            <div className="mt-6 w-full max-w-2xl h-56 rounded-2xl bg-muted/40 animate-pulse border" />
          </div>
          {/* Features */}
          <div className="px-10 py-16 border-b">
            <div className="flex flex-col items-center gap-3 mb-10">
              <div className="h-5 w-40 rounded bg-muted animate-pulse" />
              <div className="h-3 w-64 rounded bg-muted/50 animate-pulse" />
            </div>
            <div className="grid grid-cols-3 gap-6 max-w-4xl mx-auto">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="rounded-xl border p-6 space-y-3">
                  <div className="h-10 w-10 rounded-xl bg-muted animate-pulse" />
                  <div className="h-4 w-28 rounded bg-muted animate-pulse" />
                  <div className="space-y-1.5">
                    <div className="h-3 w-full rounded bg-muted/50 animate-pulse" />
                    <div className="h-3 w-5/6 rounded bg-muted/50 animate-pulse" />
                    <div className="h-3 w-4/6 rounded bg-muted/50 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* CTA */}
          <div className="flex flex-col items-center gap-4 px-10 py-16 bg-muted/10">
            <div className="h-7 w-72 rounded-lg bg-muted animate-pulse" />
            <div className="h-3 w-80 rounded bg-muted/50 animate-pulse" />
            <div className="h-10 w-36 rounded-full bg-muted animate-pulse mt-2" />
          </div>
        </div>
      )

    default:
      return (
        <div className="flex h-full items-center justify-center">
          <div className="text-center">
            <FileText className="mx-auto h-12 w-12 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">Preview not available</p>
          </div>
        </div>
      )
  }
}
