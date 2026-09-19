// The `wsl-path` tool: convert a path with `wslpath` in either direction.

import { quotePath } from '../paths.js'

const WINDOWS_PATH_RE = /^[a-zA-Z]:[\\/]/
const UNC_PATH_RE = /^\\\\/

export function createWslPathTool({ config, runner }) {
  return {
    name: 'wsl-path',
    description:
      'Convert between Windows and WSL/Linux paths using `wslpath`. ' +
      'Pass a Windows path (e.g. `C:\\Users\\me\\a.txt`) to get its `/mnt/c/...` form, or a Linux path ' +
      '(e.g. `/home/me/a.txt`) to get its `\\\\wsl.localhost\\...` form. ' +
      'Use `direction` to force `win` or `linux`; leave it unset for auto-detection.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to convert.',
        },
        direction: {
          type: 'string',
          enum: ['auto', 'win', 'linux'],
          description: "Conversion direction: 'win' (Linux->Windows result) or 'linux' (Windows->WSL result). Default auto.",
        },
        distro: {
          type: 'string',
          description: 'WSL distribution to use. Defaults to the system default distribution.',
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          input: { type: 'string' },
          converted: { type: 'string' },
        },
        required: ['input', 'converted'],
      },
      render: (_args, value) => [{ type: 'text', text: `${value.input} -> ${value.converted}` }],
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim() === '') {
        throw new Error('wsl-path: path must be a non-empty string')
      }
      const looksWindows = WINDOWS_PATH_RE.test(args.path) || UNC_PATH_RE.test(args.path)
      const direction = args.direction === 'win' || args.direction === 'linux'
        ? args.direction
        : (looksWindows ? 'linux' : 'win')
      // wslpath -u <windows>  -> WSL path;  wslpath -w <linux>  -> Windows path
      const flag = direction === 'win' ? '-w' : '-u'
      const res = await runner.runWsl(`wslpath ${flag} ${quotePath(args.path)}`, {
        distro: args.distro,
        timeoutMs: config.internalTimeoutMs,
        exec,
      })
      if (res.exitCode !== 0) {
        const detail = (res.stderr || res.stdout).trim() || `exit code ${res.exitCode}`
        throw new Error(`wsl-path: wslpath failed: ${detail}`)
      }
      const converted = res.stdout.trim()
      if (converted === '') {
        throw new Error(`wsl-path: wslpath returned no path for ${JSON.stringify(args.path)}`)
      }
      return { input: args.path, converted }
    },
    presentCall: (args) => ({ card: 'text', title: args.path, description: 'path conversion' }),
  }
}
