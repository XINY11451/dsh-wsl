// The sidebar terminal's startup directory — read and rewritten where it lives.
//
// The 新建终端 shell belongs to another plugin
// (`@deepseek-ai/dsh-api-terminal-controller`), so this plugin cannot reach it
// through its own settings row: only the profile's own patch layer can override that
// row. This module is the one place that reads and rewrites the override, and it
// deliberately touches exactly ONE line — the `args:` line of the
// `- id: terminal-controller` entry — because the patch file is the user's own
// hand-written composition, not this plugin's storage.
//
// Everything here is a pure function over text, so the rules are testable without a
// profile on disk; `index.js` owns the file I/O, the backup and the routes.
//
// `wsl.exe` takes the directory as `--cd <dir>`: a Linux path, `~`, or an absolute
// Windows path (both sides are translated). WHERE the flag sits matters — everything
// after `-e`/`--exec` is the command line handed to the shell, so `--cd` must come
// BEFORE it. That is why this module inserts the flag there instead of appending it.
//
// Why the arguments are rewritten as a whole rather than as a text substitution: the
// line is a YAML flow sequence, so a naive `replace('--cd', …)` would corrupt a path
// that merely contains the text, and removing a flag means removing its value too.
// Parsing it into tokens and rendering it back is the only way to be sure that what
// lands is still a valid, single-line sequence.

/** The row this module edits, and the flag it owns. */
export const TERMINAL_ROW_ID = 'terminal-controller'
export const CWD_FLAG = '--cd'

/** `wsl.exe` hands everything after one of these to the shell as the command line. */
const EXEC_FLAGS = new Set(['-e', '--exec'])

/**
 * A patch entry starts with a dash; its indentation decides the extent of the block it
 * opens. Entries are normally top-level, but an override nested under an `insert:` list
 * is still the same override, so the row is matched at ANY indentation and the block
 * ends at the next list item at the same or a shallower indent.
 */
