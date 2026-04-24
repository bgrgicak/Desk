import { useCallback, useRef, useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Thin wrapper that attaches drag-and-drop + hidden-file-input behavior to a
 * region. Callers render their existing layout as children and separately
 * render an optional trigger (button, menu item) that calls `openPicker()`.
 *
 * The overlay is purely visual feedback during a drag; files dispatched via
 * either path end up in a single `onFiles(files)` callback.
 */
export interface FileDropZoneHandle {
  openPicker(): void;
}

interface Props {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  multiple?: boolean;
  accept?: string;
  className?: string;
  overlayLabel?: string;
  /** Opt-out of the visual drop overlay (e.g. when the parent renders its own). */
  quiet?: boolean;
  children: (api: { openPicker: () => void; isDragging: boolean }) => ReactNode;
}

/**
 * Track drag-enter/leave correctly even when the cursor crosses child
 * elements, which otherwise fire spurious `dragleave` events.
 */
function useDragCounter(disabled: boolean) {
  const counter = useRef(0);
  const [isDragging, setDragging] = useState(false);

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      counter.current += 1;
      setDragging(true);
    },
    [disabled],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [disabled],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      counter.current = Math.max(0, counter.current - 1);
      if (counter.current === 0) setDragging(false);
    },
    [disabled],
  );

  const reset = useCallback(() => {
    counter.current = 0;
    setDragging(false);
  }, []);

  return { isDragging, onDragEnter, onDragOver, onDragLeave, reset };
}

export function FileDropZone({
  onFiles,
  disabled = false,
  multiple = true,
  accept,
  className,
  overlayLabel = "Drop to upload",
  quiet = false,
  children,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { isDragging, onDragEnter, onDragOver, onDragLeave, reset } =
    useDragCounter(disabled);

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      onFiles(multiple ? files : files.slice(0, 1));
    },
    [onFiles, multiple],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      reset();
      handleFiles(e.dataTransfer.files);
    },
    [disabled, handleFiles, reset],
  );

  const openPicker = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-dropzone
      data-dragging={isDragging || undefined}
    >
      {children({ openPicker, isDragging })}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        multiple={multiple}
        accept={accept}
        onChange={(e) => {
          handleFiles(e.target.files);
          // Reset so selecting the same file twice still fires onChange.
          e.target.value = "";
        }}
        data-testid="dropzone-file-input"
      />
      {isDragging && !quiet && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/5 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-md bg-background/90 px-3 py-2 text-sm font-medium shadow-sm">
            <Upload className="h-4 w-4" />
            {overlayLabel}
          </div>
        </div>
      )}
    </div>
  );
}
