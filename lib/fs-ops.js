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
  PERMISSION: 10,
  // The script could not even set up its own scratch files (a full /tmp). It has
  // to be a real number: `exit ${FS_EXIT.INTERNAL}` with a missing entry makes
  // bash print "numeric argument required" and exit 2, which reads like a
  // search failure.
  INTERNAL: 11,
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
 *
 * `maxBytes` (when given) makes the script cap its own body one byte PAST the
 * budget, so the caller can tell "the file ends here" from "the window ended
 * here" without relying on the transport's truncation — that truncation keeps the
 * TAIL of a stream, so a read that overflowed it lost the header line and looked
 * like a broken script. The extra byte is what the caller measures.
 * @param path - the file to read.
 * @param from - 1-based first line.
 * @param to - 1-based last line.
 * @param [options] - `maxBytes` caps the emitted body to `maxBytes + 1` bytes.
 * @returns the shell script.
 */
export function readScript(path, from, to, { maxBytes } = {}) {
  const budget = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes + 1 : 0
  const body = budget === 0
    ? String.raw`if command -v iconv >/dev/null 2>&1; then
  sed -n '${from},${to}p' -- "$p" | iconv -f UTF-8 -t UTF-8 || exit ${FS_EXIT.ENCODING}
else
  sed -n '${from},${to}p' -- "$p"
fi`
    : String.raw`raw=$(mktemp) || exit ${FS_EXIT.INTERNAL}
decoded=''
trap 'rm -f -- "$raw" "$decoded"' EXIT
sed -n '${from},${to}p' -- "$p" > "$raw" || exit ${FS_EXIT.ENCODING}
if command -v iconv >/dev/null 2>&1; then
  decoded=$(mktemp) || exit ${FS_EXIT.INTERNAL}
  iconv -f UTF-8 -t UTF-8 < "$raw" > "$decoded" || exit ${FS_EXIT.ENCODING}
  head -c ${budget} -- "$decoded"
else
  head -c ${budget} -- "$raw"
fi
rm -f -- "$raw" "$decoded"
trap - EXIT`
  return String.raw`p=${quotePath(path)}
if [ -d "$p" ]; then printf '${FS_ERROR} is a directory\n' >&2; exit ${FS_EXIT.IS_DIR}; fi
if [ ! -e "$p" ]; then printf '${FS_ERROR} no such file or directory\n' >&2; exit ${FS_EXIT.MISSING}; fi
if [ ! -f "$p" ]; then printf '${FS_ERROR} is not a regular file\n' >&2; exit ${FS_EXIT.NOT_FILE}; fi
# Asked before the header, because the header's byte count comes from reading the
# file: an unreadable file would otherwise print a size of 0 and be reported as
# an empty file, which is the one answer a caller cannot tell from the truth.
if [ ! -r "$p" ]; then printf '${FS_ERROR} permission denied\n' >&2; exit ${FS_EXIT.PERMISSION}; fi
printf '${FS_HEADER} %s %s\n' "$(wc -c < "$p" | tr -d ' ')" "$(awk 'END { print NR }' "$p")"
${body}`
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
 *
 * `keepOwner` copies the owner as well, and only a root call asks for it: the
 * temporary belongs to the process that made it, so an edit run as root would
 * otherwise leave a root-owned file where a user-owned one used to be. It is
 * off by default because `chown` cannot succeed without privilege, and a call
 * that cannot change an owner should not look like it tried. A NEW file created
 * by a root call takes the directory's owner instead of root's: a file handed to
 * root inside the user's own tree is one the user can no longer edit, which is
 * the same unrequested change one attribute over.
 *
 * Only a regular file is replaced. The rename would otherwise silently turn a
 * FIFO, socket or device node into a regular file — a running service's socket,
 * or `/dev/null` in a root call.
 */
export function writeScript(path, { keepOwner = false } = {}) {
  const owner = keepOwner
    ? String.raw`if [ "$had" = 1 ]; then
  if chown --reference="$p" -- "$t" 2>/dev/null; then :;
  else o=$(stat -c %u:%g -- "$p" 2>/dev/null) || o=; [ -n "$o" ] && chown "$o" -- "$t" 2>/dev/null || :; fi
else
  o=$(stat -c %u:%g -- "$d" 2>/dev/null) || o=; [ -n "$o" ] && chown "$o" -- "$t" 2>/dev/null || :
fi
`
    : ''
  return String.raw`p=${quotePath(path)}
if [ -d "$p" ]; then printf '${FS_ERROR} is a directory\n' >&2; exit ${FS_EXIT.IS_DIR}; fi
# A write through a symlink changes the link's TARGET, not the link: renaming over
# the link itself would replace it with a regular file and leave the target
# untouched. readlink -f resolves first; GNU coreutils and busybox both provide it.
if [ -L "$p" ]; then
  q=$(readlink -f -- "$p" 2>/dev/null) || q=
  if [ -n "$q" ]; then p=$q; else printf '${FS_ERROR} the symlink target could not be resolved\n' >&2; exit ${FS_EXIT.WRITE}; fi
fi
# A FIFO, socket or device node is not a file to replace: the rename would turn it
# into a regular file (a live socket stops working; /dev/null becomes a text file).
if [ -e "$p" ] && [ ! -f "$p" ]; then printf '${FS_ERROR} is not a regular file\n' >&2; exit ${FS_EXIT.NOT_FILE}; fi
had=0; [ -e "$p" ] && had=1
d=$(dirname -- "$p") || exit ${FS_EXIT.PATH}
b=$(basename -- "$p") || exit ${FS_EXIT.PATH}
mkdir -p -- "$d" || exit ${FS_EXIT.WRITE}
t=$(mktemp -- "$d/.$b.XXXXXX") || exit ${FS_EXIT.WRITE}
trap 'rm -f -- "$t"' EXIT
cat > "$t" || exit ${FS_EXIT.WRITE}
if [ "$had" = 1 ]; then
  # Keep the mode without assuming GNU chmod: busybox has no --reference, and a
  # 0600 temporary would silently turn a 755 script unexecutable.
  if chmod --reference="$p" -- "$t" 2>/dev/null; then :;
  else
    m=$(stat -c %a -- "$p" 2>/dev/null) || m=
    if [ -n "$m" ] && chmod "$m" -- "$t" 2>/dev/null; then :;
    else printf '${FS_ERROR} could not keep the mode of %s\n' "$p" >&2; exit ${FS_EXIT.WRITE}; fi
  fi
else
  chmod 644 -- "$t" 2>/dev/null || :
fi
${owner}mv -f -- "$t" "$p" || exit ${FS_EXIT.WRITE}
trap - EXIT
printf '${FS_HEADER} %s %s\n' "$had" "$(readlink -f -- "$p" 2>/dev/null || printf '%s' "$p")"`
}

/**
 * Rewrite the one ripgrep escape GNU `grep -E` does not share.
 *
 * POSIX ERE has no `\d`: GNU grep parses it as a literal `d`, so `\d+` matches
 * "ddd" and misses "123" — an exit-0 answer that is silently wrong, which is
 * worse than an error. `\w`, `\s` and `\b` are GNU extensions and mean the same
 * thing in both engines, so they are left alone. Inside a bracket expression the
 * translation is `0-9` (no nested brackets); `\D` inside one stays untranslated,
 * which is documented rather than guessed at.
 * @param pattern - the ripgrep-syntax pattern.
 * @returns the pattern the GNU grep fallback can run with the same meaning.
 */
export function grepFallbackPattern(pattern) {
  let out = ''
  let inClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\') {
      const next = pattern[index + 1]
      if (next === undefined) {
        out += '\\'
        continue
      }
      if (next === 'd') {
        out += inClass ? '0-9' : '[0-9]'
        index += 1
        continue
      }
      if (next === 'D' && !inClass) {
        out += '[^0-9]'
        index += 1
        continue
      }
      // Any other escape means the same to both engines (\\, \., \w, \s, \b, …).
      out += char + next
      index += 1
      continue
    }
    if (char === '[' && !inClass) {
      inClass = true
      out += char
      // A `^` or a leading `]` belongs to the class, not to its terminator.
      if (pattern[index + 1] === '^') {
        out += '^'
        index += 1
      }
      if (pattern[index + 1] === ']') {
        out += ']'
        index += 1
      }
      continue
    }
    if (char === ']' && inClass) {
      inClass = false
      out += char
      continue
    }
    out += char
  }
  return out
}

