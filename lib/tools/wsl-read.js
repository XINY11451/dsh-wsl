import { windowsPathToWsl } from '../paths.js'
import { countLines, formatSize, parseHeader, readScript, reasonOf } from '../fs-ops.js'
import { assertRootAllowed, checkAsRootArgument } from '../root.js'

// The window a single read may occupy. The configured `maxOutputBytes` is sized
// for a command's console output; a file is not console output, and a 64 KiB
// ceiling would cut an ordinary source file in half and make `offset` paging
// guesswork. A host that raised the configured value still wins, so this is a
// floor and not a cap.
const READ_WINDOW_BYTES = 1 << 20
const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 100000

export function createWslReadTool({ config, runner }) {
  return {
    name: 'wsl-read',
    description:
      'Read a text file from inside the WSL distribution and return its contents as they are on disk ' +
      '(no line numbers are added). `path` is a Linux path: `~` expands to the distribution user\'s home ' +
      'and a relative path resolves against the calling session\'s workspace. `offset` is the 1-based first ' +
      'line and `limit` the number of lines to return, so a large file is paged rather than truncated. ' +
      'The read fails loudly for a directory, a binary file, or a file that is not valid UTF-8 text — for ' +
      'those, use the `wsl` tool (`file`, `od`, `iconv`) instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Linux path of the file to read. `~` and relative paths are resolved inside the distribution.',
        },
        offset: {
          type: 'integer',
          description: '1-based line number to start at. Defaults to 1.',
        },
        limit: {
          type: 'integer',
          description: `How many lines to return. Defaults to ${DEFAULT_LIMIT}.`,
        },
        distro: {
          type: 'string',
          description: 'Distribution name; omit for the default one.',
        },
        asRoot: {
          type: 'boolean',
          description: 'Read as root. Refused unless 管理员模式 is on in the plugin settings.',
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          sizeBytes: { type: 'integer' },
          totalLines: { type: 'integer' },
          startLine: { type: 'integer' },
          lineCount: { type: 'integer' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
          asRoot: { type: 'boolean' },
        },
        required: ['path', 'sizeBytes', 'totalLines', 'startLine', 'lineCount', 'content', 'truncated', 'asRoot'],
      },
      render: (_args, value) => {
        const range = value.lineCount === 0
          ? `no lines at ${value.startLine}`
          : `lines ${value.startLine}-${value.startLine + value.lineCount - 1} of ${value.totalLines}`
        const cut = value.truncated ? ', output truncated — narrow it with `offset`/`limit`' : ''
        const who = value.asRoot === true ? ', as root' : ''
        return [{ type: 'text', text: `${value.path}  [${range}, ${formatSize(value.sizeBytes)}${who}${cut}]\n${value.content}` }]
      },
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) {
        throw new Error('wsl-read: path must be a non-empty string')
      }
      if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 1)) {
        throw new Error('wsl-read: offset must be an integer of at least 1')
      }
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
        throw new Error('wsl-read: limit must be an integer of at least 1')
      }
      if (args.distro !== undefined && typeof args.distro !== 'string') {
        throw new Error('wsl-read: distro must be a string')
      }
      checkAsRootArgument('wsl-read', args.asRoot)
      assertRootAllowed(config, 'wsl-read', args.asRoot)

      const target = config.translatePaths ? windowsPathToWsl(args.path) : args.path
      const offset = args.offset ?? 1
      const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
      const result = await runner.runWsl(readScript(target, offset, offset + limit - 1), {
        distro: args.distro,
        exec,
        asRoot: args.asRoot === true,
        outputBytes: Math.max(config.maxOutputBytes, READ_WINDOW_BYTES),
      })
      if (result.exitCode !== 0) {
        throw new Error(`wsl-read: ${target}: ${reasonOf(result)}`)
      }
      const header = parseHeader(result.stdout)
      if (header === null) {
        throw new Error(`wsl-read: ${target}: the read produced no header line (exit code 0)`)
      }
      const sizeBytes = Number(header.fields[0])
      const totalLines = Number(header.fields[1])
      if (!Number.isInteger(sizeBytes) || !Number.isInteger(totalLines)) {
        throw new Error(`wsl-read: ${target}: the header line was not understood`)
      }
      // A NUL byte is the cheapest reliable binary signal: text files do not
      // contain one, and decoding one as UTF-8 succeeds, so `iconv` cannot be
      // the check. Refused rather than returned with the NULs intact — a model
      // shown binary would try to read meaning into it.
      if (header.body.includes('\u0000')) {
        throw new Error(
          `wsl-read: ${target}: looks like a binary file (it contains NUL bytes). ` +
          'Use the `wsl` tool (`file`, `od`, `base64`) to inspect it.',
        )
      }

      return {
        path: target,
        sizeBytes,
        totalLines,
        startLine: offset,
        lineCount: countLines(header.body),
        content: header.body,
        truncated: result.truncated === true,
        asRoot: args.asRoot === true,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Read ${args.path}` }),
  }
}
