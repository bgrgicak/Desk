import type { ArtifactType } from '@/data/ui-types'
import type { AttachmentRef } from '@/store/types'

export interface ArtifactPromptInput {
  type?: ArtifactType
  instructions?: string
  name?: string
  attachments?: Pick<AttachmentRef, 'path' | 'name' | 'kind'>[]
}

const TYPE_VERB: Record<ArtifactType, string> = {
  document: 'Write',
  app: 'Build',
  image: 'Generate',
  spreadsheet: 'Create',
  site: 'Build',
}

const TYPE_NOUN: Record<ArtifactType, string> = {
  document: 'a document',
  app: 'an app',
  image: 'an image',
  spreadsheet: 'a spreadsheet',
  site: 'a site',
}

/**
 * Builds the first-message prompt that the artifact creation sheet sends
 * into a fresh chat. Kept in one place so future template tweaks land
 * once and apply identically wherever the sheet is launched.
 */
export function buildArtifactPrompt(input: ArtifactPromptInput): string {
  const lines: string[] = []

  const trimmedName = input.name?.trim()
  const trimmedInstructions = input.instructions?.trim()

  if (input.type) {
    const named = trimmedName ? ` called "${trimmedName}"` : ''
    lines.push(`${TYPE_VERB[input.type]} ${TYPE_NOUN[input.type]}${named}.`)
  } else if (trimmedName) {
    lines.push(`Create something called "${trimmedName}".`)
  }

  if (trimmedInstructions) {
    if (lines.length) lines.push('')
    lines.push(trimmedInstructions)
  }

  if (input.attachments?.length) {
    if (lines.length) lines.push('')
    lines.push('Use the following files from my library as source information:')
    for (const a of input.attachments) {
      lines.push(`- @${a.path}`)
    }
  }

  return lines.join('\n')
}
