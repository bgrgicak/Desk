import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="prose prose-neutral prose-sm max-w-none text-foreground prose-headings:font-semibold prose-headings:text-foreground prose-p:text-sm prose-p:leading-relaxed prose-p:my-1 prose-li:text-sm prose-li:my-0 prose-ul:my-1 prose-ol:my-1 prose-strong:text-foreground prose-strong:font-semibold prose-code:text-sm prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-pre:bg-muted prose-pre:text-xs prose-table:text-sm prose-th:text-left prose-th:font-medium prose-a:text-primary">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}
