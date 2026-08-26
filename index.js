// dsh-wsl: model-facing WSL tool. Executes a Linux command through wsl.exe
// and returns stdout/stderr. Each call runs in a fresh `bash -lc` inside the
// configured distribution, so no state persists between calls.
//
// This plugin publishes nothing and only consumes the host-plane `subprocess`
// and `tools` registries, so it sits loose in an agent preset without a realm.

const DEFAULT_DISTRO = 'Ubuntu-22.04'
const DEFAULT_WORKDIR = '~'
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_SPILL_BYTES = 64 * 1024 * 1024
const GRACE_MS = 3000

function formatResult(value) {
  let body = value.stdout || ''
  if (value.stderr && value.stderr.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${value.stderr}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (value.truncated) markers.push('[output truncated]')
  if (value.signal !== null && value.signal !== undefined) markers.push(`[killed by signal: ${value.signal}]`)
  else if (value.exitCode !== 0 && value.exitCode !== null) markers.push(`[exit code: ${value.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

export const name = 'tool-wsl'
export const inject = ['tools', 'subprocess']

export function apply(ctx) {
  const tool = {
    name: 'wsl',
    description:
      `Execute a Linux command through WSL (wsl.exe -d ${DEFAULT_DISTRO} -e bash -lc) and return its stdout/stderr. ` +
      `Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass \`workdir\` (a WSL/Linux path, default \`~\`) or \`cd\` inside the command instead. ` +
      `The command runs on the Linux side, so use Linux paths (\`/home/xiny/...\`), not Windows paths. ` +
      `Non-zero exits are reported as \`[exit code: N]\`. Long output is truncated to its tail. ` +
      `Set a \`timeoutMs\` to bound long-running commands.`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The Linux command to execute inside WSL.',
        },
        description: {
          type: 'string',
          description:
            'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds. The process is killed on expiry.',
        },
        workdir: {
          type: 'string',
          description: `Working directory inside WSL (a Linux path). Defaults to \`~\` (the WSL home directory).`,
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
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['exitCode', 'signal', 'stdout', 'stderr', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: formatResult(value) }],
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
      const workdir = args.workdir !== undefined && args.workdir.length > 0 ? args.workdir : DEFAULT_WORKDIR
      const command = `cd ${workdir} && ${args.command}`

      const controller = new AbortController()
      const timer = args.timeoutMs !== undefined ? setTimeout(() => controller.abort(), args.timeoutMs) : null
      try {
        const handle = ctx.subprocess.spawn({
          argv: ['wsl.exe', '-d', DEFAULT_DISTRO, '-e', 'bash', '-lc', command],
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
            stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
          },
          graceMs: GRACE_MS,
          signal: controller.signal,
        })
        const outcome = await handle.done
        const stdout = handle.collected.stdout.readFrom(0)
        const stderr = handle.collected.stderr.readFrom(0)
        return {
          exitCode: outcome.exitCode ?? null,
          signal: outcome.signal ?? null,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: stdout.lossy || stderr.lossy,
        }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: args.command,
      description: args.description,
      ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
    }),
  }

  ctx.tools.register(tool)
}
