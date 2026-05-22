import { describe, expect, it } from 'vitest'
import {
  modelProviderConnectionEnvKey,
  normalizeModelIdForProvider,
  reorderModelIds,
} from './ModelsSection'

describe('model settings helpers', () => {
  it('maps model providers to connection credential keys', () => {
    expect(modelProviderConnectionEnvKey('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(modelProviderConnectionEnvKey('openai')).toBe('OPENAI_API_KEY')
    expect(modelProviderConnectionEnvKey('codex')).toBeUndefined()
    expect(modelProviderConnectionEnvKey('opencode')).toBeUndefined()
  })

  it('normalizes bare model names with the selected provider', () => {
    expect(normalizeModelIdForProvider('anthropic', 'claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6')
    expect(normalizeModelIdForProvider('openai', 'openai/gpt-5.4')).toBe('openai/gpt-5.4')
    expect(normalizeModelIdForProvider('opencode', '  big-pickle  ')).toBe('opencode/big-pickle')
  })

  it('reorders dragged models before and after a target id', () => {
    const ids = ['agt_1', 'agt_2', 'agt_3', 'agt_4']
    expect(reorderModelIds(ids, 'agt_3', 'agt_1', 'before')).toEqual(['agt_3', 'agt_1', 'agt_2', 'agt_4'])
    expect(reorderModelIds(ids, 'agt_1', 'agt_3', 'after')).toEqual(['agt_2', 'agt_3', 'agt_1', 'agt_4'])
  })

  it('leaves order unchanged for invalid or no-op drops', () => {
    const ids = ['agt_1', 'agt_2', 'agt_3']
    expect(reorderModelIds(ids, 'agt_1', 'agt_1', 'before')).toEqual(ids)
    expect(reorderModelIds(ids, 'missing', 'agt_2', 'before')).toEqual(ids)
    expect(reorderModelIds(ids, 'agt_1', 'missing', 'after')).toEqual(ids)
  })
})
