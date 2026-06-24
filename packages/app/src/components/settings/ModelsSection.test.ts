import { describe, expect, it } from 'vitest'
import {
  defaultModelIdForProvider,
  modelProviderCredentialRequired,
  modelProviderCredentialScopeText,
  modelProviderConnectionEnvKey,
  normalizeModelIdForProvider,
  reorderModelIds,
} from './ModelsSection'

describe('model settings helpers', () => {
  it('maps model providers to connection credential keys', () => {
    expect(modelProviderConnectionEnvKey('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(modelProviderConnectionEnvKey('openai')).toBe('OPENAI_API_KEY')
    expect(modelProviderConnectionEnvKey('codex')).toBeUndefined()
  })

  it('explains that API keys are shared per model provider', () => {
    expect(modelProviderCredentialScopeText('anthropic', 'new')).toBe(
      'This saves one shared Claude API key for every Claude model.',
    )
    expect(modelProviderCredentialScopeText('anthropic', 'new', true)).toBe(
      'This model will reuse the shared Claude API key unless you enter a replacement.',
    )
    expect(modelProviderCredentialScopeText('openai', 'edit')).toBe(
      'One ChatGPT API key is shared by every ChatGPT model. Updating it here replaces that shared key.',
    )
    expect(modelProviderCredentialScopeText('codex', 'edit')).toBeUndefined()
  })

  it('requires provider credentials only when no shared key exists yet', () => {
    expect(modelProviderCredentialRequired('anthropic', 'new', false)).toBe(true)
    expect(modelProviderCredentialRequired('anthropic', 'new', true)).toBe(false)
    expect(modelProviderCredentialRequired('anthropic', 'edit', false)).toBe(false)
    expect(modelProviderCredentialRequired('codex', 'new', false)).toBe(false)
  })

  it('normalizes bare model names with the selected provider', () => {
    expect(normalizeModelIdForProvider('anthropic', 'claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6')
    expect(normalizeModelIdForProvider('openai', 'openai/gpt-5.4')).toBe('openai/gpt-5.4')
    expect(normalizeModelIdForProvider('codex', '  gpt-5.5  ')).toBe('codex/gpt-5.5')
  })

  it('provides default model ids for credential-backed providers', () => {
    expect(defaultModelIdForProvider('anthropic')).toBe('anthropic/claude-sonnet-4-6')
    expect(defaultModelIdForProvider('openai')).toBe('openai/gpt-5.4')
    expect(defaultModelIdForProvider('unknown')).toBe('')
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
