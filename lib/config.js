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
// the default over it. That is what keeps `DSH_WSL_WORKDIR` working for a user who
// never opened the panel — including when the follow-session switch is still at its
// ON default, which is exactly the case the old code got wrong (see
// `resolveWorkdir`). An unparsable or out-of-range value falls back rather than
// failing the mount, because one bad environment variable must not take all three
// tools down.

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
  /** Windows caps a whole command line at 32767 characters; above this the script
   *  is fed to `bash -ls` on stdin instead. The comparison is made against an
   *  ESCAPED-length estimate (quotes and backslashes count extra), because that is
   *  the length Windows enforces — see `runner.escapedCommandLineLength`. */
  maxCommandChars: 30_000,
  /** `setTimeout` stores its delay in a signed 32-bit int; larger fires at once. */
  maxTimerDelayMs: 2 ** 31 - 1,
  /** Which tools this plugin registers at all. `wsl-term` is not here: it has no
   *  switch, because opening a terminal in the sidebar is the consent it needs. */
  tools: { wsl: true, path: true, env: true, doctor: false, bootstrap: false, read: true, write: true, edit: true, grep: true },
  /** Whether `wsl` accepts `runInBackground` (the built-in job tools read it back). */
  backgroundJobs: true,
  /** Whether a Windows path in `command` is rewritten to /mnt/... by default. */
  translatePaths: true,
  /** Whether the destructive-command guard may be bypassed only by the caller's
   *  explicit `allowDangerous`. Never set this from the environment: it is the
   *  one switch whose off position is a footgun, and the panel marks it as such. */
  dangerGuard: true,
  /**
   * Whether `wsl` accepts `asRoot: true`, which runs that call as root.
   *
   * OFF by default, and deliberately not settable from the environment either:
   * WSL's root needs no password (measured: `wsl -u root -e id` answers uid=0
   * while `sudo -n` fails for lack of a password), so this switch IS the entire
   * authorisation step. A headless deployment that wants it writes it into the
   * profile patch, which is a file a human edits — not an environment variable a
   * launcher can inherit.
   */
  allowRoot: false,
  /**
   * WSL channel: whether the terminal-side `dsh` command may send prompts into a
   * client session, and which session that lands in when the terminal does not
   * name one. Both are panel switches; they are read through resolveConfig, so a
   * field missing from this file silently stays at the default forever.
   */
  channelEnabled: false,
  /** Empty means the most recently active conversation — never a new session. */
  channelSession: '',
  /**
   * Check the installed `dsh` shim on start and reinstall it when it is missing or
   * older than this version. On by default: the shim is the plugin's own file and a
   * stale one fails in a way that looks like "not installed".
   */
  autoInstallShim: true,
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
 * The directory `DSH_WSL_WORKDIR` names, in the module's own terms.
 * @returns `undefined` when the variable is absent/blank, otherwise the `~` spelling, the
 *   `null` that means "the session directory", or the path as typed.
 */
function envWorkdir(env) {
  const raw = env.DSH_WSL_WORKDIR
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const value = raw.trim()
  if (value === 'home') return DEFAULTS.homeWorkdir
  if (value === 'session') return null
  return value
}

/**
 * Where a call starts when the caller passes no `workdir`.
 *
 * Precedence, most specific first:
 *   1. an explicit `workdir` in the plugin configuration (the panel field or a profile patch);
 *   2. `DSH_WSL_WORKDIR`, when it is set — it is an explicit deployment decision;
 *   3. the follow-session switch;
 *   4. `~`.
 *
 * Why the environment outranks the switch when both speak: the switch's schema default is ON
 * (`.default(true).volatile()`), so a plugin that has never been configured still carries
 * `true`, indistinguishable from a panel edit. Honouring it above the environment made
 * `DSH_WSL_WORKDIR` DEAD in every default deployment — measured: `resolveConfig(
 * {DSH_WSL_WORKDIR:'home'}, {}).defaultWorkdir === null` — which contradicted the README and
 * the test-suite comment that this variable "keeps working for someone who never opened the
 * panel". An env var is a deliberate act, so it speaks now.
 *
 * One exception is kept for the test/host shape: when the settings object carries a PLAIN
 * boolean for the switch (not a volatile cell), that value was supplied by the caller
 * directly, so it is treated as an explicit configuration layer and wins over the
 * environment — `{ startInSessionWorkspace: false }` must still mean `~`/env, and
 * `{ startInSessionWorkspace: true }` must still mean the session directory.
 *
 * The environment keeps its documented magic words: `home` means `~`, `session` means the
 * process working directory. Nothing here can pin a default OVER a configured directory.
 *
 * @returns a path, or null meaning "the process working directory" (the session's).
 */
function resolveWorkdir(env, settings) {
  const configured = unbox(settings.workdir)
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()

  const fromEnv = envWorkdir(env)
  const rawSwitch = settings.startInSessionWorkspace
  // A plain boolean is explicit configuration (a hand-built settings object or an older host
  // that resolved the schema itself). A volatile cell may still be carrying its DEFAULT, so
  // it must not silence the environment layer.
  if (typeof rawSwitch === 'boolean') {
    if (rawSwitch) return null
    return fromEnv === undefined ? DEFAULTS.homeWorkdir : fromEnv
  }

  if (fromEnv !== undefined) return fromEnv
  return unbox(rawSwitch) === false ? DEFAULTS.homeWorkdir : null
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
/// The channel landing session: trimmed, or the empty string for auto mode.
/// @param {unknown} value - the configured value (possibly a cosmokit cell).
/// @returns {string} a session id, or '' when the channel should manage its own.
function resolveChannelSession(value) {
  const text = unbox(value)
  return typeof text === 'string' ? text.trim() : ''
}

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
      doctor: setting(tools.doctor, DEFAULTS.tools.doctor),
      // Off unless the user turns it on: the only switch here whose ON position
      // lets the plugin install software inside the distribution.
      bootstrap: setting(tools.bootstrap, DEFAULTS.tools.bootstrap),
      read: setting(tools.read, DEFAULTS.tools.read),
      write: setting(tools.write, DEFAULTS.tools.write),
      edit: setting(tools.edit, DEFAULTS.tools.edit),
      grep: setting(tools.grep, DEFAULTS.tools.grep),
    },
    backgroundJobs: setting(settings.backgroundJobs, DEFAULTS.backgroundJobs),
    translatePaths: setting(settings.translatePaths, DEFAULTS.translatePaths),
    dangerGuard: setting(settings.dangerGuard, DEFAULTS.dangerGuard),
    allowRoot: setting(settings.allowRoot, DEFAULTS.allowRoot),
    channelEnabled: setting(settings.channelEnabled, DEFAULTS.channelEnabled),
    channelSession: resolveChannelSession(settings.channelSession),
    autoInstallShim: setting(settings.autoInstallShim, DEFAULTS.autoInstallShim),
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
