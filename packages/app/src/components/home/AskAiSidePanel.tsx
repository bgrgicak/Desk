import { useState } from 'react'
import { SectionEmptyState } from '@/components/shared/SectionEmptyState'
import { SectionHeader, SectionBody } from '@/components/shared/SectionHeader'

/**
 * Right-side panel for the Home → Ask AI view. Mirrors the chat
 * view's Files + Tasks layout (`ChatRightPanel`), including its
 * plain-text empty states. The Ask AI thread is a cross-room global
 * chat — it doesn't have its own workspace, attachments directory,
 * or task messages — so each section is a stub empty state for now.
 * The seam for a real backend signal (e.g. "files / tasks recently
 * surfaced by Ask AI") is the empty arrays below.
 */
export function AskAiSidePanel() {
  const [filesCollapsed, setFilesCollapsed] = useState(false)
  const [tasksCollapsed, setTasksCollapsed] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto pb-4 pl-2 pr-4">
      <SectionHeader
        label="Files"
        collapsed={filesCollapsed}
        onToggle={() => setFilesCollapsed(c => !c)}
      />
      <SectionBody collapsed={filesCollapsed}>
        <SectionEmptyState>
          Files shared in this chat appear here.
        </SectionEmptyState>
      </SectionBody>

      <SectionHeader
        label="Tasks"
        collapsed={tasksCollapsed}
        onToggle={() => setTasksCollapsed(c => !c)}
        className="mt-3"
      />
      <SectionBody collapsed={tasksCollapsed}>
        <SectionEmptyState>
          Tasks created in this chat appear here.
        </SectionEmptyState>
      </SectionBody>
    </div>
  )
}
