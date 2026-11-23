// The shell and text half of `wsl-glob`: the platform `glob` tool, pointed at a
// distribution instead of at Windows.
//
// `wsl-grep` answers "which file CONTAINS this", so discovery had no counterpart:
// the model had to compose `find` / `rg --files` through `wsl` and parse the text,
// or glob through the `\\wsl.localhost` 9p share, which is slow and fails on
// root-owned directories. This module owns the other question — "which files are
// here" — the way `fs-ops` owns "what is in this file": the answer is produced
// where the filesystem semantics are real, in a format this side parses without
// guessing where one path ends and the next begins.

import { quotePath, shellQuote } from './paths.js'

// The platform `glob` tool's inline count. Matching it matters: the model already
// knows what a `glob` result costs, and a different-sized answer from the WSL
// version would be a different tool wearing the same name.
export const GLOB_MAX_RESULTS = 100

// The result window, in bytes. It is sized for the CAP rather than for the 100
// returned paths: `total` — how many files the tree actually held — is counted
// from the buffered body, so the body has to hold far more than the answer.
export const GLOB_WINDOW_BYTES = 1 << 20

// Every message the script prints for itself carries this prefix: stderr is shared
// with the launcher, and the tool has to tell its own reason apart from whatever
// `wsl.exe` wrote there.
export const GLOB_ERROR = 'wsl-glob: '

// A refusal from the script, kept out of bash's own 1 (a failed `cd`, which the
// runner prefixes) and 2 (a syntax error). The tool turns any non-zero exit into
// an error, so the number only has to be recognisable in a log.
const GLOB_EXIT = 3

const GLOB_HEADER = 'DSHGLOB '

/**
 * VCS metadata names, and the platform's own exclude list
 * (`GLOB_VCS_EXCLUDES` in `dsh-tool-fs-search`, same six names).
 *
 * Each name is excluded BOTH as an entry and as a directory: a worktree's `.git` is
 * a FILE, and an exclude that covers only a directory's contents still lists the
 * file itself.
 */
const VCS_NAMES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

/** The most find `-name` alternatives a brace pattern may expand into. */
const MAX_FALLBACK_ALTERNATIVES = 64

/**
 * Validate a caller's pattern before anything runs.
 *
 * A NUL cannot travel through argv or a NUL-delimited result list at all, so it is
 * refused here rather than corrupting the record framing later.
 * @param pattern - the caller's glob.
 * @returns the pattern, unchanged.
 */
export function validatePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new Error('wsl-glob: pattern must be a non-empty string')
  }
  if (pattern.includes('\u0000')) {
    throw new Error('wsl-glob: pattern must not contain a NUL byte')
  }
  // A trailing slash names directories, and the answer is files. Both engines would
  // read it differently (rg as a directory glob, find as a literal name), so it is
  // refused rather than allowed to disagree silently.
  if (pattern.endsWith('/')) {
    throw new Error('wsl-glob: pattern must name files, not a directory (no trailing "/")')
  }
  // Unbalanced brackets/braces are an rg error but a literal name to find: one
  // engine fails loudly while the other answers "no files", which is exactly the
  // silent disagreement this tool must not have. A bracket CLASS is skipped as a
  // unit, so `[[]` (a class matching a literal `[`) and `[{]` are valid globs and
  // are not mistaken for an unclosed delimiter.
  const unbalanced = unbalancedGlobDelimiter(pattern)
  if (unbalanced !== null) throw new Error(`wsl-glob: pattern has ${unbalanced}`)
  return pattern
}

/**
 * The first unclosed glob delimiter, or `null` when every `[`/`{` is closed.
 *
 * This is not a bracket count: `[[]` and `[{]` are valid classes for a literal
 * bracket/brace, and a naive count rejects them. Backslash escapes are skipped, and
 * braces inside a class do not open a group.
 * @param pattern - the caller's glob.
 * @returns a human-readable reason, or `null`.
 */
function unbalancedGlobDelimiter(pattern) {
  const braces = []
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '[') {
      let cursor = index + 1
      if (pattern[cursor] === '!' || pattern[cursor] === '^') cursor += 1
      // A `]` immediately after the class opens is a literal member, not its end.
      if (pattern[cursor] === ']') cursor += 1
      while (cursor < pattern.length && pattern[cursor] !== ']') {
        if (pattern[cursor] === '\\') cursor += 1
        cursor += 1
      }
      if (cursor >= pattern.length) return 'an unclosed "["'
      index = cursor
      continue
    }
    if (char === '{') braces.push(index)
    else if (char === '}') {
      if (braces.length === 0) return 'a "}" with no matching "{"'
      braces.pop()
    }
  }
  if (braces.length > 0) return 'an unclosed "{"'
  return null
}

