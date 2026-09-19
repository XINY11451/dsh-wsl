// The `wsl` tool: run one Linux command and return its output with markers.
//
// The description is deliberately lean: everything it says is either something
// the parameter schemas cannot express, or something that saves the model a
// wasted call. Both are injected into every request, so repetition between the
// description and the parameter docs is pure cost.

import { destructiveReason } from '../guard.js'
import { windowsPathToWsl } from '../paths.js'
import { formatResult } from '../result.js'
import { assertLauncherReachable } from '../runner.js'

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const LABEL_MAX_CHARS = 120

/** One-line, bounded label for a background job (`JobStart.label`). */
function jobLabel(command) {
  const first = String(command).split('\n')[0].trim()
  return `wsl: ${first.length > LABEL_MAX_CHARS ? `${first.slice(0, LABEL_MAX_CHARS - 1)}…` : first}`
}

export function createWslTool({ ctx, config, runner }) {
  /** The value returned when a command is handed to the background. */
  function backgroundResult(jobId) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      timeoutMs: null,
      truncated: false,
      stdout: '',
      stderr: '',
      stdoutTotalBytes: 0,
      stdoutDroppedBytes: 0,
      stderrTotalBytes: 0,
      stderrDroppedBytes: 0,
      stdoutSpillPath: null,
      stderrSpillPath: null,
      jobId: String(jobId),
    }
  }

  /**
   * Start `command` as a job in the host's registry, so the model drives it with
   * the generic `job_output`/`job_kill` tools it already has.
   *
   * The jobs service is OPTIONAL (`ctx.get`, never `inject`): a preset without
   * `tool-jobs` must still mount this plugin for foreground use.
   */
  function startInBackground(command, opts, exec) {
    const jobs = ctx.get?.('jobs')
    if (jobs === undefined || jobs === null) {
      throw new Error(
        'wsl: runInBackground needs the background-job service, which this preset does not provide ' +
        '(load the `tool-jobs` plugin). Run the command in the foreground with a larger `timeoutMs` instead.',
      )
    }

    let launched
    let cancelReason = null
    let jobId
    try {
      jobId = jobs.start({
        kind: 'wsl',
        label: jobLabel(command),
        outputLimitBytes: config.maxOutputBytes,
        ...(exec?.agent === undefined ? {} : { owner: exec.agent }),
        // The spawn happens INSIDE run(): the contract says a throw leaves
        // nothing registered, so spawning first and registering second could
        // leak a process if registration failed.
        run() {
          const started = runner.startWsl(command, opts)
          launched = started.launched
          const { distro } = started.plan
          return {
            cancel(reason) {
              cancelReason = reason ?? null
              launched.cancel()
            },
            done: launched.settle().then(
              (value) => {
                const output = formatResult(value, config.maxOutputBytes)
                try {
                  // A launcher failure is not the command's result, even here.
                  assertLauncherReachable(distro, value)
                } catch (error) {
                  return { status: 'failed', detail: error.message, output }
                }
                if (launched.state.cancelled) {
                  return { status: 'killed', detail: cancelReason === null ? 'cancelled' : `cancelled: ${cancelReason}`, output }
                }
                if (value.timedOut) return { status: 'killed', detail: 'timed out', output }
                if (value.signal !== null) return { status: 'killed', detail: `signal ${value.signal}`, output }
                return { status: 'completed', detail: `exit code ${value.exitCode}`, output }
              },
              // `JobHooks.done` must never reject. Cancelling a job before its
              // target starts makes the provider reject the handle ("terminated
              // before target start"), which is a cancellation — not a failure
              // of work that never ran.
              (error) => {
                const detail = error?.message ?? String(error)
                return launched.state.cancelled
                  ? { status: 'killed', detail: cancelReason === null ? 'cancelled' : `cancelled: ${cancelReason}`, output: '' }
                  : { status: 'failed', detail, output: '' }
              },
            ),
          }
        },
      })
    } catch (error) {
      // The registry refuses when no controller serves this composition, and a
      // producer failure inside run() lands here too. Either way the caller
      // still has a way forward, so say so.
      throw new Error(
        `wsl: could not start a background job (${error?.message ?? String(error)}). ` +
        'Run the command in the foreground instead, with a larger `timeoutMs`.',
      )
    }
    return backgroundResult(jobId)
  }

  return {
    name: 'wsl',
    description:
      'Run a Linux command through WSL and return its stdout/stderr, with trailing markers for a ' +
      'non-zero exit, a timeout, or truncated output. Each call is a fresh shell — nothing persists, ' +
      'so pass `workdir` or `cd` inside the command. stdin is /dev/null unless you pass `stdin`, so an ' +
      'interactive command (`read`, a password prompt) gets EOF immediately. Windows paths in ' +
      '`command`/`workdir` are rewritten to their /mnt/... form automatically. Output is capped per ' +
      'stream; when it is truncated the marker names a file holding the complete output, which you can ' +
      'read. Set `runInBackground` for work that outlives the call. A destructive command is refused ' +
      'unless `allowDangerous` is true.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The Linux command to execute inside WSL.',
        },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
        },
        workdir: {
          type: 'string',
          description: 'Working directory inside WSL: a Linux path (`~`, `/home/me`) or a Windows path, which is translated. Default `~`.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds; on expiry the process is killed and the result is marked as timed out. Defaults to ${config.commandTimeoutMs}.`,
        },
        distro: {
          type: 'string',
          description: 'WSL distribution to run in. Defaults to the system default distribution; overrides the DSH_WSL_DISTRO environment variable.',
        },
        env: {
          type: 'object',
          // DSH's supported schema subset requires a BOOLEAN here (an object
          // value schema is rejected by assertSupportedJsonSchema), so the
          // value type lives in the description and is enforced at runtime by
          // execute(), which rejects a non-string value or a bad key name.
          additionalProperties: true,
          description: 'Extra environment variables to export before the command. Keys must be valid shell names and values must be strings.',
        },
        stdin: {
          type: 'string',
          description: 'Text written to the command stdin (UTF-8) before it runs. A `sudo -S` password passed here is recorded in the transcript.',
        },
        runInBackground: {
          type: 'boolean',
          description: 'Run as a background job and return its id immediately: read it with job_output, stop it with job_kill. No default deadline applies.',
        },
        allowDangerous: {
          type: 'boolean',
          description: 'Must be true to run a destructive command: a recursive delete, dd onto a device, mkfs/partitioning, power control, or a fork bomb.',
        },
        translatePaths: {
          type: 'boolean',
          description: 'Default true: rewrite Windows paths in `command` to /mnt/... . Set false to pass `command` verbatim, e.g. a native path for a Windows program launched through interop. `workdir` is always translated.',
        },
      },
      required: ['command', 'description'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          timeoutMs: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          truncated: { type: 'boolean' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          stdoutTotalBytes: { type: 'integer' },
          stdoutDroppedBytes: { type: 'integer' },
          stderrTotalBytes: { type: 'integer' },
          stderrDroppedBytes: { type: 'integer' },
          stdoutSpillPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          stderrSpillPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          jobId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: [
          'exitCode', 'signal', 'timedOut', 'timeoutMs', 'truncated', 'stdout', 'stderr',
          'stdoutTotalBytes', 'stdoutDroppedBytes', 'stderrTotalBytes', 'stderrDroppedBytes',
          'stdoutSpillPath', 'stderrSpillPath', 'jobId',
        ],
      },
      render: (_args, value) => [{ type: 'text', text: formatResult(value, config.maxOutputBytes) }],
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('wsl: command must be a non-empty string')
      }
      if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        throw new Error('wsl: description must be a non-empty string')
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error('wsl: timeoutMs must be a positive number')
      }
      if (args.translatePaths !== undefined && typeof args.translatePaths !== 'boolean') {
        throw new Error('wsl: translatePaths must be a boolean')
      }
      if (args.runInBackground !== undefined && typeof args.runInBackground !== 'boolean') {
        throw new Error('wsl: runInBackground must be a boolean')
      }
      if (args.stdin !== undefined && typeof args.stdin !== 'string') {
        throw new Error('wsl: stdin must be a string')
      }
      if (args.env !== undefined && (typeof args.env !== 'object' || args.env === null || Array.isArray(args.env))) {
        throw new Error('wsl: env must be an object of string values')
      }
      if (args.env !== undefined) {
        // Silently dropping a bad key would run the command with the variable
        // missing, which is worse than refusing it.
        for (const [key, value] of Object.entries(args.env)) {
          if (!ENV_KEY_RE.test(key)) {
            throw new Error(`wsl: env key ${JSON.stringify(key)} is not a valid shell variable name`)
          }
          if (value !== undefined && typeof value !== 'string') {
            throw new Error(`wsl: env["${key}"] must be a string`)
          }
        }
      }

      const command = args.translatePaths === false ? args.command : windowsPathToWsl(args.command)
      const reason = destructiveReason(command)
      if (reason !== null && args.allowDangerous !== true) {
        throw new Error(
          `wsl: refused a destructive command (${reason}). ` +
          'If this is intended, re-issue it with `allowDangerous: true`.',
        )
      }

      const opts = {
        distro: args.distro,
        workdir: args.workdir,
        env: args.env,
        stdin: args.stdin,
      }

      if (args.runInBackground === true) {
        // A background job is meant to outlive the foreground deadline, so the
        // configured default does NOT apply; an explicit timeoutMs still does.
        return startInBackground(command, { ...opts, timeoutMs: args.timeoutMs }, exec)
      }

      return await runner.runWsl(command, {
        ...opts,
        timeoutMs: args.timeoutMs ?? config.commandTimeoutMs,
      })
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: args.command,
      description: args.description,
      // The card must show the directory the command really runs in, not the
      // Windows spelling the caller passed.
      ...(args.workdir !== undefined ? { cwd: windowsPathToWsl(args.workdir) } : {}),
    }),
  }
}