const ENTRY_RE = /^([ \t]*)-(?:[ \t]|$)/
const ROW_RE = /^([ \t]*)-[ \t]+id:[ \t]*['"]?terminal-controller['"]?[ \t]*(?:#.*)?$/
const SHELL_RE = /^([ \t]*)shell:[ \t]*(?:#.*)?$/
const ARGS_RE = /^([ \t]*)args:[ \t]*(.*?)[ \t]*$/

const NO_ROW_ERROR = '这个 profile 的 patch 里没有指向 WSL 的侧边栏终端（terminal-controller），没有可改的行'
const NO_SHELL_ERROR = '这一段里的 `shell:` 不是本插件能安全改写的写法（需要块式写法、`args:` 独占一行），未做修改'
const NO_ARGS_ERROR = '这一段里找不到单行的 `args:` 行，为避免改坏文件，未做修改'
const AMBIGUOUS_ARGS_ERROR = '这一段里有不止一处 `args:`，无法确定该改哪一行，未做修改'
const SHAPE_ERROR = '`args:` 那一行不是本插件能安全解析的写法，为避免改坏文件，未做修改'

/**
 * Split patch text into logical lines plus each line's own terminator.
 *
 * The terminators are kept PER LINE rather than as one file-wide setting, because a
 * patch file can genuinely be mixed: measured on the author's own profile, 5 lines end
 * with CRLF and 37 with LF, written by different tools over time. Rewriting one line
 * must not normalize the other 41, or the user's diff shows the whole file as changed
 * and `verifyTerminalRewrite` below — correctly — refuses the write.
 */
export function splitPatchLines(text) {
  const parts = String(text).split(/(\r?\n)/)
  const lines = []
  const eols = []
  for (let index = 0; index < parts.length; index += 2) {
    lines.push(parts[index])
    eols.push(index + 1 < parts.length ? parts[index + 1] : '')
  }
  return { lines, eols }
}

/** Put patch text back together exactly the way `splitPatchLines` took it apart. */
export function joinPatchLines(lines, eols) {
  let text = ''
  for (let index = 0; index < lines.length; index += 1) text += lines[index] + (eols[index] ?? '')
  return text
}

/**
 * Check one directory typed into the panel.
 *
 * Rejected outright — because the value is rendered into a YAML scalar and then
 * handed to `wsl.exe` — are line breaks, quote characters and control characters. A
 * leading or trailing space is trimmed rather than refused (`  ` is how a user clears
 * the field); spaces INSIDE the value are legal and pass through, since `--cd` takes
 * one argument and the shell is spawned with an argv list, never through a shell.
 *
 * @returns `{ ok, value, error }` — `value` is the trimmed directory, `''` meaning
 *   "no `--cd` at all".
 */
export function validateTerminalCwd(raw) {
  if (typeof raw !== 'string') return { ok: false, value: '', error: 'path 必须是字符串' }
  if (/[\r\n]/.test(raw)) return { ok: false, value: '', error: '路径不能包含换行' }
  const value = raw.trim()
  if (value === '') return { ok: true, value: '', error: null }
  if (/['"]/.test(value)) return { ok: false, value: '', error: '路径不能包含引号' }
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, value: '', error: '路径不能包含控制字符' }
  return { ok: true, value, error: null }
}

/**
 * Find the `args:` line of the terminal row.
 *
 * The entry's extent is bounded by the next list item at the same or a shallower indent,
 * so an `args:` belonging to a LATER entry can never be mistaken for this one — while a
 * deeper list inside the row (a nested block sequence) does not cut the block short.
 *
 * The search is then anchored on the row's own block-style `shell:` line, because that is
 * where the schema puts the args this feature owns. An `args:` elsewhere in the block, or
 * a `shell:` written in flow style, is refused rather than guessed at.
 *
 * @returns `{ error }` on refusal, otherwise
 *   `{ error: null, lines, eols, index, indent, raw }`, where `raw` is the flow
 *   sequence text (still including its brackets).
 */
export function locateTerminalArgs(text) {
  const { lines, eols } = splitPatchLines(text)
  let row = -1
  let rowIndent = 0
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROW_RE.exec(lines[index])
    if (match !== null) {
      row = index
      rowIndent = match[1].length
      break
    }
  }
  if (row === -1) return { error: NO_ROW_ERROR }

  let end = lines.length
  for (let index = row + 1; index < lines.length; index += 1) {
    const entry = ENTRY_RE.exec(lines[index])
    if (entry !== null && entry[1].length <= rowIndent) {
      end = index
      break
    }
  }

  let shell = -1
  let shellIndent = 0
  for (let index = row + 1; index < end; index += 1) {
    const match = SHELL_RE.exec(lines[index])
    if (match !== null) {
      shell = index
      shellIndent = match[1].length
      break
    }
  }
  if (shell === -1) return { error: NO_SHELL_ERROR }

  const found = []
  for (let index = shell + 1; index < end; index += 1) {
    const match = ARGS_RE.exec(lines[index])
    // A sibling of `shell:` (or anything shallower) is not part of the shell mapping, so
    // only a line nested deeper can be the args this feature owns.
    if (match === null || match[1].length <= shellIndent) continue
    found.push({ index, indent: match[1], raw: match[2] })
  }
  if (found.length === 0) return { error: NO_ARGS_ERROR }
  if (found.length > 1) return { error: AMBIGUOUS_ARGS_ERROR }

  const only = found[0]
  return { error: null, lines, eols, index: only.index, indent: only.indent, raw: only.raw }
}

/**
 * Parse a single-line YAML flow sequence of scalars.
 *
 * This is a reader for the one shape this module writes and for the shape a user
 * writes by hand (`['-e', 'bash', '-l']`, `[ -d, Ubuntu-22.04 ]`, `[ "--cd", "C:\\me" ]`,
 * a trailing comment after the closing bracket). It returns `null` for anything else — a
 * block-style list, a nested sequence, an unbalanced bracket, a double-quoted escape it
 * does not decode — because refusing to touch an unrecognized line is always better than
 * rewriting it wrongly.
 *
 * @returns `{ tokens, tail }` — the scalars, plus any `# comment` that followed the
 *   closing bracket (kept so rewriting the line does not silently delete an
 *   annotation) — or `null` when the text is not a flow sequence.
 */
export function parseFlowSequence(raw) {
  const text = raw.trim()
  if (!text.startsWith('[')) return null
  const tokens = []
  let current = ''
  let quoted = false
  let quote = null
  // A token that carried quotes keeps its content verbatim; padding OUTSIDE those
  // quotes (`[ '-d', … ]`) is dropped, which is why the two cases are tracked apart.
  let quotedToken = false
  let pendingSpace = false
  const push = () => {
    tokens.push(quotedToken ? current : current.trim())
    current = ''
    quotedToken = false
    pendingSpace = false
  }
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (quote === "'" && char === "'" && text[index + 1] === "'") {
        current += "'"
        index += 1
        continue
      }
      if (char === quote) {
        quoted = false
        continue
      }
      if (quote === '"' && char === '\\') {
        // YAML's double-quoted scalars have escapes. `\\` and `\"` are decoded; any other
        // one (`\n`, `\t`, `\uXXXX`, …) is refused rather than silently rewritten,
        // because re-rendering it as a single-quoted scalar would change the value: a
        // hand-written `"--cd", "C:\\Users\\me"` must not come back as two backslashes.
        const escaped = text[index + 1]
        if (escaped === '\\' || escaped === '"') {
          current += escaped
          index += 1
          continue
        }
        return null
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      // Whitespace before a quoted scalar is the sequence's own padding, not content.
      if (!quotedToken) current = ''
      pendingSpace = false
      quote = char
      quoted = true
      quotedToken = true
      continue
    }
    if (char === ']') {
      const tail = text.slice(index + 1).trim()
      if (tail !== '' && !tail.startsWith('#')) return null
      if (quotedToken || current.trim() !== '') push()
      return { tokens, tail }
    }
    if (char === ',') {
      if (quotedToken || current.trim() !== '') push()
      continue
    }
    if (char === ' ' || char === '\t') {
      // Inside a plain scalar this is content (trimmed later); after a quoted scalar it
      // is padding, remembered only in case more content follows in the same scalar.
      if (quotedToken) pendingSpace = true
      else current += char
      continue
    }
    if (pendingSpace) {
      current += ' '
      pendingSpace = false
    }
    current += char
  }
  return null
}

/** Render one token as a single-quoted YAML scalar (a quote inside is doubled). */
function quoteToken(token) {
  return `'${token.split("'").join("''")}'`
}

/**
 * Render the `args:` line, keeping the author's own bracket padding and any trailing
 * comment — this plugin owns one flag on that line, not its formatting.
 */
function renderArgsLine(indent, paddingSource, tail, tokens) {
  if (tokens.length === 0) return `${indent}args: []${tail === '' ? '' : `  ${tail}`}`
  const padded = /^\[[ \t]/.test(paddingSource.trim()) || /[ \t]\]$/.test(paddingSource.trim())
  const body = tokens.map(quoteToken).join(', ')
  const sequence = padded ? `[ ${body} ]` : `[${body}]`
  return `${indent}args: ${sequence}${tail === '' ? '' : `  ${tail}`}`
}

/** The `--cd` value carried by a token list, or `''`. */
function cwdOf(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === CWD_FLAG) return typeof tokens[index + 1] === 'string' ? tokens[index + 1] : ''
    if (tokens[index].startsWith(`${CWD_FLAG}=`)) return tokens[index].slice(CWD_FLAG.length + 1)
  }
  return ''
}