/**
 * The GNU `find` fallback's version of a ripgrep glob, or `null` when the fallback
 * cannot express it.
 *
 * The two engines read globs differently, and the difference is not cosmetic:
 * `rg --glob` reads a glob whose first two characters are `**` and whose third is
 * `/` as "at any depth", while `find -name` matches the same text only against a
 * FILE NAME containing a slash — which cannot exist, so the fallback would answer
 * "no files" and look successful. The fallback therefore accepts only what `-name`
 * really means: that leading depth marker is dropped (`find` already walks every
 * depth), and a remaining separator is refused.
 *
 * `{a,b}` is shorthand `find -name` does not share, so one level of alternation is
 * expanded into one filter per alternative — the same expansion, and the same
 * OR-of-simple-globs meaning, that `fs-ops.expandIncludeGlobs` already gives
 * `wsl-grep`'s GNU `grep` fallback.
 * @param pattern - the caller's glob.
 * @returns one glob per `find -name` filter, or `null` when it is not a basename pattern.
 */
export function fallbackBasenames(pattern) {
  const bare = pattern.startsWith('**/') ? pattern.slice(3) : pattern
  // `!` is negation to rg and a literal first character to `find -name`: the same
  // call would answer differently, so the fallback refuses it instead of guessing.
  if (bare.startsWith('!')) return null
  // The tool rejects a trailing slash already, so an empty `bare` can only mean the
  // pattern was `**/` — likewise refused, for the same reason.
  if (bare === '' || bare.includes('/')) return null
  // A brace pattern is model input: `{a,b}` repeated grows exponentially, and the
  // script is built on THIS side before the distribution ever sees it. The expansion
  // therefore STOPS at the cap instead of building the list first — `{a,b}` twenty
  // times is a million names and tens of megabytes of shell text. The rg branch
  // (which expands braces itself) still accepts the pattern.
  const alternatives = expandAlternatives(bare, MAX_FALLBACK_ALTERNATIVES)
  return alternatives
}

/**
 * One level of `{a,b}` alternation per brace group, expanded until `cap` filters
 * exist. The recursion order is the same OR-of-simple-globs meaning
 * `fs-ops.expandIncludeGlobs` gives `wsl-grep`'s fallback; the difference is that
 * this one refuses instead of growing without bound.
 * @param pattern - the basename pattern.
 * @param cap - the most alternatives the caller accepts.
 * @returns the expanded list, or `null` when it would exceed `cap`.
 */
function expandAlternatives(pattern, cap) {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  const close = pattern.indexOf('}', open)
  if (close === -1) return [pattern]
  const parts = pattern.slice(open + 1, close).split(',')
  if (parts.some((part) => part === '')) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const out = []
  for (const part of parts) {
    const expanded = expandAlternatives(`${prefix}${part}${suffix}`, cap)
    if (expanded === null) return null
    for (const candidate of expanded) {
      out.push(candidate)
      if (out.length > cap) return null
    }
  }
  return out
}

/**
 * The listing script.
 *
 * `rg` is preferred when the distribution has it: its `--files` walk is one
 * process, its `-0` output is NUL-terminated (the one delimiter a path cannot
 * contain), and it skips VCS metadata without a per-directory `-prune` dance.
 * Ubuntu images do not ship it, so the fallback is GNU `find`, which the script
 * probes for because busybox `find` has neither `-printf` nor `%T@`, and a fallback
 * that silently lost the sort would answer in an order the caller did not ask for.
 *
 * Both engines write a NUL-separated body into a temp file, because the container
 * has to be measured before it is printed: `total` must count every file the walk
 * found, not just the ones that fit in the window. The emit is capped by the script
 * itself, one byte PAST the budget, because the transport keeps the TAIL of an
 * overlong stream — an uncapped body that overflowed would lose the `DSHGLOB`
 * header and read as a broken script. The extra byte is what `capped` measures.
 *
 * A non-zero engine status with a body is a PARTIAL success (GNU tools walk past a
 * directory they cannot read), so it is flagged in the header instead of thrown
 * away; the same status with an empty body is a failure, and the engine's own
 * stderr is then the useful part.
 * @param options - the directory (`path`), the caller's glob (`pattern`), and an
 *   optional `maxBytes` body budget (defaults to {@link GLOB_WINDOW_BYTES}).
 * @returns the shell script the runner feeds to `bash -ls`.
 */
