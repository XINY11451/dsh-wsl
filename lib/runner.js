// The single spawn path. Every call in this plugin goes through it, so the
// stdio shape, grace period, deadline classification and truncation facts are
// identical for the model-facing tool and the plugin's own probes.
//
// Launching is split from settling on purpose: a background job must hand the
// jobs registry a synchronous `cancel`/`done` pair, while a foreground call just
// awaits the same settle step. `launch()` is that shared synchronous half.

import { FORWARDED_ENV_KEYS } from './config.js'
import { buildCdCommand, shellQuote, windowsPathToWsl } from './paths.js'
import { cleanStderr, normalizeExitCode, streamFacts } from './result.js'

// Only allow distribution names that cannot inject shell syntax into argv.
const DISTRO_RE = /^[A-Za-z0-9._-]+$/

/**
 * Resolve the distribution to use for one call.
 *
 * The caller's argument wins, then `DSH_WSL_DISTRO`, then the system default —
 * signalled by `null`, which drops `-d` entirely. That last case is what makes
 * the package portable: a hardcoded `Ubuntu-22.04` is a distro the author has
 * and a storefront user may not.
 *
 * @returns a distro name, or null to let wsl.exe pick its default.
 */
export function resolveDistro(arg, config) {
  const distro = arg ?? config.distro
  if (distro === undefined || distro === null) return null
  if (typeof distro !== 'string' || !DISTRO_RE.test(distro) || distro.trim() === '') {
    throw new Error('wsl: distro must be a simple name (letters, digits, dot, dash, underscore)')
  }
  return distro
}

/**
 * The calling session's workspace, taken from the execution the host hands us.
 *
 * This is `dsh-tool-fs`'s own source (`exec.agent.session.header.cwd`), and the
 * distinction matters: `process.cwd()` is the directory the DSH *host* was
 * launched from, which for a web deployment is the installation directory rather
 * than the session's project. Anything keyed off the launch directory points a
 * session at the wrong tree.
 *
 * @returns the session workspace, or undefined for a caller that has none.
 */
export function sessionCwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Per-execution `DSH_*` facts, resolved the way the platform's shell tools
 * resolve them.
 *
 * `process.env` is the WRONG source: these values are per-session, and the
 * `ctx.shellEnv` registry builds them for each execution — a host-level read
 * finds nothing and forwards nothing, silently. `process.env` remains only as a
 * fallback for a deployment where the registry is absent.
 */
export function collectForwardEnv(ctx, exec) {
  let facts
  try {
    facts = ctx?.get?.('shellEnv')?.collect?.(exec)
  } catch {
    facts = undefined
  }
  const source = facts !== null && typeof facts === 'object' ? facts : process.env

  const forwarded = {}
  for (const key of FORWARDED_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') forwarded[key] = value
  }
  if (forwarded.DSH_HOME !== undefined) forwarded.DSH_HOME = windowsPathToWsl(forwarded.DSH_HOME)
  return forwarded
}

// A launcher-level failure means bash never ran, so surface it as a tool error
// instead of handing the model a meaningless exit code. The Wsl/Service/WSL_E_*
// code is locale-independent, unlike the message around it.
const LAUNCHER_ERROR_RE = /Wsl\/Service\/(WSL_E_[A-Z0-9_]+)/

export function assertLauncherReachable(distro, result) {
  if (result.exitCode === 0) return
  const match = LAUNCHER_ERROR_RE.exec(`${result.stderr}\n${result.stdout}`)
  if (match === null) return

  const detail = result.stderr.trim().split(/\r?\n/)[0]
  if (match[1] === 'WSL_E_DISTRO_NOT_FOUND') {
    throw new Error(
      `wsl: distribution ${distro === null ? '(system default)' : `"${distro}"`} is not registered. ` +
      'Run the wsl-env tool (or `wsl -l -v`) to list the available distributions.',
    )
  }
  throw new Error(
    `wsl: the WSL launcher failed (${match[1]})${detail === '' ? '' : `: ${detail}`}. ` +
    'Check that WSL and its service are healthy (`wsl --status`).',
  )
}

/**
 * Build the runner bound to one mount's context and configuration.
 * @param ctx - plugin context providing the host `subprocess` service.
 * @param config - resolved configuration (see `resolveConfig`).
 */
