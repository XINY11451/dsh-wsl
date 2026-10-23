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

// A distribution name travels as ONE argv element (`-d`, name), never through a shell, so the
// only real requirements are "not empty" and "nothing that would terminate an argument or the
// Windows command line". Spaces are legal — an imported distribution is commonly named
// `Ubuntu 22.04`, and the old `[A-Za-z0-9._-]` rule rejected it even though argv makes it
// safe. A name starting with `-` is still refused: wsl.exe would read it as another option.
const DISTRO_RE = /^[^\u0000-\u001f\u007f/\\]+$/
// The schema-facing `export KEY=value` fragments are built by string interpolation, so the key
// has to BE a shell variable name; the tool layer checks this too, but `planCommand` is exported
// and every future caller should get the same refusal instead of an injection-shaped command.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Windows command-line length of one argv element, in the form Node builds for CreateProcess.
 *
 * Windows caps the whole line at 32767 characters, and the cap counts the escaped rendering: a
 * `"` becomes `\"` and a run of backslashes before it doubles. `full.length` therefore
 * understates the line — measured: 29 990 characters containing 12 000 quotes overflowed and
 * `spawn` threw ENAMETOOLONG instead of taking the stdin fallback. Every quote/backslash is
 * counted as one extra character, which errs toward "too long" (safe) rather than "fits".
 *
 * @param text - the script that would travel as argv.
 * @returns a conservative upper bound on the command line it needs.
 */
