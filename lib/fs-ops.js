// The shell half of the file tools: `wsl-read`, `wsl-write` and `wsl-edit`.
//
// All three reach a distribution's filesystem through the same runner as `wsl`,
// so they inherit the launcher's argv/stdin handling instead of adding a second
// transport. What they cannot inherit is file semantics: `wsl` runs whatever
// string it is given, while "read a file" has to mean one thing for text,
// another for a directory, and something loud for a binary or for a file that
// vanished between two calls.
//
// So the questions are asked where the answers are real — inside the
// distribution, where `~` and symlinks resolve and where the file type and the
// byte count are facts rather than guesses. Each script below answers exactly
// one question, either with its payload or with the reason it could not, and
// the exit codes are part of that contract: the tools turn them into messages,
// so a missing file never reads like a permission failure.

import { quotePath } from './paths.js'

// Every payload is prefixed with one line of facts. The parser takes only the
// FIRST line of the output, so a file whose first line happens to look like a
// header cannot be mistaken for one.
export const FS_HEADER = 'DSHFS'

// The scripts tag their own failure reasons with this, because stderr is shared
// with the launcher: `wsl.exe` writes its own warnings there (`检测到 localhost
// 代理配置…`, which the runner filters but another host may not), and a message
// that picked whatever line came first would report the wrong cause.
export const FS_ERROR = 'DSHFS-ERR'

// Chosen so that "the caller asked for the wrong thing" is distinguishable from
// "the shell could not do it". 1 is deliberately unused: bash itself reports a
// failed `cd` with 1, and the runner prefixes every script with one.
export const FS_EXIT = Object.freeze({
  PATH: 3,
  MISSING: 4,
  IS_DIR: 5,
  NOT_FILE: 6,
  WRITE: 7,
  SEARCH: 8,
  ENCODING: 9,
})

/**
 * Facts about one file plus the requested slice of its lines.
 *
 * `awk 'END { print NR }'` rather than `wc -l`: a file whose last line has no
 * trailing newline is one line to a reader and zero to `wc -l`, and a read of
 * line 1 that came back empty would look like an empty file.
 *
 * `iconv` is asked to re-decode what `sed` produced. For valid UTF-8 that is a
 * no-op; for anything else it fails, which is the difference between "this file
 * is not text" and a page of replacement characters that a model would then try
 * to edit. It is skipped where the distribution has no `iconv` (busybox), and
 * the read then behaves like any other UTF-8 consumer.
 */
export function readScript(path, from, to) {
  return String.raw`p=${quotePath(path)}
if [ -d "$p" ]; then printf '${FS_ERROR} is a directory\n' >&2; exit ${FS_EXIT.IS_DIR}; fi
if [ ! -e "$p" ]; then printf '${FS_ERROR} no such file or directory\n' >&2; exit ${FS_EXIT.MISSING}; fi
if [ ! -f "$p" ]; then printf '${FS_ERROR} is not a regular file\n' >&2; exit ${FS_EXIT.NOT_FILE}; fi
printf '${FS_HEADER} %s %s\n' "$(wc -c < "$p" | tr -d ' ')" "$(awk 'END { print NR }' "$p")"
if command -v iconv >/dev/null 2>&1; then
  sed -n '${from},${to}p' -- "$p" | iconv -f UTF-8 -t UTF-8 || exit ${FS_EXIT.ENCODING}
else
  sed -n '${from},${to}p' -- "$p"
fi`
}

/**
 * Replace a file's contents in one step.
 *
 * The bytes go to a temporary sibling and are renamed over the target, so a
 * failed write never leaves a half-written file where a complete one used to
 * be. The temporary lives in the SAME directory because `mv` is only atomic
 * within one filesystem, and the trap removes it on any failure — including the
 * ones that end the script with `exit`.
 *
 * The previous file's mode is copied onto the replacement: `mktemp` creates
 * 0600, and a write that silently tightened a script's permissions would be a
 * change nobody asked for. A new file gets 0644 and the process umask does not
 * apply, because the temporary already exists by then.
 */
export function writeScript(path) {
  return String.raw`p=${quotePath(path)}
if [ -d "$p" ]; then printf '${FS_ERROR} is a directory\n' >&2; exit ${FS_EXIT.IS_DIR}; fi
had=0; [ -e "$p" ] && had=1
d=$(dirname -- "$p") || exit ${FS_EXIT.PATH}
b=$(basename -- "$p") || exit ${FS_EXIT.PATH}
mkdir -p -- "$d" || exit ${FS_EXIT.WRITE}
t=$(mktemp -- "$d/.$b.XXXXXX") || exit ${FS_EXIT.WRITE}
trap 'rm -f -- "$t"' EXIT
cat > "$t" || exit ${FS_EXIT.WRITE}
if [ "$had" = 1 ]; then chmod --reference="$p" -- "$t" 2>/dev/null || :; else chmod 644 -- "$t" 2>/dev/null || :; fi
mv -f -- "$t" "$p" || exit ${FS_EXIT.WRITE}
trap - EXIT
printf '${FS_HEADER} %s %s\n' "$had" "$(readlink -f -- "$p" 2>/dev/null || printf '%s' "$p")"`
}

