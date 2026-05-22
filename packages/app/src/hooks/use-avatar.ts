import { useEffect, useState } from 'react'

const AVATAR_KEY = (userId: string) => `roomy.avatar.${userId}`
const CHANGE_EVENT = 'roomy:avatar-changed'

export function useAvatarUrl(userId: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    userId ? (localStorage.getItem(AVATAR_KEY(userId)) ?? null) : null,
  )

  useEffect(() => {
    const read = () => setUrl(userId ? (localStorage.getItem(AVATAR_KEY(userId)) ?? null) : null)
    window.addEventListener(CHANGE_EVENT, read)
    window.addEventListener('storage', read)
    return () => {
      window.removeEventListener(CHANGE_EVENT, read)
      window.removeEventListener('storage', read)
    }
  }, [userId])

  return url
}

export function saveAvatarUrl(userId: string, dataUrl: string): void {
  try {
    localStorage.setItem(AVATAR_KEY(userId), dataUrl)
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    /* ignore — e.g. storage quota exceeded */
  }
}

export function deleteAvatarUrl(userId: string): void {
  try {
    localStorage.removeItem(AVATAR_KEY(userId))
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    /* ignore */
  }
}

export function resizeToDataUrl(file: File, maxPx = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = ev => {
      const img = new Image()
      img.onerror = reject
      img.onload = () => {
        const scale = Math.min(maxPx / img.width, maxPx / img.height, 1)
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')?.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = ev.target!.result as string
    }
    reader.readAsDataURL(file)
  })
}
