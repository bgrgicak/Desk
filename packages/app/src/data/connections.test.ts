import { describe, expect, it } from 'vitest'
import { LOCAL_FILESYSTEM_CONNECTION_KIND } from '@roomy-ai/shared'
import {
  MODEL_CONNECTION_KINDS,
  isModelConnectionKind,
  workspaceConnectionProviderForKind,
} from './connections'

describe('connection scope catalog', () => {
  it('classifies model connections as global settings entries', () => {
    expect(MODEL_CONNECTION_KINDS).toEqual(['claude', 'chatgpt', 'codex'])
    expect(isModelConnectionKind('claude')).toBe(true)
    expect(isModelConnectionKind('chatgpt')).toBe(true)
    expect(isModelConnectionKind('codex')).toBe(true)
  })

  it('keeps non-model connection providers workspace grantable', () => {
    expect(workspaceConnectionProviderForKind('github')).toBe('GITHUB_TOKEN')
    expect(workspaceConnectionProviderForKind(LOCAL_FILESYSTEM_CONNECTION_KIND)).toBe('local_filesystem')
    expect(workspaceConnectionProviderForKind('claude')).toBeUndefined()
  })
})