/**
 * Search a tree with the engine the distribution actually has.
 *
 * `rg` is preferred when it is installed: it honours `.gitignore`, skips binary
 * files without being told, and reports one JSON object per match, which parses
 * without guessing where a file name ends and a line number begins. Ubuntu
 * images do not ship it, so the fallback is GNU `grep -E`, whose `-Z` output
 * separates the file name with a NUL byte — the one delimiter a path cannot
 * contain — and whose exit status means the same thing (0 matched, 1 found
 * nothing, 2 could not run). `-H` is asked for because grep drops the file name
 * when the target is one explicit file, and a body that sometimes starts with a
 * path and sometimes with a line number is two formats, not one.
 *
 * The engine is announced on the header line so the caller parses the body it
 * actually got instead of the one this comment promised.
 */
export function grepScript({ path, pattern, include }) {
  const rgInclude = include === undefined ? '' : ` --glob=${quotePath(include)}`
  const grepInclude = include === undefined ? '' : ` --include=${quotePath(include)}`
  return String.raw`p=${quotePath(path)}
if [ ! -e "$p" ]; then printf '${FS_ERROR} no such file or directory\n' >&2; exit ${FS_EXIT.MISSING}; fi
if command -v rg >/dev/null 2>&1; then
  printf '${FS_HEADER} rg\n'
  rg --json --regexp=${quotePath(pattern)}${rgInclude} -- "$p"
else
  printf '${FS_HEADER} grep\n'
  grep -r -n -I -H -Z -E -e ${quotePath(pattern)}${grepInclude} -- "$p"
fi
s=$?
case "$s" in 0|1) exit 0;; *) printf '${FS_ERROR} the search failed (exit %s)\n' "$s" >&2; exit ${FS_EXIT.SEARCH};; esac`
}

/** Split the first output line into its facts, or `null` if it is not one. */
export function parseHeader(stdout) {
  const index = stdout.indexOf('\n')
  const line = index === -1 ? stdout : stdout.slice(0, index)
  const prefix = `${FS_HEADER} `
  if (!line.startsWith(prefix)) return null
  return {
    fields: line.slice(prefix.length).split(' '),
    body: index === -1 ? '' : stdout.slice(index + 1),
  }
}

/**
 * One `rg --json` stream as matches.
 *
 * Every line is a standalone JSON object; only `match` events carry a result.
 * A path or line that is not valid UTF-8 arrives base64-encoded in a `bytes`
 * field instead of `text`, and is decoded rather than dropped — a search that
 * silently skipped a Latin-1 file would be worse than one that showed it.
 */
export function parseRgJson(body) {
  const matches = []
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'match') continue
    const file = decodeField(event.data?.path)
    const text = decodeField(event.data?.lines)
    const number = Number(event.data?.line_number)
    if (file === null || text === null || !Number.isInteger(number)) continue
    matches.push({ file, line: number, text: stripNewline(text) })
  }
  return matches
}

/**
 * One `grep -Z` stream as matches: `file\0line:text`, one per line.
 *
 * Splitting on the first NUL and then the first colon is unambiguous because a
 * path cannot contain a NUL — which is exactly why `-Z` is asked for instead of
 * parsing the `file:line:text` form, where a colon in the path is common.
 */
export function parseGrepZ(body) {
  const matches = []
  for (const line of body.split('\n')) {
    const nul = line.indexOf('\u0000')
    if (nul === -1) continue
    const rest = line.slice(nul + 1)
    const colon = rest.indexOf(':')
    if (colon === -1) continue
    const number = Number(rest.slice(0, colon))
    if (!Number.isInteger(number)) continue
    matches.push({ file: line.slice(0, nul), line: number, text: rest.slice(colon + 1) })
  }
  return matches
}

/**
 * Cut one matched line down to a preview, on a UTF-8 boundary.
 *
 * One minified line can be megabytes, and the platform's `grep` caps its
 * previews the same way: what comes back is enough to recognise the match, and
 * the file is one `wsl-read` away when the rest is needed.
 */
export function previewLine(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let cut = text.slice(0, maxBytes)
  while (Buffer.byteLength(cut, 'utf8') > maxBytes) cut = cut.slice(0, -1)
  return `${cut}…`
}

function decodeField(field) {
  if (typeof field?.text === 'string') return field.text
  if (typeof field?.bytes === 'string') return Buffer.from(field.bytes, 'base64').toString('utf8')
  return null
}

function stripNewline(text) {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/**
 * The one line worth showing a caller when a script did not finish.
 *
 * The scripts print their own reason, so it is preferred; the code map is the
 * fallback for the cases where bash died before printing one (a `cd` into a
 * directory that does not exist, a killed child).
 */
export function reasonOf(result) {
  const lines = String(result.stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const tagged = lines.find((line) => line.startsWith(`${FS_ERROR} `))
  if (tagged !== undefined) return tagged.slice(FS_ERROR.length + 1)
  // Untagged: bash's own message for the cases the script never reached
  // (`cd: no such file or directory`, `mkdir: Permission denied`).
  if (lines.length > 0) return lines[0]
  switch (result.exitCode) {
    case FS_EXIT.PATH: return 'the path could not be split into a directory and a name'
    case FS_EXIT.MISSING: return 'no such file or directory'
    case FS_EXIT.IS_DIR: return 'is a directory'
    case FS_EXIT.NOT_FILE: return 'is not a regular file'
    case FS_EXIT.WRITE: return 'the write failed'
    case FS_EXIT.ENCODING: return 'not valid UTF-8 text'
    default: return `exit code ${result.exitCode}`
  }
}

/** Bytes as a short human-scale figure, for the rendered one-liner. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** Count the lines in a slice, honouring a final line with no newline. */
export function countLines(text) {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}
