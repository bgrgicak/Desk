import { FileText, Folder, Link2, StickyNote, type LucideIcon } from 'lucide-react'
import type { ContextItem } from '@/data/ui-types'

export const ITEM_ICON: Record<ContextItem['type'], LucideIcon> = {
  file: FileText,
  note: StickyNote,
  link: Link2,
}

export interface ComposerAttachment {
  id: string
  name: string
  kind: 'folder' | 'item'
  type?: ContextItem['type']
}

export function attachmentChipIcon(item: ComposerAttachment): LucideIcon {
  if (item.kind === 'folder') return Folder
  return ITEM_ICON[item.type ?? 'file'] ?? FileText
}
