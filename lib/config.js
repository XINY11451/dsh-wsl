// Resolved settings for one mounted plugin instance.
//
// Everything tunable lives here, and it is resolved from three layers, most
// specific first:
//
//   1. the plugin's own configuration — the switches in the left-sidebar panel
//      (a host `Config` schema; see index.js), stored in the profile patch;
//   2. the environment, for a deployment that tunes a headless install with no
//      UI at all;
//   3. the built-in defaults below.
//
// A layer only speaks when it actually says something: an unset switch, an empty
// distro or a zero timeout falls THROUGH to the layer beneath instead of pinning
// the default over it. That is what keeps `DSH_WSL_WORKDIR=session` working for a
// user who never opened the panel. An unparsable or out-of-range value falls back
// rather than failing the mount, because one bad environment variable must not
// take all three tools down.

import { windowsPathToWsl } from './paths.js'

export const DEFAULTS = {
  /**
   * Linux-side directory used when nothing else names one: the documented `~`.
   *
   * Named `homeWorkdir` rather than `workdir` because the configuration layer has a
   * `workdir` of its own — the directory a user types into the panel — and two things
   * called the same thing at different precedence would be a bug waiting to happen.
   */
  homeWorkdir: '~',
  /**
   * Whether a call with no `workdir` starts in the session's own directory.
   *
   * ON by default. Measured reason: with it off every relative path an agent writes
   * lands in the Linux home, which is invisible from Windows Explorer, is not next to
   * the checkout, and grows the WSL disk image. A user who genuinely wants `~` can
   * turn it off in the panel, or set `DSH_WSL_WORKDIR=home`.
   */
  startInSessionWorkspace: true,
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
  /** Which tools this plugin registers at all. */
  tools: { wsl: true, path: true, env: true },
  /** Whether `wsl` accepts `runInBackground` (the built-in job tools read it back). */
  backgroundJobs: true,
  /** Whether a Windows path in `command` is rewritten to /mnt/... by default. */
  translatePaths: true,
  /** Whether the destructive-command guard may be bypassed only by the caller's
   *  explicit `allowDangerous`. Never set this from the environment: it is the
   *  one switch whose off position is a footgun, and the panel marks it as such. */
  dangerGuard: true,
}

/**
 * Host shell facts forwarded into the Linux side.
 *
 * WSL does not pass Windows environment variables into a distribution (that is
 * what `WSLENV` is for), so without this the Linux side sees none of the facts
 * the platform's own shell tools inject, and a script reading `$DSH_SESSION_ID`
 * silently gets nothing.
 *
 * Only the KEYS live here; the values are per-execution — `DSH_SESSION_ID` cannot
 * be a host constant, since one host serves many sessions — so they are collected
 * by `runner.collectForwardEnv` from the platform's own `ctx.shellEnv` registry,
 * the same source the model's other shell tools use.
 *
 * `DSH_WEB_URL` is deliberately NOT in this list: it is a `127.0.0.1` URL for the
 * Windows-side server, and in the default NAT networking mode WSL cannot reach
 * Windows loopback (measured: HTTP 000 both on `127.0.0.1` and on the host IP,
 * which the server does not bind either). Forwarding it would hand out a URL
 * that cannot be opened. `DSH_HOME` is a Windows path, so it is translated to
 * the same directory's `/mnt/...` view.
 */
export const FORWARDED_ENV_KEYS = ['DSH_SESSION_ID', 'DSH_SHELL', 'DSH_HOME']

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

/** A configured boolean, or the fallback when the layer did not set one. */
function setting(value, fallback) {
  const raw = unbox(value)
  return typeof raw === 'boolean' ? raw : fallback
}

/**
 * Read one configuration value, unwrapping a volatile cell.
 *
 * A `.volatile()` schema field does NOT resolve to its value: schemastery wraps it
 * with cosmokit's `createVolatile(default)`, which is why the shipped plugins read
 * theirs as `config.timeoutMs.get()` (`dsh-bash-local`). The cell is written in
 * place when the user edits the field, and that in-place write is exactly what makes
 * an edit apply without remounting the plugin — so reading through `.get()` is both
 * required for correctness and how live updates arrive. A plain value (an older
 * host, or a hand-built settings object in a test) passes through untouched.
 */
