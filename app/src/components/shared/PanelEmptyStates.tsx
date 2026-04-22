import { FileText } from 'lucide-react'

interface ArtifactsEmptyStateProps {
  onPrefillInput?: (text: string) => void
}

export function ArtifactsEmptyState({ onPrefillInput }: ArtifactsEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
        <FileText className="h-5 w-5 text-muted-foreground/50" />
      </div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">No artifacts yet</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Ask the AI to create a document, app, or image.</p>
      </div>
      {onPrefillInput && (
        <button
          onClick={() => onPrefillInput('Create a document summarising this conversation')}
          className="text-xs text-primary hover:underline"
        >
          Create one now →
        </button>
      )}
    </div>
  )
}

export function FilesEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 p-6 text-center">
      <p className="text-sm text-muted-foreground">No files yet</p>
      <p className="text-xs text-muted-foreground/70">Add files from your library to give the AI extra context.</p>
    </div>
  )
}
