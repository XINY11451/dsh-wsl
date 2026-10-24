import { windowsPathToWsl } from '../paths.js'
import { formatSize, parseHeader, reasonOf, writeScript } from '../fs-ops.js'
import { assertRootAllowed, checkAsRootArgument } from '../root.js'

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
          resolvedPath: { type: 'string' },
          sizeBytes: { type: 'integer' },
          created: { type: 'boolean' },
          asRoot: { type: 'boolean' },
        },
        required: ['path', 'resolvedPath', 'sizeBytes', 'created', 'asRoot'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.resolvedPath}  [${value.created ? 'created' : 'replaced'}, ${formatSize(value.sizeBytes)}` +
          `${value.asRoot === true ? ', as root' : ''}]`,
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
        path: target,
        // The rest of the line is the path: it may itself contain spaces.
        resolvedPath: header.fields.slice(1).join(' '),
        sizeBytes: Buffer.byteLength(args.content, 'utf8'),
        created: header.fields[0] !== '1',
        asRoot: args.asRoot === true,
      }
    },
    // A write has no before-image to diff against, and the platform's own `write`
    // draws the same card for that reason: the content is the whole file, so every
    // line is an addition. `oldText: null` is how `FileDiff` says "there is no old
    // side" -- which, as in the host's write, is also how an overwrite is drawn.
    //
    // No `presentationMeta`: the card is built from the arguments, which a replay
    // still has, so there is nothing to store with the result.
    presentCall: (args) => ({
      card: 'diff',
      title: `Write ${args.path}`,
      diffs: [{
        path: args.path,
        oldText: null,
        newText: typeof args.content === 'string' ? args.content : '',
      }],
      locations: [{ path: args.path }],
    }),
    presentResult(args, result) {
      if (result.isError) return undefined
      return {
        card: 'diff',
        title: `Write ${args.path}`,
        diffs: [{
          path: args.path,
          oldText: null,
          newText: typeof args.content === 'string' ? args.content : '',
        }],
      }
    },
  }
}
