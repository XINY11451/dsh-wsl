import { windowsPathToWsl } from '../paths.js'
import { formatSize, parseHeader, reasonOf, writeScript } from '../fs-ops.js'

export function createWslWriteTool({ config, runner }) {
  return {
    name: 'wsl-write',
    description:
      'Write a text file inside the WSL distribution, replacing it if it already exists. `path` is a Linux ' +
      'path: `~` expands to the distribution user\'s home and a relative path resolves against the calling ' +
      'session\'s workspace. Missing parent directories are created, and an existing file keeps its mode. ' +
      'The bytes are written to a temporary file in the same directory and renamed over the target, so a ' +
      'failed write never leaves a half-written file behind. The whole content is replaced — use `wsl-edit` ' +
      'to change part of a file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Linux path of the file to write. `~` and relative paths are resolved inside the distribution.',
        },
        content: {
          type: 'string',
          description: 'The complete new contents of the file. May be empty.',
        },
        distro: {
          type: 'string',
          description: 'Distribution name; omit for the default one.',
        },
      },
      required: ['path', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          resolvedPath: { type: 'string' },
          sizeBytes: { type: 'integer' },
          created: { type: 'boolean' },
        },
        required: ['path', 'resolvedPath', 'sizeBytes', 'created'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.resolvedPath}  [${value.created ? 'created' : 'replaced'}, ${formatSize(value.sizeBytes)}]`,
      }],
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) {
        throw new Error('wsl-write: path must be a non-empty string')
      }
      if (typeof args.content !== 'string') {
        throw new Error('wsl-write: content must be a string')
      }
      if (args.distro !== undefined && typeof args.distro !== 'string') {
        throw new Error('wsl-write: distro must be a string')
      }

      const target = config.translatePaths ? windowsPathToWsl(args.path) : args.path
      // The content travels on stdin, never on the command line: it may be
      // megabytes, it may contain quotes, newlines or NULs, and none of that
      // survives an argv round trip through `wsl.exe`.
      const result = await runner.runWsl(writeScript(target), {
        distro: args.distro,
        exec,
        stdin: args.content,
      })
      if (result.exitCode !== 0) {
        throw new Error(`wsl-write: ${target}: ${reasonOf(result)}`)
      }
      const header = parseHeader(result.stdout)
      if (header === null || header.fields.length < 2) {
        throw new Error(`wsl-write: ${target}: the write produced no header line (exit code 0)`)
      }
      return {
        path: target,
        // The rest of the line is the path: it may itself contain spaces.
        resolvedPath: header.fields.slice(1).join(' '),
        sizeBytes: Buffer.byteLength(args.content, 'utf8'),
        created: header.fields[0] !== '1',
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Write ${args.path}` }),
  }
}