export function globScript({ path, pattern, maxBytes }) {
  const budget = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : GLOB_WINDOW_BYTES
  const alternatives = fallbackBasenames(pattern)
  const findBranch = alternatives === null ? fallbackRefusal() : findPipeline(alternatives)
  // GNU find has no end-of-options marker (`find -- -dash` still parses `-dash` as an
  // expression), so a relative path that starts with `-` is made unambiguous before
  // it is quoted. `.`/`..` and absolute paths and `~` are left alone.
  const operand = path.startsWith('-') ? `./${path}` : path
  const rgExcludes = VCS_NAMES
    .flatMap((name) => [`-g ${shellQuote(`!**/${name}`)}`, `-g ${shellQuote(`!**/${name}/**`)}`])
    .join(' ')
  return String.raw`p=${quotePath(operand)}
if [ ! -e "$p" ]; then printf '${GLOB_ERROR}no such file or directory\n' >&2; exit ${GLOB_EXIT}; fi
if [ ! -d "$p" ]; then printf '${GLOB_ERROR}not a directory\n' >&2; exit ${GLOB_EXIT}; fi
body=$(mktemp) || { printf '${GLOB_ERROR}could not create a scratch file\n' >&2; exit ${GLOB_EXIT}; }
err=$(mktemp) || { rm -f -- "$body"; printf '${GLOB_ERROR}could not create a scratch file\n' >&2; exit ${GLOB_EXIT}; }
trap 'rm -f -- "$body" "$err"' EXIT
partial=0
if command -v rg >/dev/null 2>&1; then
  engine=rg
  # --no-ignore/--hidden are the platform glob contract (a VCS-ignored file is
  # still a file); the VCS metadata names are then excluded both as entries and as
  # directories — the platform does the same, and a worktree's .git is a FILE.
  rg --files --sort=modified --no-ignore --hidden -0 \
    -g ${shellQuote(pattern)} \
    ${rgExcludes} \
    -- "$p" > "$body" 2> "$err"
  s=$?
  # rg exits 1 when nothing matched, which is an answer, not an error; 2 means it
  # could not run, and is fatal only when it also produced no bytes.
  if [ "$s" -gt 1 ]; then
    if [ -s "$body" ]; then
      partial=1
    else
      printf '${GLOB_ERROR}the listing failed (exit %s): ' "$s" >&2
      head -c 300 "$err" >&2
      printf '\n' >&2
      exit ${GLOB_EXIT}
    fi
  fi
else
  engine=find
${findBranch}
fi
total=$(tr -cd '\0' < "$body" | wc -c)
size=$(wc -c < "$body")
capped=0
if [ "$size" -gt ${budget} ]; then capped=1; fi
# The header is printed FIRST and unconditionally: it is the only thing that lets
# this side tell an empty listing from a truncated one.
printf '${GLOB_HEADER}%s %s %s %s\n' "$engine" "$total" "$partial" "$capped"
head -c ${budget + 1} -- "$body"
exit 0`
}

/**
 * The find branch when the pattern is not a basename glob: say why, in the terms of
 * the fix (install ripgrep, or narrow `path`), instead of running a walk that would
 * match nothing and report success.
 */
function fallbackRefusal() {
  return String.raw`  printf '${GLOB_ERROR}this distribution has no ripgrep, and the find fallback only supports basename patterns (no "/"); it cannot express "!" negation or more than 64 brace alternatives; install ripgrep (wsl-bootstrap tools recipe) or narrow the pattern\n' >&2
  exit ${GLOB_EXIT}`
}

/**
 * The find fallback: mtime-sorted file paths, NUL-terminated.
 *
 * `-printf '%T@\t%p\0'` puts the timestamp and the path in one record; `sort -z`
 * then orders the whole walk (not one directory at a time, which a per-directory
 * sort would always mean) — ASCENDING, because that is what `rg --sort=modified`
 * does and therefore what the platform `glob` contract means. The two engines must
 * not disagree about which 100 paths a cap keeps, so the order is part of the
 * contract rather than a preference. `cut -z` then drops the timestamp again.
 * A tab, not a space, is the separator because `-printf` has no other delimiter
 * that cannot also be part of a name. (A tab or newline IN a path survives the
 * split: `sort -z`/`cut -z` work on NUL records, not lines. What the tab does
 * affect is only the human-readable one-path-per-line output when such a path is
 * rendered or spilled, which is ambiguous by nature.)
 *
 * `pipefail` is what makes the pipeline's status find's: `sort` and `cut` do not
 * fail on their own, so without it a walk that hit an unreadable directory would
 * be reported as a complete success.
 */
function findPipeline(alternatives) {
  const names = alternatives.map((basename) => `-name ${shellQuote(basename)}`).join(' -o ')
  // Prune the VCS DIRECTORIES, and exclude the same names as FILES: a worktree's
  // `.git` (and `.jj`/`.sl` metadata) can be a regular file, which `-prune` alone
  // does not remove from a `-type f` list.
  const vcsPrune = VCS_NAMES.map((name) => `-name ${shellQuote(name)}`).join(' -o ')
  const vcsFiles = VCS_NAMES.map((name) => `! -name ${shellQuote(name)}`).join(' ')
  return String.raw`  if ! find --version >/dev/null 2>&1; then
    printf '${GLOB_ERROR}the find fallback needs GNU find\n' >&2
    exit ${GLOB_EXIT}
  fi
  set -o pipefail
  # The group owns both redirections: with them on the last stage only, find's
  # "permission denied" would leak onto the shared stderr while $err held nothing,
  # and the failure report would lose the cause.
  { find "$p" \( ${vcsPrune} \) -prune -o -type f \( ${names} \) ${vcsFiles} -printf '%T@\t%p\0' | sort -z -t $'\t' -k1,1n | cut -z -d $'\t' -f2- ; } > "$body" 2> "$err"
  s=$?
  if [ "$s" -ne 0 ]; then
    if [ -s "$body" ]; then
      partial=1
    else
      printf '${GLOB_ERROR}the listing failed (exit %s): ' "$s" >&2
      head -c 300 "$err" >&2
      printf '\n' >&2
      exit ${GLOB_EXIT}
    fi
  fi`
}

/**
 * One script's output as a listing.
 *
 * The header carries what the body cannot: the engine (the two differ in what they
 * promise), `total` (counted inside the distribution, so it is what the tree held
 * rather than what this side received), and the two incompleteness facts — a walk
 * that could not read something, and a body cut by the byte window.
 *
 * A body record is NUL-terminated, so a complete body leaves one empty string after
 * the last path; that is a separator, not a file. A capped body was cut at a byte
 * budget, so a final record with no terminator is half a path and is dropped rather
 * than reported as a name that does not exist. When the cut landed exactly on a
 * terminator, the trailing empty string was the cut mark and every record is whole,
 * so nothing more is lost.
 * @param stdout - the script's standard output.
 * @returns the parsed value, or `null` when the first line is not a header at all
 *   (a launcher failure, or output from a build that predates this tool).
 */
export function parseGlobOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  const newline = text.indexOf('\n')
  if (newline === -1) return null
  const line = text.slice(0, newline)
  if (!line.startsWith(GLOB_HEADER)) return null
  const fields = line.slice(GLOB_HEADER.length).split(' ')
  if (fields.length !== 4) return null
  const [engine, totalText, partialText, cappedText] = fields
  if (engine === '' || !/^\d+$/.test(totalText)) return null
  const body = text.slice(newline + 1)
  const records = body.split('\u0000')
  if (records.length > 0 && records[records.length - 1] === '') records.pop()
  if (cappedText === '1' && body !== '' && !body.endsWith('\u0000') && records.length > 0) {
    records.pop()
  }
  return {
    engine,
    total: Number(totalText),
    partial: partialText === '1',
    capped: cappedText === '1',
    files: records.map(stripDotSlash),
  }
}

/**
 * The model-facing answer.
 *
 * Three shapes, because the caller can act on each differently: "nothing matched"
 * (widen the pattern), a complete list, and a clipped list with the place the rest
 * was put. The clipped footer names the spill file when one exists, and says how to
 * see the rest when it does not — a capped walk and a capped inline count are
 * different losses, so `spillComplete` decides which sentence is true.
 * @param value - the `execute` return value.
 * @returns the text the tool's render wraps in a content block.
 */
export function renderGlob(value) {
  const pattern = typeof value?.pattern === 'string' ? value.pattern : ''
  const path = typeof value?.path === 'string' ? value.path : ''
  const files = Array.isArray(value?.files) ? value.files : []
  const shown = Number.isInteger(value?.shown) ? value.shown : files.length
  const total = Number.isInteger(value?.total) ? value.total : shown
  const partial = value?.partial === true
    ? '\n\n(Some files or directories could not be read, so this result may be incomplete.)'
    : ''
  if (total === 0) return `No files matched ${pattern} under ${path}.${partial}`
  if (value?.truncated !== true) {
    return `Found ${total} ${total === 1 ? 'file' : 'files'}:\n\n${files.join('\n')}${partial}`
  }
  const list = files.length === 0 ? '' : `\n\n${files.join('\n')}`
  const spillPath = typeof value?.spillPath === 'string' && value.spillPath !== '' ? value.spillPath : null
  const footer = spillPath === null
    ? `\n\n(Only the first ${shown} are shown; narrow the pattern to see the rest.)`
    : value?.spillComplete === false
      // The spill holds what the walk produced before the byte window ended, not
      // the whole tree, so it must not be called a complete list. The number is
      // the SAVED record count, which is larger than the inline page whenever the
      // body was capped — naming `shown` here understated the spill.
      ? `\n\n(First ${Number.isInteger(value?.savedCount) ? value.savedCount : shown} paths saved: ${spillPath}; the result was capped — narrow the pattern to see the rest)`
      : `\n\n(Complete list: ${spillPath})`
  return `Found ${shown} of ${total} files${list}${footer}${partial}`
}

/** Paths are reported as the engines printed them, minus the `./` a relative root adds. */
function stripDotSlash(path) {
  return path.startsWith('./') ? path.slice(2) : path
}