function unbox(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/**
 * @param env - the environment layer.
 * @param configured - the plugin's own configuration layer (may be undefined).
 * @returns a distribution name to pin, or null to use the system default.
 */
function resolveDistro(env, configured) {
  const distro = unbox(configured)
  if (typeof distro === 'string' && distro.trim() !== '') return distro.trim()
  const raw = env.DSH_WSL_DISTRO
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

/**
 * Where a call starts when the caller passes no `workdir`.
 *
 * Precedence, most specific first: an explicit `workdir` in the plugin configuration
 * (what the panel or a profile patch sets), then the session's own directory when the
 * follow-session switch is on (it is ON by default), then `DSH_WSL_WORKDIR`, then `~`.
 * An explicit configured directory outranks follow-session on purpose: typing a Linux
 * path is a deliberate act, and clearing the field is how a user goes back to the
 * session directory.
 *
 * The environment keeps its documented two magic words: `home` means `~`, `session`
 * means the process working directory. Nothing here can pin a default OVER a
 * configured one — an unset or empty configuration always falls through.
 *
 * @returns a path, or null meaning "the process working directory" (the session's).
 */
function resolveWorkdir(env, settings) {
  const configured = unbox(settings.workdir)
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (setting(settings.startInSessionWorkspace, DEFAULTS.startInSessionWorkspace)) return null
  const raw = env.DSH_WSL_WORKDIR
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULTS.homeWorkdir
  const value = raw.trim()
  if (value === 'home') return DEFAULTS.homeWorkdir
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
 * @param settings - the plugin's own configuration, as the composition resolved
 *   it against the Config schema (injectable for tests; may be undefined).
 */
export function resolveConfig(env = process.env, settings = {}) {
  const maxOutputBytes = envInt(
    env, 'DSH_WSL_MAX_OUTPUT_BYTES', DEFAULTS.maxOutputBytes, OUTPUT_BYTES_MIN, OUTPUT_BYTES_MAX,
  )
  const maxCommandTimeoutMs = envInt(
    env, 'DSH_WSL_MAX_TIMEOUT_MS', DEFAULTS.maxCommandTimeoutMs, TIMEOUT_MS_MIN, DEFAULTS.maxTimerDelayMs,
  )
  const tools = unbox(settings.tools) ?? {}
  // 0 means "not configured", so the environment and the built-in default still
  // decide; a positive value is the user's own deadline.
  const configuredTimeout = unbox(settings.timeoutMs)
  const configuredTimeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : undefined
  return {
    ...DEFAULTS,
    tools: {
      wsl: setting(tools.wsl, DEFAULTS.tools.wsl),
      path: setting(tools.path, DEFAULTS.tools.path),
      env: setting(tools.env, DEFAULTS.tools.env),
    },
    backgroundJobs: setting(settings.backgroundJobs, DEFAULTS.backgroundJobs),
    translatePaths: setting(settings.translatePaths, DEFAULTS.translatePaths),
    dangerGuard: setting(settings.dangerGuard, DEFAULTS.dangerGuard),
    startInSessionWorkspace: setting(settings.startInSessionWorkspace, DEFAULTS.startInSessionWorkspace),
    // null means "whatever wsl.exe uses by default", which is what makes the
    // package portable: `Ubuntu-22.04` exists on the author's machine, not
    // necessarily on a storefront user's.
    distro: resolveDistro(env, settings.distro),
    defaultWorkdir: resolveWorkdir(env, settings),
    maxOutputBytes,
    maxSpillBytes: Math.max(DEFAULTS.maxSpillBytes, maxOutputBytes),
    maxCommandTimeoutMs,
    // The default deadline obeys the cap too, so the two knobs cannot disagree.
    commandTimeoutMs: Math.min(
      configuredTimeoutMs
      ?? envInt(env, 'DSH_WSL_TIMEOUT_MS', DEFAULTS.commandTimeoutMs, TIMEOUT_MS_MIN, DEFAULTS.maxTimerDelayMs),
      maxCommandTimeoutMs,
    ),
  }
}
