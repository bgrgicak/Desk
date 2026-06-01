import {
  ArtifactPreviewBody,
  useArtifactPreview,
} from '@/components/shared/InlineArtifactPreview'

interface EmbeddedFragmentPreviewProps {
  workspaceId?: string
  chatId?: string
  path: string
  name?: string
  mime?: string
  params?: Record<string, string>
  testId: string
  interactiveAttribute?: string
}

export function EmbeddedFragmentPreview({
  workspaceId,
  chatId,
  path,
  name,
  mime,
  params,
  testId,
  interactiveAttribute,
}: EmbeddedFragmentPreviewProps) {
  const displayName = name ?? path.split('/').filter(Boolean).at(-1) ?? 'Fragment'
  const { state, appPreviewRef } = useArtifactPreview({
    workspaceId,
    chatId,
    path,
    name: displayName,
    mime,
    params,
  })
  const interactiveProps = interactiveAttribute
    ? { [interactiveAttribute]: 'true' }
    : {}

  return (
    <div
      className="min-h-40 max-h-[420px] overflow-y-auto rounded-lg border border-foreground/10 bg-background"
      data-testid={testId}
      {...interactiveProps}
    >
      <div data-testid="artifact-fragment-inline">
        <ArtifactPreviewBody
          state={state}
          name={displayName}
          mime={mime}
          appPreviewRef={appPreviewRef}
          fallback={
            <div className="flex min-h-40 items-center justify-center px-4 text-center text-sm text-muted-foreground">
              Open the chat to view {displayName}.
            </div>
          }
        />
      </div>
    </div>
  )
}
