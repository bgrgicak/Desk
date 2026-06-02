import { fileKindFrom, isAppDirectory, type FileKind } from '@/data/file-kind'

function normalizedPathish(value: string): string {
  return value.toLowerCase().split(/[?#]/, 1)[0]
}

function hasSvgExtension(value: string): boolean {
  return normalizedPathish(value).endsWith('.svg')
}

function hasHeicExtension(value: string): boolean {
  const normalized = normalizedPathish(value)
  return normalized.endsWith('.heic') || normalized.endsWith('.heif')
}

export function isSvgPreview(name: string, path: string, mime?: string | null): boolean {
  const normalizedMime = (mime ?? '').toLowerCase()
  return normalizedMime === 'image/svg+xml' || hasSvgExtension(name) || hasSvgExtension(path)
}

export function isHeicPreview(name: string, path: string, mime?: string | null): boolean {
  const normalizedMime = (mime ?? '').toLowerCase()
  return normalizedMime === 'image/heic'
    || normalizedMime === 'image/heif'
    || normalizedMime === 'image/heic-sequence'
    || normalizedMime === 'image/heif-sequence'
    || hasHeicExtension(name)
    || hasHeicExtension(path)
}

export async function previewBlobFor(kind: FileKind, blob: Blob, name: string, path: string, mime?: string | null): Promise<Blob> {
  if (kind === 'html') {
    const html = await blob.text()
    const resizeScript = `<script>(()=>{const t='roomy.preview.resize';let n=0;function s(){const d=document.documentElement;const b=document.body;const h=Math.ceil(Math.max(b?.scrollHeight||0,d?.scrollHeight||0,b?.offsetHeight||0,d?.offsetHeight||0));window.parent.postMessage({type:t,height:h},'*')}function r(){if(n)return;n=requestAnimationFrame(()=>{n=0;s()})}function o(){s();if(typeof ResizeObserver!=='undefined'){const d=document.documentElement;const b=document.body;const ro=new ResizeObserver(r);ro.observe(d);if(b)ro.observe(b);window.addEventListener('load',r,{once:true})}else{window.addEventListener('resize',r);window.addEventListener('load',r,{once:true})}}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',o,{once:true})}else{o()}})();</script>`
    if (html.includes('</head>')) return new Blob([html.replace('</head>', `${resizeScript}</head>`)], { type: 'text/html' })
    return new Blob([resizeScript + html], { type: 'text/html' })
  }

  if (kind !== 'image') return blob

  if (isHeicPreview(name, path, mime)) {
    const { default: heic2any } = await import('heic2any')
    const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.92 })
    return Array.isArray(converted) ? converted[0] : converted
  }

  if (!isSvgPreview(name, path, mime)) return blob
  if (blob.type.toLowerCase() === 'image/svg+xml') return blob
  return new Blob([await blob.text()], { type: 'image/svg+xml' })
}

export function previewKindFrom(name: string, path: string, mime?: string | null): FileKind {
  const basename = path.split('/').pop() ?? ''
  if (isAppDirectory(name) || isAppDirectory(basename)) return 'app'
  if (mime === 'inode/directory') return 'unknown'
  if (isSvgPreview(name, path, mime)) return 'image'
  const pathKind = fileKindFrom(path, mime)
  if (pathKind === 'image') return pathKind
  const nameKind = fileKindFrom(name, mime)
  if (nameKind !== 'text' && nameKind !== 'unknown') return nameKind
  return pathKind
}
