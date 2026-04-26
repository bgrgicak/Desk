import { useMemo } from 'react'
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'

function extFor(name: string): string {
  const i = name.lastIndexOf('.')
  if (i === -1) return ''
  return name.slice(i + 1).toLowerCase()
}

function languageFor(name: string, mimeType?: string | null): Extension | null {
  const ext = extFor(name)
  const mime = (mimeType ?? '').toLowerCase()

  if (ext === 'md' || ext === 'markdown' || ext === 'mdx' || mime === 'text/markdown') {
    return markdown()
  }
  if (ext === 'ts' || ext === 'tsx') return javascript({ jsx: true, typescript: true })
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return javascript({ jsx: ext.endsWith('x') })
  if (ext === 'py' || mime === 'text/x-python') return python()
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson' || mime === 'application/json') return json()
  if (ext === 'yml' || ext === 'yaml' || mime === 'application/yaml' || mime === 'application/x-yaml') return yaml()
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') return html()
  if (ext === 'css' || ext === 'scss' || ext === 'sass' || ext === 'less') return css()
  return null
}

interface TextFileEditorProps {
  value: string
  onChange: (next: string) => void
  filename: string
  mimeType?: string | null
  readOnly?: boolean
}

/**
 * Editable CodeMirror view for library text files. Syntax highlighting is
 * language-aware for a curated set of extensions (markdown, JS/TS, Python,
 * JSON, YAML, HTML, CSS); everything else (csv, txt, log, shell, sql, …)
 * falls back to plain text with monospace + line wrapping.
 */
export function TextFileEditor({
  value,
  onChange,
  filename,
  mimeType,
  readOnly,
}: TextFileEditorProps) {
  const extensions = useMemo(() => {
    const exts: Extension[] = [EditorView.lineWrapping]
    const lang = languageFor(filename, mimeType)
    if (lang) exts.push(lang)
    return exts
  }, [filename, mimeType])

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      readOnly={readOnly}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        foldGutter: true,
        autocompletion: false,
        highlightSelectionMatches: false,
      }}
      className="text-sm"
      height="100%"
      style={{ height: '100%' }}
    />
  )
}
