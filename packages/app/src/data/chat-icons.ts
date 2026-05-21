import {
  CalendarClock,
  FileText,
  Globe,
  ImageIcon,
  ListTodo,
  MessageSquare,
  Play,
  Table,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { Chat } from './ui-types'

/**
 * Goal-aware icon for a chat row. Used by the sidebar's Chats list AND
 * by the Pinned section's chat entries, so a pinned task keeps its
 * ListTodo glyph instead of flattening to a generic MessageSquare.
 */
const GOAL_ICONS: Record<NonNullable<Chat['goal']>, LucideIcon> = {
  app: Zap,
  document: FileText,
  image: ImageIcon,
  data: Table,
  site: Globe,
  run: Play,
  task: ListTodo,
  scheduled: CalendarClock,
}

export function getChatIcon(chat: Chat): LucideIcon {
  if (chat.goal && Object.prototype.hasOwnProperty.call(GOAL_ICONS, chat.goal)) {
    return GOAL_ICONS[chat.goal]
  }
  switch (chat.kind) {
    case 'task':
    case 'task_run':
      return ListTodo
    default:
      return MessageSquare
  }
}
