// The single spawn path. Every call in this plugin goes through it, so the
// stdio shape, grace period, deadline classification and truncation facts are
// identical for the model-facing tool and the plugin's own probes.

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
  const { maxOutputBytes, maxSpillBytes, graceMs, maxTimerDelayMs, maxCommandChars } = config

  async function spawnWsl(argv, timeoutMs, stdinData) {
    const controller = new AbortController()
    let timedOut = false
    let timer = null
    const effectiveTimeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0
      ? Math.min(timeoutMs, maxTimerDelayMs)
      : null

    try {
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          // Required by the dsh 0.1.5 subprocess seam: every spawn spec states
          // its own working directory. The Linux-side directory is set by the
          // `cd` prefix the caller builds, so the Windows-side cwd only has to
          // be a real directory (it also becomes the initial WSL cwd).
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

      // Armed AFTER the child exists: the deadline measures the child's
      // lifetime, and an already-aborted signal can never reach the provider
      // (which throws "aborted before spawn" instead of starting anything).
      if (effectiveTimeoutMs !== null) {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, effectiveTimeoutMs)
      }

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
        timedOut,
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
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /**
   * Run a Linux command, prefixed with `cd <workdir>` and any `env` exports.
   *
   * The script travels as an argv string, except past the Windows command-line
   * limit where it is fed to `bash -ls` on stdin instead — no size ceiling, at
   * the cost of one extra shell flavour.
   */
  async function runWsl(command, opts = {}) {
    const distro = resolveDistro(opts.distro, config)
    const workdir = opts.workdir !== undefined && opts.workdir !== ''
      ? windowsPathToWsl(opts.workdir)
      : config.workdir

    let full = `${buildCdCommand(workdir)} && ${command}`
    if (opts.env && typeof opts.env === 'object') {
      const exports = Object.entries(opts.env)
        .map(([k, v]) => (v === undefined ? `unset ${k}` : `export ${k}=${shellQuote(v)}`))
      if (exports.length > 0) full = exports.join('; ') + '; ' + full
    }

    const distroArgs = distro === null ? [] : ['-d', distro]
    const viaStdin = full.length > maxCommandChars
    const argv = viaStdin
      ? ['wsl.exe', ...distroArgs, '-e', 'bash', '-ls']
      : ['wsl.exe', ...distroArgs, '-e', 'bash', '-lc', full]

    const result = await spawnWsl(argv, opts.timeoutMs, viaStdin ? full : undefined)
    assertLauncherReachable(distro, result)
    return result
  }

  return {
    spawnWsl,
    runWsl,
    /** Bound to this mount's config, so callers never re-resolve env vars. */
    resolveDistro: (arg) => resolveDistro(arg, config),
  }
}
