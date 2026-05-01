import { useCallback, useRef, useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { cn } from "@agent-desk/ui";

/**
 * An entry produced by dropping or picking files. `relativePath` is the
 * file's path relative to the top-level drop/selection root — for a
 * plain file it equals `file.name`; for files from a directory pick
 * (or dropped folder) it includes the intermediate subdirectories,
 * e.g. `Photos/2024/beach.jpg`.
 */
export interface UploadEntry {
  file: File;
  relativePath: string;
}

/**
 * Thin wrapper that attaches drag-and-drop + hidden-file-input behavior to a
 * region. Callers render their existing layout as children and separately
 * render an optional trigger (button, menu item) that calls `openPicker()`.
 *
 * The overlay is purely visual feedback during a drag; files dispatched via
 * either path end up in a single `onFiles(entries)` callback.
 *
 * When `directory` is true, the file picker is switched to directory mode
 * (`webkitdirectory`) and dropped folders are walked recursively so the
 * caller receives every descendant file with its relative path.
 */
export interface FileDropZoneHandle {
  openPicker(directory?: boolean): void;
}

interface Props {
  onFiles: (entries: UploadEntry[]) => void;
  disabled?: boolean;
  multiple?: boolean;
  accept?: string;
  className?: string;
  overlayLabel?: string;
  /** Opt-out of the visual drop overlay (e.g. when the parent renders its own). */
  quiet?: boolean;
  /** Enable directory-mode picker and recursive folder traversal on drop. */
  directory?: boolean;
  children: (api: {
    openPicker: () => void;
    openDirectoryPicker: () => void;
    isDragging: boolean;
  }) => ReactNode;
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

/**
 * Minimal `FileSystemEntry` types — not in the DOM lib because the API
 * lives behind `webkitGetAsEntry()` and is still considered proprietary.
 * Walking these in-order rather than via a DataTransferItemList lets us
 * preserve the relative path that the browser exposes per entry.
 */
interface FSEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FSFileEntry extends FSEntry {
  file(onSuccess: (f: File) => void, onError?: (e: unknown) => void): void;
}
interface FSDirectoryEntry extends FSEntry {
  createReader(): {
    readEntries(onSuccess: (entries: FSEntry[]) => void, onError?: (e: unknown) => void): void;
  };
}

function readAllEntries(
  reader: ReturnType<FSDirectoryEntry["createReader"]>,
): Promise<FSEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FSEntry[] = [];
    const pump = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
        } else {
          all.push(...batch);
          pump();
        }
      }, reject);
    pump();
  });
}

async function walkEntry(
  entry: FSEntry,
  dropRootName: string,
): Promise<UploadEntry[]> {
  if (entry.isFile) {
    const file: File = await new Promise((resolve, reject) =>
      (entry as FSFileEntry).file(resolve, reject),
    );
    // `fullPath` starts with "/". The drop root itself is the user's
    // mental "folder I dragged" — keep its name in the relative path so
    // the server recreates it. For files dropped at the top level,
    // this degrades to just the filename.
    const full = entry.fullPath.replace(/^\/+/, "");
    const relativePath = dropRootName
      ? full
      : file.name;
    return [{ file, relativePath }];
  }
  if (entry.isDirectory) {
    const reader = (entry as FSDirectoryEntry).createReader();
    const children = await readAllEntries(reader);
    const out: UploadEntry[] = [];
    for (const c of children) {
      out.push(...(await walkEntry(c, dropRootName || entry.name)));
    }
    return out;
  }
  return [];
}

async function collectFromDataTransfer(
  dt: DataTransfer,
): Promise<UploadEntry[]> {
  const items = Array.from(dt.items);
  const out: UploadEntry[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    // `webkitGetAsEntry` is how browsers expose folder entries. Without
    // it we only see the top-level dropped items (folders become empty
    // File-like objects), which is why directory uploads need this path.
    const maybeEntry = (item as unknown as { webkitGetAsEntry?: () => FSEntry | null })
      .webkitGetAsEntry?.();
    if (maybeEntry) {
      out.push(...(await walkEntry(maybeEntry, "")));
    } else {
      const f = item.getAsFile();
      if (f) out.push({ file: f, relativePath: f.name });
    }
  }
  return out;
}

function collectFromFileList(list: FileList | null): UploadEntry[] {
  if (!list) return [];
  const out: UploadEntry[] = [];
  for (const file of Array.from(list)) {
    // Directory-mode picker sets `webkitRelativePath` on each File so
    // we can reconstruct the tree client-side.
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    out.push({ file, relativePath: rel && rel !== "" ? rel : file.name });
  }
  return out;
}

export function FileDropZone({
  onFiles,
  disabled = false,
  multiple = true,
  accept,
  className,
  overlayLabel = "Drop to upload",
  quiet = false,
  directory = false,
  children,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const { isDragging, onDragEnter, onDragOver, onDragLeave, reset } =
    useDragCounter(disabled);

  const handleFiles = useCallback(
    (entries: UploadEntry[]) => {
      if (entries.length === 0) return;
      onFiles(multiple ? entries : entries.slice(0, 1));
    },
    [onFiles, multiple],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      reset();
      if (directory) {
        const entries = await collectFromDataTransfer(e.dataTransfer);
        handleFiles(entries);
      } else {
        handleFiles(collectFromFileList(e.dataTransfer.files));
      }
    },
    [disabled, handleFiles, reset, directory],
  );

  const openPicker = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const openDirectoryPicker = useCallback(() => {
    if (disabled) return;
    dirInputRef.current?.click();
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
      {children({ openPicker, openDirectoryPicker, isDragging })}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        multiple={multiple}
        accept={accept}
        onChange={(e) => {
          handleFiles(collectFromFileList(e.target.files));
          // Reset so selecting the same file twice still fires onChange.
          e.target.value = "";
        }}
        data-testid="dropzone-file-input"
      />
      {directory && (
        <input
          ref={(el) => {
            dirInputRef.current = el;
            if (el) {
              // `webkitdirectory` and `directory` aren't in the React
              // attribute type map, so setAttribute at the DOM level
              // is the reliable way to switch the picker to directory
              // mode across Chromium, Firefox, and Safari.
              el.setAttribute("webkitdirectory", "");
              el.setAttribute("directory", "");
            }
          }}
          type="file"
          className="hidden"
          multiple
          onChange={(e) => {
            handleFiles(collectFromFileList(e.target.files));
            e.target.value = "";
          }}
          data-testid="dropzone-directory-input"
        />
      )}
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
