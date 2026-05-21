import { describe, it, expect } from 'vitest'
import reducer, {
  bumpFileChangeCounter,
  selectFileChangeCounter,
} from './derivedSlice'

describe('bumpFileChangeCounter', () => {
  it('starts at 0 for an unknown path', () => {
    const state = reducer(undefined, { type: '@@INIT' })
    expect(selectFileChangeCounter({ derived: state } as never, 'some/path.md')).toBe(0)
  })

  it('increments counter for the given path', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, bumpFileChangeCounter('notes/foo.md'))
    expect(selectFileChangeCounter({ derived: state } as never, 'notes/foo.md')).toBe(1)
  })

  it('increments again on subsequent bumps', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, bumpFileChangeCounter('notes/foo.md'))
    state = reducer(state, bumpFileChangeCounter('notes/foo.md'))
    expect(selectFileChangeCounter({ derived: state } as never, 'notes/foo.md')).toBe(2)
  })

  it('keeps counters isolated per path', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, bumpFileChangeCounter('a.md'))
    state = reducer(state, bumpFileChangeCounter('a.md'))
    state = reducer(state, bumpFileChangeCounter('b.md'))
    expect(selectFileChangeCounter({ derived: state } as never, 'a.md')).toBe(2)
    expect(selectFileChangeCounter({ derived: state } as never, 'b.md')).toBe(1)
  })
})

// The previous `running chat tracking`, `cold-start hydration via
// getChats`, `cold-start hydration via getChatMessages`, and
// `cold-start hydration with real store` test suites covered the
// removed runningChatIds/failedChatIds/wsKnownChatIds machinery.
// That state is gone — running/failed live on the server and ride
// along on every chat.updated payload — so the suites would have
// nothing to assert against. They were deleted with the surface.
