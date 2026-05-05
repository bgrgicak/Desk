import { fileKindFrom, isAppDirectory, type FileKind } from '@/data/file-kind'

function hasSvgExtension(value: string): boolean {
  return value.toLowerCase().split(/[?#]/, 1)[0].endsWith('.svg')
}

export function isSvgPreview(name: string, path: string, mime?: string | null): boolean {
  const normalizedMime = (mime ?? '').toLowerCase()
  return normalizedMime === 'image/svg+xml' || hasSvgExtension(name) || hasSvgExtension(path)
}

export async function previewBlobFor(kind: FileKind, blob: Blob, name: string, path: string, mime?: string | null): Promise<Blob> {
  if (kind !== 'image' || !isSvgPreview(name, path, mime)) return blob
  if (blob.type.toLowerCase() === 'image/svg+xml') return blob
  return new Blob([await blob.text()], { type: 'image/svg+xml' })
}

export function previewKindFrom(name: string, path: string, mime?: string | null): FileKind {
  if (mime === 'inode/directory' || isAppDirectory(name) || isAppDirectory(path.split('/').pop() ?? '')) return 'app'
  if (isSvgPreview(name, path, mime)) return 'image'
  const pathKind = fileKindFrom(path, mime)
  if (pathKind === 'image') return pathKind
  const nameKind = fileKindFrom(name, mime)
  if (nameKind !== 'text' && nameKind !== 'unknown') return nameKind
  return pathKind
}