export function createRunner(ctx, config) {
  const { maxOutputBytes, maxSpillBytes, graceMs, maxTimerDelayMs, maxCommandChars, maxCommandTimeoutMs } = config

  /**
   * Spawn immediately and return the handle plus a `settle()` that awaits it and
   * builds the model-facing value. Synchronous, so background jobs can attach
   * their hooks without waiting a tick.
   */
  function launch(argv, timeoutMs, stdinData) {
    const controller = new AbortController()
    const state = { timedOut: false, cancelled: false }
    // A per-call deadline is capped like the platform shell tools cap theirs,
    // and by the same value the default obeys, so the `timeoutMs` reported back
    // is always the deadline that was actually armed.
    const effectiveTimeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0
      ? Math.min(timeoutMs, maxCommandTimeoutMs, maxTimerDelayMs)
      : null

    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv,
        // Required by the dsh 0.1.5 subprocess seam: every spawn spec states its
        // own working directory. The Linux-side directory is set by the `cd`
        // prefix the caller builds, so the Windows-side cwd only has to be a
        // real directory (it also becomes the initial WSL cwd).
        cwd: process.cwd(),
        env: { WSL_UTF8: '1' },
        stdio: {
          stdin: typeof stdinData === 'string' ? { data: stdinData } : 'ignore',
          stdout: { maxBytes: maxOutputBytes, spill: { maxBytes: maxSpillBytes } },
          stderr: { maxBytes: maxOutputBytes, spill: { maxBytes: maxSpillBytes } },
        },
        graceMs,
        signal: controller.signal,
      })
    } catch (error) {
      throw new Error(`wsl: could not launch ${argv[0]}: ${error?.message ?? String(error)}`)
    }

    // Armed AFTER the child exists: the deadline measures the child's lifetime,
    // and an already-aborted signal can never reach the provider (which throws
    // "aborted before spawn" instead of starting anything).
    let timer = null
    if (effectiveTimeoutMs !== null) {
      timer = setTimeout(() => {
        state.timedOut = true
        controller.abort()
      }, effectiveTimeoutMs)
    }

    async function settle() {
      try {
        let outcome
        try {
          outcome = await handle.done
        } catch (error) {
          throw new Error(`wsl: ${argv[0]} failed to run: ${error?.message ?? String(error)}`)
        }

        const stdout = streamFacts(handle.collected?.stdout?.readFrom(0))
        const stderr = streamFacts(handle.collected?.stderr?.readFrom(0))

        return {
          exitCode: normalizeExitCode(outcome.exitCode ?? null),
          signal: outcome.signal ?? null,
          timedOut: state.timedOut,
          timeoutMs: effectiveTimeoutMs,
          stdout: stdout.text,
          stderr: cleanStderr(stderr.text),
          truncated: stdout.lossy || stderr.lossy,
          stdoutTotalBytes: stdout.totalBytes,
          stdoutDroppedBytes: stdout.droppedBytes,
          stderrTotalBytes: stderr.totalBytes,
          stderrDroppedBytes: stderr.droppedBytes,
          stdoutSpillPath: stdout.spillPath,
          stderrSpillPath: stderr.spillPath,
          // Present for every call so the declared output schema holds: only a
          // background START carries an id.
          jobId: null,
        }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    return {
      handle,
      state,
      settle,
      effectiveTimeoutMs,
      /** Idempotent, like the seam's own `terminate()`. */
      cancel() {
        state.cancelled = true
        handle.terminate()
      },
    }
  }

  async function spawnWsl(argv, timeoutMs, stdinData) {
    return await launch(argv, timeoutMs, stdinData).settle()
  }

  /** Build the argv (and stdin form) for one `wsl` command. */
  function planCommand(command, opts = {}) {
    const distro = resolveDistro(opts.distro, config)
    const requested = opts.workdir !== undefined && opts.workdir !== '' ? opts.workdir : null
    // "session" mode means the CALLING SESSION's workspace, not the directory the
    // host process happened to be launched from.
    const sessionCwd = sessionCwdOf(opts.exec)
    const workdir = requested !== null
      ? windowsPathToWsl(requested)
      : config.defaultWorkdir === null
        ? windowsPathToWsl(sessionCwd ?? process.cwd())
        : config.defaultWorkdir

    let full = `${buildCdCommand(workdir)} && ${command}`
    // Forwarded host facts first, then the caller's own entries: an explicit
    // `env` value always wins over an inherited one.
    const env = { ...collectForwardEnv(ctx, opts.exec), ...(opts.env && typeof opts.env === 'object' ? opts.env : {}) }
    const exports = Object.entries(env)
      .map(([k, v]) => (v === undefined ? `unset ${k}` : `export ${k}=${shellQuote(v)}`))
    if (exports.length > 0) full = exports.join('; ') + '; ' + full

    // The script travels as an argv string, except past the Windows
    // command-line limit where it is fed to `bash -ls` on stdin instead. That
    // fallback owns stdin, so it cannot coexist with caller-supplied stdin.
    const viaStdin = full.length > maxCommandChars
    if (viaStdin && typeof opts.stdin === 'string') {
      throw new Error(
        `wsl: this command is over the ${maxCommandChars}-character command-line limit, so the script itself must travel on stdin — ` +
        'it cannot also carry `stdin` data. Write the script to a file and run that, or split the command.',
      )
    }

    const distroArgs = distro === null ? [] : ['-d', distro]
    return {
      distro,
      argv: viaStdin
        ? ['wsl.exe', ...distroArgs, '-e', 'bash', '-ls']
        : ['wsl.exe', ...distroArgs, '-e', 'bash', '-lc', full],
      stdinData: viaStdin ? full : opts.stdin,
    }
  }

  /** Run a Linux command to completion. */
  async function runWsl(command, opts = {}) {
    const plan = planCommand(command, opts)
    const result = await spawnWsl(plan.argv, opts.timeoutMs, plan.stdinData)
    assertLauncherReachable(plan.distro, result)
    return result
  }

  /** Launch a Linux command without awaiting it (background jobs). */
  function startWsl(command, opts = {}) {
    const plan = planCommand(command, opts)
    return { plan, launched: launch(plan.argv, opts.timeoutMs, plan.stdinData) }
  }

  return {
    spawnWsl,
    runWsl,
    startWsl,
    planCommand,
    /** Bound to this mount's config, so callers never re-resolve env vars. */
    resolveDistro: (arg) => resolveDistro(arg, config),
  }
}
