/**
 * Result-time diff presentation for `wsl-edit`: the change it made, as hunks a
 * UI can draw, derived from the replacement itself rather than from a general
 * line diff.
 *
 * That is the whole trick. An edit knows exactly which regions it replaced, so
 * the hunks do not have to be *discovered* by comparing two texts — each one is
 * "the lines that occurrence touched, plus context". No diff algorithm, no
 * quadratic table for a large file, and no chance of the card disagreeing with
 * what was written.
 */

/**
 * Context lines shown on each side of an applied hunk. The same three the
 * platform's `edit` tool uses, so a change looks the same in the UI whichever
 * tool made it.
 */
export const HUNK_CONTEXT = 3

/**
 * Compute one hunk per replaced region.
 * @param path - the path to label the hunks with (the model-facing one).
 * @param before - the file's content before the edit.
 * @param offsets - start offsets of the occurrences that were replaced, ascending.
 * @param oldString - the text that was replaced at each offset.
 * @param newString - the text each occurrence was replaced with.
 * @returns one `{ path, oldText, newText }` per hunk, in file order; empty when nothing was replaced.
 */
export function computeHunks(path, before, offsets, oldString, newString) {
  if (offsets.length === 0) return []
  const starts = lineStarts(before)
  const lastLine = starts.length - 1
  const delta = newString.length - oldString.length

  // One window per occurrence, in file order: the lines it touched, widened by
  // HUNK_CONTEXT on each side and clamped to the file.
  const windows = offsets.map((offset) => {
    const first = lineAt(starts, offset)
    const last = lineAt(starts, Math.max(offset, offset + oldString.length - 1))
    const from = Math.max(0, first - HUNK_CONTEXT)
    const to = Math.min(lastLine, last + HUNK_CONTEXT)
    return { from, to, offset }
  })

  // Two replacements a few lines apart belong in one card, not two overlapping
  // ones: merge windows whose line ranges touch or overlap.
  const merged = []
  for (const window of windows) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && window.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, window.to)
      previous.offsets.push(window.offset)
    } else {
      merged.push({ from: window.from, to: window.to, offsets: [window.offset] })
    }
  }

  return merged.map((hunk) => {
    const start = starts[hunk.from]
    const end = hunk.to + 1 < starts.length ? starts[hunk.to + 1] : before.length
    const oldText = before.slice(start, end)
    // Replay the replacements that live inside this window, in order, so the
    // hunk is the window as it was and as it now is.
    let newText = oldText
    let shift = 0
    for (const offset of hunk.offsets) {
      const at = offset - start + shift
      newText = newText.slice(0, at) + newString + newText.slice(at + oldString.length)
      shift += delta
    }
    return { path, oldText, newText }
  })
}

/** Offsets at which each line begins, plus the offset just past the last line. */
function lineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

/** Index of the line containing `offset`, by binary search over {@link lineStarts}. */
function lineAt(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}
