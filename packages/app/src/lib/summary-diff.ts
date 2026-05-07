/**
 * Tiny line-based diff for the dev-mode summary regeneration view
 * (memory-system spec, P2.5). Operates on whole lines — every character
 * inside a changed line counts as a difference. Output is one segment
 * per line so the renderer can color them red / green / unchanged.
 *
 * The algorithm is the standard LCS-table diff, kept tight so it has no
 * runtime dependencies. Summaries are short enough that the O(n*m)
 * memory and time aren't a concern.
 */

export type DiffSegment =
  | { kind: "equal"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

/** Splits text into lines. Trailing newline produces no empty segment. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

/**
 * Returns a sequence of equal/remove/add segments that, when applied in
 * order, transform `before` into `after`. Two consecutive runs of the
 * same kind are coalesced into a single segment with newline-joined
 * text — friendlier for the renderer.
 */
export function diffLines(before: string, after: string): DiffSegment[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // LCS table: lcs[i][j] = length of the longest common subsequence of
  // a[0..i] and b[0..j]. Use Uint32Array per row for compact storage.
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pushSegment(segments, "equal", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pushSegment(segments, "remove", a[i]);
      i++;
    } else {
      pushSegment(segments, "add", b[j]);
      j++;
    }
  }
  while (i < m) pushSegment(segments, "remove", a[i++]);
  while (j < n) pushSegment(segments, "add", b[j++]);
  return segments;
}

function pushSegment(out: DiffSegment[], kind: DiffSegment["kind"], line: string): void {
  const last = out[out.length - 1];
  if (last && last.kind === kind) {
    last.text += "\n" + line;
    return;
  }
  out.push({ kind, text: line });
}