/** The same tokens without any `--cd` flag (and without the value it consumed). */
function withoutCwd(tokens) {
  const kept = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === CWD_FLAG) {
      index += 1
      continue
    }
    if (token.startsWith(`${CWD_FLAG}=`)) continue
    kept.push(token)
  }
  return kept
}

/**
 * Read what the patch currently says.
 *
 * `row` answers "is the terminal row here at all" — the panel needs that separately
 * from the value, because "no row" means the opt-in has not been applied yet, which is
 * a different instruction than "the value is empty".
 *
 * @returns `{ row, path, error }`: `path` is the current `--cd` value (`''` when the
 *   flag is absent), `error` explains a line that could not be read.
 */
export function readTerminalCwd(text) {
  const located = locateTerminalArgs(text)
  if (located.error !== null) {
    // A missing row is not an error for a reader — it is the documented opt-out.
    const missing = located.error === NO_ROW_ERROR
    return { row: !missing, path: '', error: missing ? null : located.error }
  }
  const parsed = parseFlowSequence(located.raw)
  if (parsed === null) return { row: true, path: '', error: SHAPE_ERROR }
  return { row: true, path: cwdOf(parsed.tokens), error: null }
}

/**
 * Return the patch text with `--cd` set to `rawPath` (or removed when it is empty).
 *
 * Pure: the caller decides whether to write. Every refusal returns the input text
 * untouched, so "rejected" can never mean "half-edited".
 *
 * @returns `{ ok, text, path, error }` — `path` is the resulting value on success.
 */
