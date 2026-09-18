// Turning one settled subprocess into the value the model sees, plus the
// launcher noise filters and the truncation arithmetic.

// wsl.exe emits this locale-dependent launcher warning to stderr whenever
// Windows has a localhost proxy configured and WSL runs in NAT mode. It
// repeats on every call, so drop it; the tokens "localhost" and "proxy"
// ("代理") stay stable across locales.
const LOCALHOST_PROXY_WARNING = /^\s*wsl:\s.*(localhost|127\.0\.0\.1).*(proxy|代理)/i

// procps (`ps`, `top`, `free`, `w`) probes the console for a window size; a
// redirected wsl.exe stream has no real terminal, so it reports a bogus
// 131072x1 and warns on stderr. Pure noise for every call, so drop it.
const BOGUS_SCREEN_SIZE_WARNING = /^\s*your \d+x\d+ screen size is bogus\.?\s*expect trouble\.?\s*$/i

/** Strip wsl.exe launcher / procps noise lines from stderr. */
export function cleanStderr(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !LOCALHOST_PROXY_WARNING.test(line) && !BOGUS_SCREEN_SIZE_WARNING.test(line))
    .join('\n')
}

// Windows exit codes are unsigned 32-bit; wsl.exe reports its own failures as
// -1, which reaches us as 4294967295. Show the signed value a human expects.
export function normalizeExitCode(exitCode) {
  if (exitCode === 0xFFFFFFFF) return -1
  return exitCode
}

export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * One collected stream -> text plus the truncation facts needed to recover
 * whatever the in-memory tail window dropped.
 *
 * `droppedBytes` is derived from the decoded text and can be off by a byte or
 * two when the byte-trimmed window starts inside a multi-byte character, so the
 * model-facing marker quotes the window SIZE instead of this number.
 */
export function streamFacts(read) {
  if (read === undefined || read === null) {
    return { text: '', totalBytes: 0, droppedBytes: 0, lossy: false, spillPath: null }
  }
  const text = read.text ?? ''
  const totalBytes = typeof read.nextOffset === 'number' ? read.nextOffset : byteLength(text)
  return {
    text,
    totalBytes,
    droppedBytes: read.lossy ? Math.max(0, totalBytes - byteLength(text)) : 0,
    lossy: read.lossy === true,
    spillPath: read.spillPath ?? null,
  }
}

export function truncationMarkers(value, maxOutputBytes) {
  const markers = []
  for (const stream of ['stdout', 'stderr']) {
    const dropped = value[`${stream}DroppedBytes`] ?? 0
    if (dropped <= 0) continue
    const total = value[`${stream}TotalBytes`] ?? 0
    const spill = value[`${stream}SpillPath`]
    const recovery = spill === null || spill === undefined
      ? 'earlier bytes were dropped'
      : `full stream: ${spill}`
    markers.push(`[${stream} truncated: at most the last ${maxOutputBytes} of ${total} bytes were kept; ${recovery}]`)
  }
  return markers.length > 0 ? markers : ['[output truncated]']
}

/**
 * Format one result value as the model-facing text: body first, then one marker
 * per line. An aborted call reports the timeout rather than the exit code the
 * kill produced, since that code is an artifact and not the command's answer.
 */
export function formatResult(value, maxOutputBytes) {
  let body = value.stdout || ''
  if (value.stderr && value.stderr.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${value.stderr}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = []
  if (value.truncated) markers.push(...truncationMarkers(value, maxOutputBytes))
  if (value.timedOut) {
    const after = typeof value.timeoutMs === 'number' ? `${value.timeoutMs}ms` : 'the configured timeout'
    markers.push(`[timed out after ${after}; the command was killed]`)
  } else if (value.signal !== null && value.signal !== undefined) {
    markers.push(`[killed by signal: ${value.signal}]`)
  } else if (value.exitCode !== 0 && value.exitCode !== null) {
    markers.push(`[exit code: ${value.exitCode}]`)
  }
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}
