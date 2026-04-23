import { useState } from 'react'
import { Search, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SidebarTrigger } from '@/components/ui/sidebar'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb'
import { ArtifactCard } from './ArtifactCard'
import type { Artifact, ArtifactType, ArtifactUpdate } from '@/data/mock-data'

interface DeskGridProps {
  artifacts: Artifact[]
  onArtifactClick: (artifact: Artifact) => void
  onCompose: () => void
  updates?: ArtifactUpdate[]
  readUpdateIds?: Set<string>
  onDismissUpdate?: (id: string) => void
}

type FilterType = 'all' | ArtifactType

export function DeskGrid({ artifacts, onArtifactClick, onCompose, updates, readUpdateIds, onDismissUpdate }: DeskGridProps) {
  const [filter, setFilter] = useState<FilterType>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const filters: { value: FilterType; label: string }[] = [
    { value: 'all',         label: 'All'    },
    { value: 'app',         label: 'Apps'   },
    { value: 'document',    label: 'Docs'   },
    { value: 'image',       label: 'Images' },
    { value: 'spreadsheet', label: 'Data'   },
    { value: 'site',        label: 'Sites'  },
  ]

  const filtered = artifacts
    .filter(a => filter === 'all' || a.type === filter)
    .filter(a => !searchQuery || a.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">

      {/* ── Header bar ── */}
      <div className="h-[52px] flex items-center gap-3 border-b px-4 shrink-0">
        <SidebarTrigger className="h-8 w-8 rounded-md shrink-0" />
        <Breadcrumb className="shrink-0">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage className="text-sm font-semibold text-foreground">Desk</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="ml-auto flex items-center gap-2">
          {artifacts.length > 0 && (
            <>
              <div className="flex items-center rounded-lg border p-0.5">
                {filters.map(f => (
                  <button
                    key={f.value}
                    onClick={() => setFilter(f.value)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      filter === f.value
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search..."
                  className="h-8 w-40 rounded-md border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-ring/20 focus:border-ring/40 transition-all"
                />
              </div>
            </>
          )}
          <Button size="sm" onClick={onCompose}>
            Create
          </Button>
        </div>
      </div>

      {/* ── Body ── */}
      {artifacts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="text-center max-w-sm">
            <div className="mb-4 text-4xl">📂</div>
            <h2 className="text-lg font-semibold mb-2">Nothing here yet</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Create your first document, app, or design to see it appear here.
            </p>
            <Button onClick={onCompose} className="gap-2">
              <Plus className="h-4 w-4" />
              Create something
            </Button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">No results found</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {filtered.map((artifact, i) => {
              const update = (updates ?? []).find(u => u.artifactId === artifact.id && !(readUpdateIds ?? new Set()).has(u.id))
              return (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  onClick={() => onArtifactClick(artifact)}
                  index={i}
                  update={update}
                  onDismissUpdate={onDismissUpdate}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