/**
 * One `include` glob as the list of simple filters both engines understand.
 *
 * `{a,b}` is shorthand ripgrep expands and GNU grep does not: passed through, grep
 * matches no file at all and the search comes back empty — a silently wrong answer.
 * Splitting it into `a` and `b` and passing each as its own filter gives both
 * engines the same OR of simple globs.
 * @param include - the caller's glob, or `undefined`.
 * @returns the expanded globs (empty when there is no filter).
 */
export function expandIncludeGlobs(include) {
  if (include === undefined || include === '') return []
  const open = include.indexOf('{')
  if (open === -1) return [include]
  const close = include.indexOf('}', open)
  if (close === -1) return [include]
  const prefix = include.slice(0, open)
  const suffix = include.slice(close + 1)
  const parts = include.slice(open + 1, close).split(',')
  if (parts.some((part) => part === '')) return [include]
  return parts.flatMap((part) => expandIncludeGlobs(`${prefix}${part}${suffix}`))
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
 *
 * The body is buffered before it is printed, because GNU grep exits 2 as soon as
 * one file it walked could not be read — an unreadable `sudoers.d` entry, a socket
 * under `/tmp` — while still having found everything in the files it could read.
 * Both tools also write a partial body before a fatal error. Deciding on the
 * buffered size separates the two cases: a non-zero status with matches is a
 * complete answer, and the same status with an empty body is the error, whose
 * text is then the useful part.
 *
 * `include` may use one level of `{a,b}` alternation, which is SHORT-HAND and not
 * a glob both engines share: `rg --glob` expands it, GNU `grep --include` takes it
 * literally and then matches nothing. The alternation is expanded here into one
 * filter per alternative (both engines treat repeated filters as OR), so the same
 * search finds the same files on both.
 *
 * `maxBytes` caps the emitted body one byte PAST the budget, like `readScript`:
 * the transport keeps the TAIL of an overlong stream, so an uncapped body that
 * overflowed lost the `DSHFS` header and the search failed with "no header line"
 * instead of returning its first matches. The header also carries `partial` (some
 * files could not be read while the matches that were found are still complete).
 * @param options - `path`, `pattern` (ripgrep syntax), an optional `include` glob, and `maxBytes`.
 * @returns the shell script.
 */
export function grepScript({ path, pattern, include, maxBytes }) {
  const globs = expandIncludeGlobs(include)
  const rgInclude = globs.map((glob) => ` --glob=${quotePath(glob)}`).join('')
  const grepInclude = globs.map((glob) => ` --include=${quotePath(glob)}`).join('')
  // The fallback runs the translated pattern (see {@link grepFallbackPattern}):
  // `\d` is the one rg escape GNU grep reads as a literal letter.
  const grepPattern = grepFallbackPattern(pattern)
  const budget = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes + 1 : 0
  const emit = budget === 0 ? 'cat -- "$body"' : `head -c ${budget} -- "$body"`
  return String.raw`p=${quotePath(path)}
if [ ! -e "$p" ]; then printf '${FS_ERROR} no such file or directory\n' >&2; exit ${FS_EXIT.MISSING}; fi
body=$(mktemp) || exit ${FS_EXIT.INTERNAL}
err=$(mktemp) || { rm -f "$body"; exit ${FS_EXIT.INTERNAL}; }
trap 'rm -f "$body" "$err"' EXIT
if command -v rg >/dev/null 2>&1; then
  engine=rg
  rg --json --regexp=${quotePath(pattern)}${rgInclude} -- "$p" > "$body" 2> "$err"
else
  engine=grep
  grep -r -n -I -H -Z -E -e ${quotePath(grepPattern)}${grepInclude} -- "$p" > "$body" 2> "$err"
fi
s=$?
if [ "$s" -gt 1 ] && [ ! -s "$body" ]; then
  printf '${FS_ERROR} the search failed (exit %s): ' "$s" >&2
  head -c 300 "$err" >&2
  printf '\n' >&2
  exit ${FS_EXIT.SEARCH}
fi
# A non-zero status WITH a body means some files could not be read and the rest
# were searched: say so instead of presenting the partial answer as complete.
partial=0
if [ "$s" -ne 0 ] && [ -s "$err" ]; then partial=1; fi
printf '${FS_HEADER} %s %s\n' "$engine" "$partial"
${emit}
exit 0`
}

/**
 * Cut text to a byte budget on a UTF-8 boundary.
 *
 * The read window is a byte budget, and a script that caps its own output can cut
 * a multi-byte character in half; a decoder would then end the text with U+FFFD,
 * which reads like a corrupt file rather than a capped window.
 * @param text - the text to cut.
 * @param maxBytes - the budget, in UTF-8 bytes.
 * @returns the text (unchanged when it fits) and whether it was cut.
 */
export function cutUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, capped: false }
  let buffer = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  for (let attempt = 0; attempt < 4 && buffer.length > 0; attempt += 1) {
    const decoded = buffer.toString('utf8')
    if (!decoded.endsWith('\ufffd')) return { text: decoded, capped: true }
    buffer = buffer.subarray(0, buffer.length - 1)
  }
  return { text: buffer.toString('utf8'), capped: true }
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
    case FS_EXIT.PERMISSION: return 'permission denied'
    case FS_EXIT.INTERNAL: return 'the script could not create its scratch files'
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
