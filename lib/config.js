// Resolved settings for one mounted plugin instance.
//
// Everything tunable lives here. The numeric knobs are environment-overridable
// so a deployment can tune them without editing this package; an unparsable or
// out-of-range value falls back to the default instead of failing the mount,
// because one bad environment variable must not take all three tools down.

import { windowsPathToWsl } from './paths.js'

export const DEFAULTS = {
  /** Linux-side directory used when the caller passes no `workdir`. */
  workdir: '~',
  /** Deadline for a model-issued command; `timeoutMs` overrides it per call. */
  commandTimeoutMs: 10 * 60 * 1000,
  /** Ceiling for a per-call `timeoutMs`, mirroring the platform shell tools'
   *  `maxTimeoutMs`: a slip of the keyboard must not mean "never time out". */
  maxCommandTimeoutMs: 24 * 60 * 60 * 1000,
  /** Hard ceiling for the plugin's OWN probes (`wsl -l -v`, `wslpath`, `wsl-env`). */
  internalTimeoutMs: 30 * 1000,
  /** Grace period handed to the provider's termination procedure. */
  graceMs: 3000,
  /** Per-stream in-memory output window; overflow keeps the tail. */
  maxOutputBytes: 64 * 1024,
  /** Per-stream spill-file cap; a larger stream loses its complete-stream file. */
  maxSpillBytes: 64 * 1024 * 1024,
  /** Windows caps a whole command line at 32767 chars; above this the script
   *  is fed to `bash -ls` on stdin instead. */
  maxCommandChars: 30_000,
  /** `setTimeout` stores its delay in a signed 32-bit int; larger fires at once. */
  maxTimerDelayMs: 2 ** 31 - 1,
}

/**
 * Host shell facts forwarded into the Linux side.
 *
 * WSL does not pass Windows environment variables into a distribution (that is
 * what `WSLENV` is for), so without this the Linux side sees none of the facts
 * the platform's own shell tools inject, and a script reading `$DSH_SESSION_ID`
 * silently gets nothing.
 *
 * `DSH_WEB_URL` is deliberately NOT forwarded: it is a `127.0.0.1` URL for the
 * Windows-side server, and in the default NAT networking mode WSL cannot reach
 * Windows loopback (measured: HTTP 000 both on `127.0.0.1` and on the host IP,
 * which the server does not bind either). Forwarding it would hand out a URL
 * that cannot be opened. `DSH_HOME` is a Windows path, so it is translated to
 * the same directory's `/mnt/...` view.
 */
const FORWARDED_ENV_KEYS = ['DSH_SESSION_ID', 'DSH_SHELL', 'DSH_HOME']

function envForwards(env) {
  const forwards = {}
  for (const key of FORWARDED_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value !== '') forwards[key] = value
  }
  if (forwards.DSH_HOME !== undefined) forwards.DSH_HOME = windowsPathToWsl(forwards.DSH_HOME)
  return forwards
}

// Bounds for the environment-overridable knobs, so a typo cannot silently
// produce an absurd window or a deadline that fires instantly.
const OUTPUT_BYTES_MIN = 1024
const OUTPUT_BYTES_MAX = 8 * 1024 * 1024
const TIMEOUT_MS_MIN = 100

const ENV_INT_RE = /^\d+$/

function envInt(env, name, fallback, min, max) {
  const raw = env[name]
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  if (!ENV_INT_RE.test(trimmed)) return fallback
  const value = Number(trimmed)
  return value >= min && value <= max ? value : fallback
}

/** @returns a distribution name to pin, or null to use the system default. */
function envDistro(env) {
  const raw = env.DSH_WSL_DISTRO
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

/**
 * Where a call starts when the caller passes no `workdir`.
 *
 * `home` (the default) keeps the documented `~`. `session` starts in the
 * session's working directory — the plugin's own process cwd, the same source
 * `dsh-pwsh-local` uses by default — which is what an agent working on a
 * Windows checkout usually wants, since its files live at `/mnt/<drive>/...`
 * rather than in the Linux home. Anything else is an explicit default path.
 *
 * @returns a path, or null meaning "the process working directory".
 */
function envWorkdir(env) {
  const raw = env.DSH_WSL_WORKDIR
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULTS.workdir
  const value = raw.trim()
  if (value === 'home') return DEFAULTS.workdir
  if (value === 'session') return null
  return value
}

/**
 * Resolve the effective configuration for one mount.
 *
 * `DSH_WSL_MAX_OUTPUT_BYTES` also raises the spill ceiling when needed, since a
 * spill file smaller than the in-memory window could never hold the complete
 * stream and would be discarded exactly when it is most useful.
 *
 * @param env - environment to read (injectable for tests).
 */
export function resolveConfig(env = process.env) {
  const maxOutputBytes = envInt(
    env, 'DSH_WSL_MAX_OUTPUT_BYTES', DEFAULTS.maxOutputBytes, OUTPUT_BYTES_MIN, OUTPUT_BYTES_MAX,
  )
  const maxCommandTimeoutMs = envInt(
    env, 'DSH_WSL_MAX_TIMEOUT_MS', DEFAULTS.maxCommandTimeoutMs, TIMEOUT_MS_MIN, DEFAULTS.maxTimerDelayMs,
  )
  return {
    ...DEFAULTS,
    // null means "whatever wsl.exe uses by default", which is what makes the
    // package portable: `Ubuntu-22.04` exists on the author's machine, not
    // necessarily on a storefront user's.
    distro: envDistro(env),
    defaultWorkdir: envWorkdir(env),
    forwardEnv: envForwards(env),
    maxOutputBytes,
    maxSpillBytes: Math.max(DEFAULTS.maxSpillBytes, maxOutputBytes),
    maxCommandTimeoutMs,
    // The default deadline obeys the cap too, so the two knobs cannot disagree.
    commandTimeoutMs: Math.min(
      envInt(env, 'DSH_WSL_TIMEOUT_MS', DEFAULTS.commandTimeoutMs, TIMEOUT_MS_MIN, DEFAULTS.maxTimerDelayMs),
      maxCommandTimeoutMs,
    ),
  }
}
