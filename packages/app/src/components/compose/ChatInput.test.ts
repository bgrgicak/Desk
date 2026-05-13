import { describe, expect, it } from 'vitest'
import {
  buildSendOptions,
  didNativeHistoryChangeText,
  inputHistoryDirection,
  keyboardHistoryDirection,
  shouldPinTextareaScrollToEnd,
} from './ChatInput'
import { replaceTextareaRangePreservingUndo } from './textareaUndo'

describe('ChatInput send options', () => {
  it('does not turn a follow-up in a persisted task-goal chat into a new task', () => {
    expect(buildSendOptions('task', undefined, 'what can we do about it?')).toEqual(undefined)
  })

  it('creates a task only when task is explicitly selected in the composer', () => {
    expect(buildSendOptions(null, 'task', 'Review follow-up')).toEqual({
      kind: 'task',
      title: 'Review follow-up',
      goal: 'task',
    })
  })
})

describe('chat input history fallback', () => {
  it('treats unchanged text as a failed native undo even when the caret moved', () => {
    expect(didNativeHistoryChangeText(
      { value: 'hello', selectionStart: 5, selectionEnd: 5 },
      { value: 'hello', selectionStart: 0, selectionEnd: 0 },
    )).toBe(false)
  })

  it('accepts native undo only when the text value actually changes', () => {
    expect(didNativeHistoryChangeText(
      { value: 'hello', selectionStart: 5, selectionEnd: 5 },
      { value: '', selectionStart: 0, selectionEnd: 0 },
    )).toBe(true)
  })

  it('maps common keyboard undo and redo shortcuts', () => {
    expect(keyboardHistoryDirection({ metaKey: true, ctrlKey: false, shiftKey: false, key: 'z' })).toBe(-1)
    expect(keyboardHistoryDirection({ metaKey: true, ctrlKey: false, shiftKey: true, key: 'z' })).toBe(1)
    expect(keyboardHistoryDirection({ metaKey: false, ctrlKey: true, shiftKey: false, key: 'y' })).toBe(1)
    expect(keyboardHistoryDirection({ metaKey: false, ctrlKey: false, shiftKey: false, key: 'Undo' })).toBe(-1)
    expect(keyboardHistoryDirection({ metaKey: false, ctrlKey: false, shiftKey: false, key: 'Redo' })).toBe(1)
    expect(keyboardHistoryDirection({ metaKey: false, ctrlKey: false, shiftKey: false, key: 'z' })).toBe(null)
  })

  it('maps beforeinput history events from edit-menu and touch-bar undo/redo', () => {
    expect(inputHistoryDirection('historyUndo')).toBe(-1)
    expect(inputHistoryDirection('historyRedo')).toBe(1)
    expect(inputHistoryDirection('insertText')).toBe(null)
    expect(inputHistoryDirection(undefined)).toBe(null)
  })
})

describe('chat input textarea scroll', () => {
  it('pins the scroll position to the end while composing at the end of a long draft', () => {
    expect(shouldPinTextareaScrollToEnd(1200, 1200)).toBe(true)
  })

  it('does not force-scroll to the bottom when editing earlier text', () => {
    expect(shouldPinTextareaScrollToEnd(1200, 300)).toBe(false)
  })
})

describe('replaceTextareaRangePreservingUndo', () => {
  function createTextareaLike(value: string) {
    const textarea = {
      value,
      selectionStart: 0,
      selectionEnd: 0,
      focusCalls: 0,
      focus() {
        this.focusCalls += 1
      },
      setSelectionRange(start: number, end: number) {
        this.selectionStart = start
        this.selectionEnd = end
      },
      setRangeText(replacement: string, start: number, end: number, selectionMode?: SelectionMode) {
        this.value = this.value.slice(0, start) + replacement + this.value.slice(end)
        if (selectionMode === 'end') {
          const cursor = start + replacement.length
          this.selectionStart = cursor
          this.selectionEnd = cursor
        }
      },
    }
    return textarea
  }

  it('uses delete for removals so programmatic edits join the native undo stack', () => {
    const textarea = createTextareaLike('hello @doc world')
    const previousDocument = globalThis.document
    const calls: unknown[][] = []
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        execCommand(command: string, showUi: boolean, replacement: string) {
          calls.push([command, showUi, replacement])
          textarea.setRangeText(replacement, textarea.selectionStart, textarea.selectionEnd, 'end')
          return true
        },
      },
    })

    try {
      replaceTextareaRangePreservingUndo(textarea as unknown as HTMLTextAreaElement, 6, 10, '')
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
    }

    expect(calls).toEqual([['delete', false, '']])
    expect(textarea.value).toBe('hello  world')
    expect(textarea.selectionStart).toBe(6)
    expect(textarea.selectionEnd).toBe(6)
    expect(textarea.focusCalls).toBe(1)
  })

  it('uses insertText for non-empty replacements', () => {
    const textarea = createTextareaLike('hello @doc world')
    const previousDocument = globalThis.document
    const calls: unknown[][] = []
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        execCommand(command: string, showUi: boolean, replacement: string) {
          calls.push([command, showUi, replacement])
          textarea.setRangeText(replacement, textarea.selectionStart, textarea.selectionEnd, 'end')
          return true
        },
      },
    })

    try {
      replaceTextareaRangePreservingUndo(textarea as unknown as HTMLTextAreaElement, 6, 10, 'doc')
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
    }

    expect(calls).toEqual([['insertText', false, 'doc']])
    expect(textarea.value).toBe('hello doc world')
    expect(textarea.selectionStart).toBe(9)
    expect(textarea.selectionEnd).toBe(9)
  })

  it('falls back to setRangeText when insertText is unavailable', () => {
    const textarea = createTextareaLike('hello @doc world')
    const previousDocument = globalThis.document
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { execCommand: () => false },
    })

    try {
      replaceTextareaRangePreservingUndo(textarea as unknown as HTMLTextAreaElement, 6, 10, '')
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
    }

    expect(textarea.value).toBe('hello  world')
    expect(textarea.selectionStart).toBe(6)
    expect(textarea.selectionEnd).toBe(6)
  })
})