function escapedCommandLineLength(text) {
  let extra = 2 // the surrounding quotes Node adds to an argument with spaces
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x22 /* " */ || code === 0x5c /* \ */) extra += 1
  }
  return text.length + extra
}

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
  const trimmed = typeof distro === 'string' ? distro.trim() : ''
  if (trimmed === '' || !DISTRO_RE.test(trimmed) || trimmed.startsWith('-')) {
    throw new Error('wsl: distro must be a name without slashes or control characters (letters, digits, spaces, dot, dash, underscore)')
  }
  return trimmed
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
  function launch(argv, timeoutMs, stdinData, facts = {}) {
    // The configured window is sized for console output. A caller that has to
    // hand back a whole file (`wsl-read`, `wsl-edit`) asks for a wider one; the
    // configured value stays the floor, so a host that raised it still wins.
    // The ceiling is the spill budget: a window is memory in the collector, and
    // a caller cannot ask for more than the size this plugin already agrees to
    // hold on disk for one call.
    const requested = typeof facts.outputBytes === 'number' ? facts.outputBytes : 0
    const windowBytes = Math.min(Math.max(maxOutputBytes, requested), maxSpillBytes)
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
          stdout: { maxBytes: windowBytes, spill: { maxBytes: maxSpillBytes } },
          stderr: { maxBytes: windowBytes, spill: { maxBytes: maxSpillBytes } },
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
          // Whether this call ran as root is a property of the CALL, not of its
          // output: the model-facing marker is built from it, and an audit of a
          // transcript cannot recover it from the command text.
          asRoot: facts.asRoot === true,
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

  async function spawnWsl(argv, timeoutMs, stdinData, facts = {}) {
    return await launch(argv, timeoutMs, stdinData, facts).settle()
  }

  /** Build the argv (and stdin form) for one `wsl` command. */
  function planCommand(command, opts = {}) {
    const distro = resolveDistro(opts.distro, config)
    const requested = opts.workdir !== undefined && opts.workdir !== '' ? opts.workdir : null
    // "session" mode means the CALLING SESSION's workspace, not the directory the
    // host process happened to be launched from.
    const sessionCwd = sessionCwdOf(opts.exec)
    // EVERY source of the directory goes through the same translation: the per-call `workdir`,
    // the session workspace, and the configured/env default (`DSH_WSL_WORKDIR` or the panel
    // field may hold a Windows path even though the field is documented as a Linux one). The
    // distro is passed so a UNC path naming a DIFFERENT distribution is not repointed at this
    // one's directory.
    const workdir = requested !== null
      ? windowsPathToWsl(requested, { distro })
      : config.defaultWorkdir === null
        ? windowsPathToWsl(sessionCwd ?? process.cwd(), { distro })
        : windowsPathToWsl(config.defaultWorkdir, { distro })

    // The `cd` owns the WHOLE script. `cd <dir> && <script>` guards only the
    // script's FIRST command, so a multi-line script aimed at a directory that
    // cannot be entered runs every later line in whatever directory the host
    // process started in — measured: `wsl-doctor` pointed at a nonexistent path
    // reported the DSH profile directory's manifests as the project's, and a
    // multi-line `wsl` command would have run its second half in the wrong place.
    // `|| exit 1` ends the call before anything runs, leaving bash's own `cd` error
    // on stderr and a non-zero exit status.
    let full = `${buildCdCommand(workdir)} || exit 1; ${command}`
    // Forwarded host facts first, then the caller's own entries: an explicit
    // `env` value always wins over an inherited one.
    const env = { ...collectForwardEnv(ctx, opts.exec), ...(opts.env && typeof opts.env === 'object' ? opts.env : {}) }
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_KEY_RE.test(key)) throw new Error(`wsl: env key ${JSON.stringify(key)} is not a valid shell variable name`)
      if (value !== undefined && typeof value !== 'string') throw new Error(`wsl: env[${JSON.stringify(key)}] must be a string`)
    }
    const exports = Object.entries(env)
      .map(([k, v]) => (v === undefined ? `unset ${k}` : `export ${k}=${shellQuote(v)}`))
    if (exports.length > 0) full = exports.join('; ') + '; ' + full

    // The script travels as an argv string, except past the Windows command-line
    // limit where it is fed to `bash -ls` on stdin instead. The decision uses the
    // ESCAPED length (see `escapedCommandLineLength`), because that is the length
    // Windows enforces. That fallback owns stdin, so it cannot coexist with
    // caller-supplied stdin.
    const viaStdin = escapedCommandLineLength(full) > maxCommandChars
    if (viaStdin && typeof opts.stdin === 'string') {
      throw new Error(
        `wsl: this command is over the ${maxCommandChars}-character command-line limit, so the script itself must travel on stdin — ` +
        'it cannot also carry `stdin` data. Write the script to a file and run that, or split the command.',
      )
    }

    const distroArgs = distro === null ? [] : ['-d', distro]
    // `-u root` sits with `-d`, before `-e`: both are launcher options, and the
    // command that follows them is the distribution's own argv.
    const userArgs = opts.asRoot === true ? ['-u', 'root'] : []
    return {
      distro,
      asRoot: opts.asRoot === true,
      argv: viaStdin
        ? ['wsl.exe', ...distroArgs, ...userArgs, '-e', 'bash', '-ls']
        : ['wsl.exe', ...distroArgs, ...userArgs, '-e', 'bash', '-lc', full],
      stdinData: viaStdin ? full : opts.stdin,
      // Carried through the plan so the launch and the argv agree about the
      // same call; the file tools are the only callers that set it.
      outputBytes: opts.outputBytes,
    }
  }

  /** Run a Linux command to completion. */
  async function runWsl(command, opts = {}) {
    const plan = planCommand(command, opts)
    const result = await spawnWsl(plan.argv, opts.timeoutMs, plan.stdinData, {
      asRoot: plan.asRoot,
      outputBytes: plan.outputBytes,
    })
    assertLauncherReachable(plan.distro, result)
    return result
  }

  /** Launch a Linux command without awaiting it (background jobs). */
  function startWsl(command, opts = {}) {
    const plan = planCommand(command, opts)
    return { plan, launched: launch(plan.argv, opts.timeoutMs, plan.stdinData, { asRoot: plan.asRoot }) }
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
