import { describe, expect, it } from 'vitest'
import {
  buildPath,
  encodeAccountSettings,
  encodeWorkspaceSettings,
  mergeSearch,
  parseAccountSettings,
  parseWorkspaceSettings,
} from './nav'

describe('parseWorkspaceSettings', () => {
  it('returns null for empty / unknown sections', () => {
    expect(parseWorkspaceSettings(null)).toBeNull()
    expect(parseWorkspaceSettings('')).toBeNull()
    expect(parseWorkspaceSettings('bogus')).toBeNull()
  })

  it('parses bare sections', () => {
    expect(parseWorkspaceSettings('workspace')).toEqual({
      section: 'workspace',
      connectionsFocus: null,
    })
    expect(parseWorkspaceSettings('connections')).toEqual({
      section: 'connections',
      connectionsFocus: null,
    })
    expect(parseWorkspaceSettings('preferences')).toEqual({
      section: 'preferences',
      connectionsFocus: null,
    })
  })

  it('parses connections sub-focus', () => {
    expect(parseWorkspaceSettings('connections.picker')).toEqual({
      section: 'connections',
      connectionsFocus: { mode: 'picker' },
    })
    expect(parseWorkspaceSettings('connections.new.claude')).toEqual({
      section: 'connections',
      connectionsFocus: { mode: 'new', kind: 'claude' },
    })
    expect(parseWorkspaceSettings('connections.edit.conn_abc')).toEqual({
      section: 'connections',
      connectionsFocus: { mode: 'edit', id: 'conn_abc' },
    })
  })

  it('rejoins ids that contain dots', () => {
    expect(parseWorkspaceSettings('connections.edit.conn.with.dots')).toEqual({
      section: 'connections',
      connectionsFocus: { mode: 'edit', id: 'conn.with.dots' },
    })
  })

  it('falls back to plain list on malformed sub-focus', () => {
    expect(parseWorkspaceSettings('connections.new')).toEqual({
      section: 'connections',
      connectionsFocus: null,
    })
    expect(parseWorkspaceSettings('connections.junk')).toEqual({
      section: 'connections',
      connectionsFocus: null,
    })
  })
})

describe('parseAccountSettings', () => {
  it('returns null for empty / unknown sections', () => {
    expect(parseAccountSettings(null)).toBeNull()
    expect(parseAccountSettings('bogus')).toBeNull()
  })

  it('parses bare sections', () => {
    expect(parseAccountSettings('account')).toEqual({
      section: 'account',
      modelsFocus: null,
    })
    expect(parseAccountSettings('models')).toEqual({
      section: 'models',
      modelsFocus: null,
    })
    expect(parseAccountSettings('notifications')).toEqual({
      section: 'notifications',
      modelsFocus: null,
    })
  })

  it('parses models sub-focus', () => {
    expect(parseAccountSettings('models.new')).toEqual({
      section: 'models',
      modelsFocus: { mode: 'new' },
    })
    expect(parseAccountSettings('models.edit.agt_xyz')).toEqual({
      section: 'models',
      modelsFocus: { mode: 'edit', id: 'agt_xyz' },
    })
  })
})

describe('encodeWorkspaceSettings round-trips through parseWorkspaceSettings', () => {
  const cases = [
    { section: 'workspace' as const, connectionsFocus: null },
    { section: 'preferences' as const, connectionsFocus: null },
    { section: 'connections' as const, connectionsFocus: null },
    {
      section: 'connections' as const,
      connectionsFocus: { mode: 'picker' as const },
    },
    {
      section: 'connections' as const,
      connectionsFocus: { mode: 'new' as const, kind: 'claude' },
    },
    {
      section: 'connections' as const,
      connectionsFocus: { mode: 'edit' as const, id: 'conn_abc' },
    },
  ]
  it.each(cases)('round-trips %j', (state) => {
    const encoded = encodeWorkspaceSettings(state)
    expect(parseWorkspaceSettings(encoded)).toEqual(state)
  })
})

describe('encodeAccountSettings round-trips through parseAccountSettings', () => {
  const cases = [
    { section: 'account' as const, modelsFocus: null },
    { section: 'notifications' as const, modelsFocus: null },
    { section: 'preferences' as const, modelsFocus: null },
    { section: 'models' as const, modelsFocus: null },
    {
      section: 'models' as const,
      modelsFocus: { mode: 'new' as const },
    },
    {
      section: 'models' as const,
      modelsFocus: { mode: 'edit' as const, id: 'agt_xyz' },
    },
  ]
  it.each(cases)('round-trips %j', (state) => {
    const encoded = encodeAccountSettings(state)
    expect(parseAccountSettings(encoded)).toEqual(state)
  })
})

describe('buildPath', () => {
  it('omits empty query strings', () => {
    expect(buildPath('ws1', 'tasks')).toBe('/w/ws1/tasks')
  })

  it('serialises settings + account params', () => {
    expect(buildPath('ws1', 'tasks', { settings: 'workspace' })).toBe(
      '/w/ws1/tasks?settings=workspace',
    )
    expect(buildPath('ws1', 'tasks', { account: 'models.new' })).toBe(
      '/w/ws1/tasks?account=models.new',
    )
  })
})

describe('mergeSearch', () => {
  it('adds a fresh param', () => {
    expect(mergeSearch('', { account: 'models' })).toBe('?account=models')
  })

  it('preserves existing params', () => {
    expect(mergeSearch('?chat=c1', { account: 'models' })).toBe(
      '?chat=c1&account=models',
    )
  })

  it('replaces an existing value', () => {
    expect(mergeSearch('?account=account', { account: 'models' })).toBe(
      '?account=models',
    )
  })

  it('deletes when value is null / empty', () => {
    expect(mergeSearch('?chat=c1&account=models', { account: null })).toBe(
      '?chat=c1',
    )
    expect(mergeSearch('?account=models', { account: '' })).toBe('')
  })
})