export function writeTerminalCwd(text, rawPath) {
  const wanted = validateTerminalCwd(rawPath)
  if (!wanted.ok) return { ok: false, text, path: '', error: wanted.error }
  const located = locateTerminalArgs(text)
  if (located.error !== null) return { ok: false, text, path: '', error: located.error }
  const parsed = parseFlowSequence(located.raw)
  if (parsed === null) return { ok: false, text, path: '', error: SHAPE_ERROR }

  const next = withoutCwd(parsed.tokens)
  if (wanted.value !== '') {
    // Everything after `-e`/`--exec` is the command line handed to the shell, so the
    // flag goes BEFORE it — appended, it would be read as an argument of `bash`.
    let at = next.length
    for (let index = 0; index < next.length; index += 1) {
      if (EXEC_FLAGS.has(next[index])) {
        at = index
        break
      }
    }
    next.splice(at, 0, CWD_FLAG, wanted.value)
  }

  const lines = located.lines.slice()
  lines[located.index] = renderArgsLine(located.indent, located.raw, parsed.tail, next)
  return { ok: true, text: joinPatchLines(lines, located.eols), path: wanted.value, error: null }
}

/**
 * Check what actually landed on disk, before the caller trusts it.
 *
 * The patch belongs to the user, so the write is only accepted when it is provably the
 * write that was intended: no BOM appeared, the line ending did not change, the line
 * count is identical, exactly ONE line differs, and reading the file back yields the
 * requested directory. Anything else and the caller restores the previous content.
 *
 * @returns an explanation when the write must be undone, `null` when it is good.
 */
export function verifyTerminalRewrite(before, after, expected) {
  if (typeof after !== 'string' || after === '') return '写入后文件是空的'
  if (after.startsWith('\uFEFF')) return '写入后文件开头出现了 BOM'
  const previous = splitPatchLines(before)
  const current = splitPatchLines(after)
  if (previous.lines.length !== current.lines.length) return '写入后行数变了'
  if (previous.eols.join('') !== current.eols.join('')) return '写入后换行符变了'
  let changed = 0
  for (let index = 0; index < previous.lines.length; index += 1) {
    if (previous.lines[index] !== current.lines[index]) changed += 1
  }
  if (changed !== 1) return `写入后改动了 ${changed} 行，应当只改 args 那一行`
  const read = readTerminalCwd(after)
  if (!read.row || read.error !== null) return '写入后读不回那一行 args'
  if (read.path !== expected) return `写入后读回的启动路径是 ${JSON.stringify(read.path)}`
  return null
}

/**
 * Decide what to do with what is on disk after a write.
 *
 * - `ok`       — the write is exactly the one that was intended.
 * - `conflict` — the file is no longer our text: something else wrote to it after us, and
 *                that version is NEWER, so restoring would destroy it. Leave it alone and
 *                say so; the caller must not "fix" somebody else's work.
 * - `undo`     — our own write landed wrong (or could not be read back), so the previous
 *                content is restored from the caller's copy.
 *
 * A conflict is inherently a race and is not reachable from a unit test of the file
 * system; keeping it a pure decision is what makes the rule visible and testable.
 *
 * @returns `{ verdict, error }`; `error` explains a `conflict` or an `undo`.
 */
export function reviewTerminalWrite(previousText, onDiskText, intendedText, expected) {
  if (typeof onDiskText !== 'string' || onDiskText === '') {
    return { verdict: 'undo', error: '写入后读不回 profile patch' }
  }
  if (onDiskText !== intendedText) {
    return { verdict: 'conflict', error: '写入后文件又被其他程序改过，未自动还原，请人工确认' }
  }
  const complaint = verifyTerminalRewrite(previousText, onDiskText, expected)
  if (complaint !== null) return { verdict: 'undo', error: complaint }
  return { verdict: 'ok', error: null }
}
