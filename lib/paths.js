// Shell quoting and Windows -> WSL path translation.
//
// Both concerns are "turn caller text into something bash and wsl.exe read the
// same way", and every rule here exists because the naive version was wrong:
// see the comments on each pattern.

// Shell-quote a value for a single-quoted `export KEY='value'` fragment.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// `~` must stay OUTSIDE the quotes or bash never expands it, so a `~`-rooted
// path is split: the tilde stays bare and only the remainder is quoted.
// `~/my dir` -> `~/'my dir'`; anything else is quoted whole. A path that is
// literally named `~foo` therefore cannot be expressed — acceptable, and the
// safe direction: an unexpanded tilde fails loudly instead of silently.
const TILDE_PATH_RE = /^(~[A-Za-z0-9._-]*)((?:\/.*)?)$/

export function quotePath(path) {
  const match = TILDE_PATH_RE.exec(path)
  if (match === null) return shellQuote(path)
  const [, tilde, rest] = match
  return rest.length <= 1 ? tilde : `${tilde}/${shellQuote(rest.slice(1))}`
}

export function buildCdCommand(workdir) {
  return `cd ${quotePath(workdir)}`
}

// Characters that may appear inside a Windows path segment but cannot be part
// of one: whitespace ends the segment, and a shell operator ends the token.
// Parentheses are deliberately ALLOWED — `C:\Program Files (x86)\Steam` is an
// ordinary Windows path, and a trailing `$(...)` is harmless because a
// continuation chunk only ever changes if it contains a backslash.
const PATH_CHAR = `[^\\s"'` + '`' + `|&;<>]`

// One Windows drive-absolute path: `C:\foo`, `C:/foo`, and — the case the
// first version got wrong — a path whose LATER segments contain spaces, e.g.
// `C:\Program Files\Git` or `C:\Program Files (x86)\Steam`.
//
// A space continues the match only when the next chunk does NOT itself start a
// new drive path, so `cp C:\a.txt D:\b.txt` translates BOTH paths instead of
// letting ` D:\b.txt` be absorbed into the first. An unconsumed chunk is left
// verbatim, so `C:\Program Files` (no backslash after the space) still becomes
// `/mnt/c/Program Files`, and `echo C:\x && ls` still stops at the `&&`.
//
// The lookbehind replaces the first version's `\b`: a drive letter preceded by
// `/`, `\` or `:` is not a drive path but path-like TEXT inside another
// expression — `sed "s/C:\x/y/"` and `http://x/C:/y` must be left alone.
const DRIVE_PATH_RE = new RegExp(
  `(?<![\\w/\\\\:])([A-Za-z]):([\\\\/])(${PATH_CHAR}*(?:[ \\t]+(?![A-Za-z]:[\\\\/])${PATH_CHAR}*)*)`,
  'g',
)

// Windows reaches a WSL filesystem as a UNC path: `\\wsl.localhost\<distro>\home\x`
// or the legacy `\\wsl$\<distro>\home\x`. Inside a Linux command both mean the
// Linux path, so translate them too.
const WSL_UNC_RE = new RegExp(
  `\\\\\\\\wsl(?:\\.localhost|\\$)(?:\\\\+([^\\\\/\\s"'` + '`' + `|&;<>()]+))?((?:[\\\\/]${PATH_CHAR}*)*)`,
  'g',
)

/**
 * Translate literal Windows paths into their WSL/Linux form.
 *   C:\Users\me\a.txt            -> /mnt/c/Users/me/a.txt
 *   C:\Program Files\Git\cmd     -> /mnt/c/Program Files/Git/cmd
 *   \\wsl.localhost\Ubuntu\home  -> /home
 * A single lowercase letter followed by `/` is NOT rewritten: `a:/b` is
 * ordinary text far more often than it is a drive path, and the backslash form
 * (`a:\b`, or an uppercase `C:/...`) still is.
 */
export function windowsPathToWsl(text) {
  if (typeof text !== 'string' || text.length === 0) return text

  const withDrives = text.replace(DRIVE_PATH_RE, (match, letter, separator, rest) => {
    if (separator === '/' && letter !== letter.toUpperCase()) return match
    const tail = rest.replace(/\\/g, '/')
    return `/mnt/${letter.toLowerCase()}/${tail}`.replace(/\/{2,}/g, '/')
  })

  return withDrives.replace(WSL_UNC_RE, (_match, _distro, tail) => {
    const path = String(tail ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    return path.startsWith('/') ? path : `/${path}`
  })
}
