import { useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { MergeView } from '@codemirror/merge'
import { basicSetup } from 'codemirror'
import { Button } from '@agent-desk/ui'

interface MergeEditorProps {
  /** The user's local (unsaved) version — left pane. */
  yours: string
  /** The server's current version written by the agent — right pane. */
  theirs: string
  /** Called with the resolved content when the user accepts their edits. */
  onChange: (value: string) => void
  /** Called when the user dismisses the merge view (keeps `yours` as the working copy). */
  onResolve: () => void
  filename: string
}

/**
 * Side-by-side merge view shown when a Save returns 409 (agent wrote the file
 * while the user had unsaved edits). Left = user's version, Right = agent's.
 * The user edits the left pane to reconcile, then clicks "Use this version".
 */
export function MergeEditor({ yours, theirs, onChange, onResolve, filename }: MergeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mergeViewRef = useRef<MergeView | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const view = new MergeView({
      a: {
        doc: yours,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChange(update.state.doc.toString())
            }
          }),
        ],
      },
      b: {
        doc: theirs,
        extensions: [basicSetup, EditorView.lineWrapping, EditorState.readOnly.of(true)],
      },
      parent: containerRef.current,
    })

    mergeViewRef.current = view
    return () => {
      view.destroy()
      mergeViewRef.current = null
    }
    // Only mount once — yours/theirs are the initial values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-4 px-4 py-2 border-b bg-amber-50 dark:bg-amber-950/30 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-amber-800 dark:text-amber-300">Conflict in {filename}</span>
          <span className="text-muted-foreground">— Agent updated this file while you were editing. Left = yours, Right = agent's.</span>
        </div>
        <Button size="sm" className="text-xs shrink-0" onClick={onResolve}>
          Use this version
        </Button>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 overflow-auto" />
    </div>
  )
}
