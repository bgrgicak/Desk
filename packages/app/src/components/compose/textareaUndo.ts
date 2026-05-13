export function replaceTextareaRangePreservingUndo(
  el: HTMLTextAreaElement,
  start: number,
  end: number,
  replacement: string,
) {
  el.focus()
  el.setSelectionRange(start, end)

  // execCommand is deprecated, but it remains the only broadly supported way
  // to make programmatic textarea edits participate in the browser's native
  // undo stack. Empty insertText is unreliable in Chromium/WebKit, so use the
  // native delete command when removing a selected mention token.
  const command = replacement === '' ? 'delete' : 'insertText'
  const applied = document.execCommand?.(command, false, replacement) ?? false
  if (!applied) {
    el.setRangeText(replacement, start, end, 'end')
  }
}
