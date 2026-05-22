import { Sparkles } from 'lucide-react'
import { cn } from '@agent-desk/ui'

/** Tool selected when the suggestion is clicked. Matches the
 *  `GoalKey` values the composer's Tools picker recognises. */
export type SuggestionGoal = 'task' | 'app' | undefined

export interface ChatSuggestion {
  /** Visible label on the pill. */
  label: string
  /** Prompt pasted into the composer when the user clicks the pill. */
  prompt: string
  /** Optional Tools selection — sets the composer's goal so the user
   *  goes straight into the right mode (Task, App, …). */
  goal?: SuggestionGoal
}

/**
 * Default fallback suggestions used when no specific recommendations
 * are surfaced for the current chat. Each pill prefills the composer
 * and optionally selects a Tools goal so a click leaves the user one
 * Send away from the action.
 *
 * The "real" recommendation engine is a future signal; the prompts
 * here are intentionally minimal openers (the user edits before
 * sending).
 */
export const FALLBACK_CHAT_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: 'Create a new task',
    // Self-sufficient prompt — pressing Enter without editing gives
    // the agent enough context to either propose a task based on
    // recent activity or ask one short clarifying question.
    prompt:
      "Help me create a new task. Look at my recent activity across all rooms and propose one concrete task I should tackle next — give it a clear title, a one-sentence description, set a priority, and add a schedule if it should recur. If you aren't sure what to focus on, ask me one short question first.",
    goal: 'task',
  },
  {
    label: 'Create a new app',
    prompt:
      'Help me build a new app. Suggest 2–3 small, useful apps based on common workflows (e.g. an expense tracker, a meeting-notes capture, a daily standup form). Ask me which one to start with, then scaffold it and walk me through the next step.',
    goal: 'app',
  },
  {
    label: 'Summarize my tasks',
    prompt:
      'Show me a detailed summary of tasks that require my attention across all rooms. Group them by status (needs input, in progress, scheduled, done in the last week), and within each group show the room name. Highlight anything blocked or overdue at the top.',
  },
]

interface SuggestionPillsProps {
  /** Pills to render. Defaults to {@link FALLBACK_CHAT_SUGGESTIONS}. */
  suggestions?: ChatSuggestion[]
  /** Fires when a pill is clicked — caller wires this to its
   *  composer's prefill / goal state. */
  onSelect: (s: ChatSuggestion) => void
  className?: string
}

/**
 * Row of outline pills shown above the chat composer in an empty
 * chat (Figma 747-8319). Clicking a pill calls `onSelect` so the
 * parent can prefill the composer + set its Tools goal.
 */
export function SuggestionPills({
  suggestions = FALLBACK_CHAT_SUGGESTIONS,
  onSelect,
  className,
}: SuggestionPillsProps) {
  if (suggestions.length === 0) return null
  return (
    // Left-aligned row of outline pills (Figma: `flex … items-start`,
    // no `justify-center`). No background fill — only a 1 px border
    // + the soft hover wash; the BackgroundBlobs gradient shows
    // through, matching the design.
    <div className={cn('flex flex-wrap items-center justify-start gap-2', className)}>
      {suggestions.map(s => (
        <button
          key={s.label}
          type="button"
          onClick={() => onSelect(s)}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/40"
        >
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {s.label}
        </button>
      ))}
    </div>
  )
}
