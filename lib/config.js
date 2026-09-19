// Resolved settings for one mounted plugin instance.
//
// Everything tunable lives here. The numeric knobs are environment-overridable
// so a deployment can tune them without editing this package; an unparsable or
// out-of-range value falls back to the default instead of failing the mount,
// because one bad environment variable must not take all three tools down.

export const DEFAULTS = {
  /** Linux-side directory used when the caller passes no `workdir`. */
  workdir: '~',
  /** Deadline for a model-issued command; `timeoutMs` overrides it per call. */
  commandTimeoutMs: 10 * 60 * 1000,
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
  return {
    ...DEFAULTS,
    // null means "whatever wsl.exe uses by default", which is what makes the
    // package portable: `Ubuntu-22.04` exists on the author's machine, not
    // necessarily on a storefront user's.
    distro: envDistro(env),
    defaultWorkdir: envWorkdir(env),
    maxOutputBytes,
    maxSpillBytes: Math.max(DEFAULTS.maxSpillBytes, maxOutputBytes),
    commandTimeoutMs: envInt(
      env, 'DSH_WSL_TIMEOUT_MS', DEFAULTS.commandTimeoutMs, TIMEOUT_MS_MIN, DEFAULTS.maxTimerDelayMs,
    ),
  }
}
