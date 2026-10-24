import { windowsPathToWsl } from '../paths.js'
import { formatSize, parseHeader, readScript, reasonOf, writeScript } from '../fs-ops.js'
import { computeHunks } from '../hunks.js'
import { assertRootAllowed, checkAsRootArgument } from '../root.js'

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
        asRoot: {
          type: 'boolean',
          description: 'Edit as root. Refused unless 管理员模式 is on in the plugin settings. The file keeps ' +
            'its owner, so editing as root does not hand the file to root.',
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
          // The applied change, for the UI's diff card. It is part of the result
          // rather than something the presenter recomputes, because only `execute`
          // still has the before-image: a replayed card must not need the file.
          diffs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                oldText: { type: 'string' },
                newText: { type: 'string' },
              },
              required: ['path', 'oldText', 'newText'],
            },
          },
          asRoot: { type: 'boolean' },
        },
        required: ['path', 'resolvedPath', 'replacements', 'beforeBytes', 'afterBytes', 'diffs', 'asRoot'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.resolvedPath}  [${value.replacements} replacement${value.replacements === 1 ? '' : 's'}, ` +
          `${formatSize(value.beforeBytes)} → ${formatSize(value.afterBytes)}` +
          `${value.asRoot === true ? ', as root' : ''}]`,
      }],
      // The UI redraws the diff from this on replay; the model-facing text above
      // is unaffected by it.
      presentationMeta: (_args, value) => ({ path: value.path, diffs: value.diffs }),
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
      checkAsRootArgument('wsl-edit', args.asRoot)
      assertRootAllowed(config, 'wsl-edit', args.asRoot)

      const target = config.translatePaths ? windowsPathToWsl(args.path) : args.path
      const distro = args.distro
      const asRoot = args.asRoot === true
      const read = await runner.runWsl(readScript(target, 1, ALL_LINES), {
        distro,
        exec,
        asRoot,
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

      const offsets = findOccurrences(content, args.oldString)
      const replacements = offsets.length
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
      // The hunks are computed from the same offsets that produced `next`, so the
      // card cannot describe a change the file did not receive.
      const diffs = computeHunks(
        target,
        content,
        args.replaceAll === true ? offsets : offsets.slice(0, 1),
        args.oldString,
        args.newString,
      )

      const write = await runner.runWsl(writeScript(target, { keepOwner: asRoot }), { distro, exec, asRoot, stdin: next })
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
        diffs,
        asRoot,
      }
    },
    // The pending card shows the replacement the caller asked for, straight from
    // the arguments; `presentResult` replaces it with the hunks that were applied.
    presentCall: (args) => ({
      card: 'diff',
      title: `Edit ${args.path}`,
      diffs: [{
        path: args.path,
        // A presenter runs on replay too, against whatever the log holds: a missing
        // side is `null`/empty rather than `undefined`, which is what `FileDiff` says.
        oldText: typeof args.oldString === 'string' && args.oldString.length > 0 ? args.oldString : null,
        newText: typeof args.newString === 'string' ? args.newString : '',
      }],
      locations: [{ path: args.path }],
    }),
    presentResult(args, result) {
      if (result.isError) return undefined
      const meta = result.meta
      if (meta === null || typeof meta !== 'object' || !Array.isArray(meta.diffs)) return undefined
      return { card: 'diff', title: `Edit ${args.path}`, diffs: meta.diffs }
    },
  }
}

/** Start offsets of every non-overlapping occurrence of `needle` in `haystack`. */
function findOccurrences(haystack, needle) {
  const offsets = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return offsets
    offsets.push(at)
    from = at + needle.length
  }
}
