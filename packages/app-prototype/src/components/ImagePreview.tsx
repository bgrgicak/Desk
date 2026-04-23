import { FileImage } from 'lucide-react'

interface ImagePreviewProps {
  zoom: number
}

export function ImagePreview({ zoom }: ImagePreviewProps) {
  return (
    <div className="relative flex flex-1 min-h-full items-center justify-center bg-zinc-700 overflow-hidden">
      <div
        className="transition-transform duration-150 ease-out select-none"
        style={{ transform: `scale(${zoom})` }}
      >
        <div className="w-[520px] h-[380px] bg-zinc-600 flex items-center justify-center">
          <FileImage className="h-24 w-24 text-zinc-500" />
        </div>
      </div>
    </div>
  )
}
