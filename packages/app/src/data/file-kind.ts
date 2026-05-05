import type { LucideIcon } from 'lucide-react'
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Link2,
  StickyNote,
  Zap,
} from 'lucide-react'
import type { ContextItem } from './ui-types'

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'docx' | 'text' | 'app' | 'unknown'

/** True when `name` is a Desk app directory (ends with `.app`). */
export function isAppDirectory(name: string): boolean {
  return name.endsWith('.app') && name !== '.app'
}

const DOCX_EXTS = new Set(['docx'])
const DOCX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff',
])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv', 'm4v', 'avi'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'oga', 'm4a', 'flac', 'aac', 'opus', 'weba'])
const SPREADSHEET_EXTS = new Set(['csv', 'tsv'])
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'rar', '7z'])
const CODE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs', 'php',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'swift', 'kt', 'kts', 'dart', 'lua', 'r', 'pl', 'pm',
  'ex', 'exs', 'scala', 'clj', 'cljs', 'vim',
  'json', 'jsonl', 'ndjson', 'yml', 'yaml', 'toml',
  'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'dockerfile', 'makefile', 'gitignore', 'gitattributes', 'env', 'editorconfig',
])
const PLAIN_TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'rst', 'org', 'tex', 'log', 'ini', 'cfg', 'conf',
])

const TEXTUAL_APP_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-httpd-php',
])

function getExt(name: string): string {
  const i = name.lastIndexOf('.')
  if (i === -1) return ''
  return name.slice(i + 1).toLowerCase()
}

function hasRealExtension(name: string): boolean {
  return name.includes('.', 1)
}

export function isMarkdownFile(name: string, mimeType?: string | null): boolean {
  const ext = getExt(name)
  const mime = (mimeType ?? '').toLowerCase()
  return ext === 'md' || ext === 'markdown' || ext === 'mdx' || mime === 'text/markdown'
}

export function isHtmlFile(name: string, mimeType?: string | null): boolean {
  const ext = getExt(name)
  const mime = (mimeType ?? '').toLowerCase()
  return ext === 'html' || ext === 'htm' || mime === 'text/html'
}

export function fileKindFrom(name: string, mimeType?: string | null): FileKind {
  const mime = (mimeType ?? '').toLowerCase()
  const ext = getExt(name)
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (mime === 'text/html' || ext === 'html' || ext === 'htm') return 'html'
  if (DOCX_MIMES.has(mime) || DOCX_EXTS.has(ext)) return 'docx'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/') || VIDEO_EXTS.has(ext)) return 'video'
  if (mime.startsWith('audio/') || AUDIO_EXTS.has(ext)) return 'audio'
  if (mime.startsWith('text/') || TEXTUAL_APP_MIMES.has(mime)) return 'text'
  if (CODE_EXTS.has(ext) || PLAIN_TEXT_EXTS.has(ext) || SPREADSHEET_EXTS.has(ext)) return 'text'
  if (!hasRealExtension(name)) return 'text'
  return 'unknown'
}

export function fileKindForItem(item: ContextItem): FileKind {
  if (item.type === 'note' || item.type === 'link') return 'text'
  if (isAppDirectory(item.name)) return 'app'
  return fileKindFrom(item.name, item.mimeType)
}

export function iconForFile(name: string, mimeType?: string | null): LucideIcon {
  const kind = fileKindFrom(name, mimeType)
  const mime = (mimeType ?? '').toLowerCase()
  const ext = getExt(name)
  if (kind === 'pdf') return FileText
  if (kind === 'html') return FileCode
  if (kind === 'docx') return FileText
  if (kind === 'image') return FileImage
  if (kind === 'video') return FileVideo
  if (kind === 'audio') return FileAudio
  if (kind === 'text') {
    if (
      mime.includes('spreadsheet') ||
      mime.includes('excel') ||
      mime === 'text/csv' ||
      SPREADSHEET_EXTS.has(ext) ||
      ext === 'xls' || ext === 'xlsx' || ext === 'ods'
    ) return FileSpreadsheet
    if (CODE_EXTS.has(ext)) return FileCode
    return FileText
  }
  if (ARCHIVE_EXTS.has(ext)) return FileArchive
  return File
}

export function iconForItem(item: ContextItem): LucideIcon {
  if (item.type === 'note') return StickyNote
  if (item.type === 'link') return Link2
  if (item.type === 'app') return Zap
  return iconForFile(item.name, item.mimeType)
}
