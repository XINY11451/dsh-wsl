// The `wsl` tool: run one Linux command and return its output with markers.
//
// The description is deliberately lean: everything it says is either something
// the parameter schemas cannot express, or something that saves the model a
// wasted call. Both are injected into every request, so repetition between the
// description and the parameter docs is pure cost.

import { destructiveReason } from '../guard.js'
import { windowsPathToWsl } from '../paths.js'
import { formatResult } from '../result.js'

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function createWslTool({ config, runner }) {
  return {
    name: 'wsl',
    description:
      'Run a Linux command through WSL and return its stdout/stderr, with trailing markers for a ' +
      'non-zero exit, a timeout, or truncated output. Each call is a fresh shell — nothing persists, ' +
      'so pass `workdir` or `cd` inside the command. stdin is /dev/null, so an interactive command ' +
      '(`read`, a password prompt) gets EOF immediately. Windows paths in `command`/`workdir` are ' +
      'rewritten to their /mnt/... form automatically. Output is capped per stream; when it is ' +
      'truncated the marker names a file holding the complete output, which you can read. A ' +
      'destructive command is refused unless `allowDangerous` is true.',
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
        },
        required: [
          'exitCode', 'signal', 'timedOut', 'timeoutMs', 'truncated', 'stdout', 'stderr',
          'stdoutTotalBytes', 'stdoutDroppedBytes', 'stderrTotalBytes', 'stderrDroppedBytes',
          'stdoutSpillPath', 'stderrSpillPath',
        ],
      },
      render: (_args, value) => [{ type: 'text', text: formatResult(value, config.maxOutputBytes) }],
    },
    async execute(args) {
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

      return await runner.runWsl(command, {
        distro: args.distro,
        workdir: args.workdir,
        env: args.env,
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
