import { windowsPathToWsl } from '../paths.js'
import { formatSize, parseHeader, readScript, reasonOf, writeScript } from '../fs-ops.js'

// A replacement is done in memory, so the file has to fit: this is the point
// where "edit a file" stops being cheaper than "run sed inside the
// distribution", and a larger file is refused rather than loaded.
const EDIT_LIMIT_BYTES = 2 << 20

// `sed` is asked for every line, and the number is a real one rather than
// `$` so the script stays the same shape as every other read.
const ALL_LINES = 2147483647

export function createWslEditTool({ config, runner }) {
  return {
    name: 'wsl-edit',
    description:
      'Replace an exact string inside a text file in the WSL distribution. `oldString` must match the file ' +
      'byte for byte — including indentation and line endings — and must be unique unless `replaceAll` is ' +
      'true; a partial or ambiguous match is refused rather than guessed at. The file is read whole, so it ' +
      'must be valid UTF-8 text no larger than 2 MiB, and it keeps its mode. To create or overwrite a file, ' +
      'use `wsl-write`.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Linux path of the file to edit. `~` and relative paths are resolved inside the distribution.',
        },
        oldString: {
          type: 'string',
          description: 'The exact text to replace. Must be non-empty and must appear in the file.',
        },
        newString: {
          type: 'string',
          description: 'The replacement text. May be empty, which deletes the match.',
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring exactly one. Defaults to false.',
        },
        distro: {
          type: 'string',
          description: 'Distribution name; omit for the default one.',
        },
      },
      required: ['path', 'oldString', 'newString'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          resolvedPath: { type: 'string' },
          replacements: { type: 'integer' },
          beforeBytes: { type: 'integer' },
          afterBytes: { type: 'integer' },
        },
        required: ['path', 'resolvedPath', 'replacements', 'beforeBytes', 'afterBytes'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.resolvedPath}  [${value.replacements} replacement${value.replacements === 1 ? '' : 's'}, ` +
          `${formatSize(value.beforeBytes)} → ${formatSize(value.afterBytes)}]`,
      }],
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) {
        throw new Error('wsl-edit: path must be a non-empty string')
      }
      if (typeof args.oldString !== 'string' || args.oldString.length === 0) {
        throw new Error('wsl-edit: oldString must be a non-empty string')
      }
      if (typeof args.newString !== 'string') {
        throw new Error('wsl-edit: newString must be a string')
      }
      if (args.replaceAll !== undefined && typeof args.replaceAll !== 'boolean') {
        throw new Error('wsl-edit: replaceAll must be a boolean')
      }
      if (args.distro !== undefined && typeof args.distro !== 'string') {
        throw new Error('wsl-edit: distro must be a string')
      }
      if (args.oldString === args.newString) {
        throw new Error('wsl-edit: oldString and newString are identical, so there is nothing to change')
      }

      const target = config.translatePaths ? windowsPathToWsl(args.path) : args.path
      const distro = args.distro
      const read = await runner.runWsl(readScript(target, 1, ALL_LINES), {
        distro,
        exec,
        outputBytes: EDIT_LIMIT_BYTES + 8192,
      })
      if (read.exitCode !== 0) {
        throw new Error(`wsl-edit: ${target}: ${reasonOf(read)}`)
      }
      const header = parseHeader(read.stdout)
      if (header === null) {
        throw new Error(`wsl-edit: ${target}: the read produced no header line (exit code 0)`)
      }
      const beforeBytes = Number(header.fields[0])
      if (!Number.isInteger(beforeBytes)) {
        throw new Error(`wsl-edit: ${target}: the header line was not understood`)
      }
      if (read.truncated === true || beforeBytes > EDIT_LIMIT_BYTES) {
        throw new Error(
          `wsl-edit: ${target}: ${formatSize(beforeBytes)} is over the ${formatSize(EDIT_LIMIT_BYTES)} limit ` +
          'for an in-memory replacement. Use the `wsl` tool (`sed -i`, or a short script) for a file this size.',
        )
      }
      if (header.body.includes('\u0000')) {
        throw new Error(
          `wsl-edit: ${target}: looks like a binary file (it contains NUL bytes). ` +
          'Use the `wsl` tool (`sed -i`, `perl -pi`) to change it.',
        )
      }
      // The decoded text must re-encode to exactly the bytes that are on disk.
      // That is true for valid UTF-8 and false for everything else, which makes
      // this the one check that guarantees an edit cannot corrupt a file it did
      // not fully understand — the failure mode a lenient decoder would hide.
      const content = header.body
      const decodedBytes = Buffer.byteLength(content, 'utf8')
      if (decodedBytes !== beforeBytes) {
        throw new Error(
          `wsl-edit: ${target}: ${beforeBytes} bytes on disk but ${decodedBytes} after decoding, ` +
          'so the file is not valid UTF-8 text. Refusing to rewrite it; use the `wsl` tool instead.',
        )
      }

      const replacements = countOccurrences(content, args.oldString)
      if (replacements === 0) {
        throw new Error(`wsl-edit: ${target}: the text to replace was not found`)
      }
      if (replacements > 1 && args.replaceAll !== true) {
        throw new Error(
          `wsl-edit: ${target}: the text to replace appears ${replacements} times. ` +
          'Pass a longer, unambiguous string, or set `replaceAll: true`.',
        )
      }
      // A function replacement, not a string one: `$&` and friends in
      // `newString` are text the caller asked to insert, not patterns.
      const next = args.replaceAll === true
        ? content.split(args.oldString).join(args.newString)
        : content.replace(args.oldString, () => args.newString)

      const write = await runner.runWsl(writeScript(target), { distro, exec, stdin: next })
      if (write.exitCode !== 0) {
        throw new Error(`wsl-edit: ${target}: the write failed: ${reasonOf(write)}`)
      }
      const written = parseHeader(write.stdout)
      if (written === null || written.fields.length < 2) {
        throw new Error(`wsl-edit: ${target}: the write produced no header line (exit code 0)`)
      }
      return {
        path: target,
        resolvedPath: written.fields.slice(1).join(' '),
        replacements: args.replaceAll === true ? replacements : 1,
        beforeBytes,
        afterBytes: Buffer.byteLength(next, 'utf8'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Edit ${args.path}` }),
  }
}

/** How many non-overlapping occurrences of `needle` are in `haystack`. */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}
