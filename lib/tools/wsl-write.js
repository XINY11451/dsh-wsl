import { windowsPathToWsl } from '../paths.js'
import { parseHeader, reasonOf, writeScript } from '../fs-ops.js'
import { assertRootAllowed, checkAsRootArgument } from '../root.js'

/**
 * Format the model-facing write acknowledgement, worded exactly as the host's
 * `write` words it. The file content is never echoed back: the caller supplied
 * it, so repeating it spends context to tell the model nothing.
 * @param path - the resolved path shown in `<path>`.
 * @param operation - `create` for a new file, `update` for a replacement.
 * @returns the model-facing text block.
 */
function formatWriteOutput(path, operation) {
  const verb = operation === 'create' ? 'Created' : 'Updated'
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${verb} file\n</content>`
}

export function createWslWriteTool({ config, runner }) {
  return {
    name: 'wsl-write',
    description:
      'Create or fully replace a UTF-8 text file inside the WSL distribution. `path` is a Linux path: ' +
      '`~` expands to the distribution user\'s home and a relative path resolves against the calling ' +
      'session\'s workspace. Missing parent directories are created, and an existing file keeps its mode. ' +
      'The bytes are written to a temporary file in the same directory and renamed over the target, so a ' +
      'failed write never leaves a half-written file behind. The whole content is replaced — use `wsl-edit` ' +
      'to change part of a file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to write inside the distribution. `~` and relative paths are resolved there.',
        },
        content: {
          type: 'string',
          description: 'Full UTF-8 text content to write.',
        },
        distro: {
          type: 'string',
          description: 'Distribution name; omit for the default one.',
        },
        asRoot: {
          type: 'boolean',
          description: 'Write as root. Refused unless 管理员模式 is on in the plugin settings. A file that ' +
            'already exists keeps its owner, so editing as root does not hand the file to root.',
        },
      },
      required: ['path', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'update'] },
          before: { type: ['string', 'null'] },
          after: { type: 'string' },
        },
        required: ['path', 'operation', 'before', 'after'],
      },
      render: (_args, value) => [{ type: 'text', text: formatWriteOutput(value.path, value.operation) }],
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) {
        throw new Error('path must be a non-empty string')
      }
      if (typeof args.content !== 'string') {
        throw new Error('content must be a string')
      }
      if (args.distro !== undefined && typeof args.distro !== 'string') {
        throw new Error('wsl-write: distro must be a string')
      }
      checkAsRootArgument('wsl-write', args.asRoot)
      assertRootAllowed(config, 'wsl-write', args.asRoot)

      const target = config.translatePaths ? windowsPathToWsl(args.path) : args.path
      // The content travels on stdin, never on the command line: it may be
      // megabytes, it may contain quotes, newlines or NULs, and none of that
      // survives an argv round trip through `wsl.exe`.
      const result = await runner.runWsl(writeScript(target, { keepOwner: args.asRoot === true }), {
        distro: args.distro,
        exec,
        asRoot: args.asRoot === true,
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
        // The rest of the line is the path: it may itself contain spaces.
        path: header.fields.slice(1).join(' '),
        operation: header.fields[0] === '1' ? 'update' : 'create',
        // A full-file write has no before-image without a second round trip, and
        // paying one per write to redraw a card is the wrong trade: `null` is the
        // documented "no old side", exactly what the host draws for an overwrite
        // it has not observed yet.
        before: null,
        after: args.content,
      }
    },
    // Pure display: the whole content is the file, so every line is an addition.
    // `oldText: null` is how `FileDiff` says there is no old side.
    presentCall(args) {
      const content = typeof args.content === 'string' ? args.content : ''
      return {
        card: 'diff',
        title: `Write ${args.path}`,
        diffs: [{ path: args.path, oldText: null, newText: content }],
        locations: [{ path: args.path }],
      }
    },
    // Result-time display repeats the diff because a completed view replaces the
    // pending one. Built from the arguments, which a replay still has.
    presentResult(args, result) {
      if (result.isError) return undefined
      const content = typeof args.content === 'string' ? args.content : ''
      return {
        card: 'diff',
        title: `Write ${args.path}`,
        diffs: [{ path: args.path, oldText: null, newText: content }],
      }
    },
  }
}
