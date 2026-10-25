import { windowsPathToWsl } from '../paths.js'
import { parseHeader, readScript, reasonOf } from '../fs-ops.js'
import { assertRootAllowed, checkAsRootArgument } from '../root.js'

// The window a single read may occupy. The configured `maxOutputBytes` is sized
// for a command's console output; a file is not console output, and a 64 KiB
// ceiling would cut an ordinary source file in half and make `offset` paging
// guesswork. A host that raised the configured value still wins, so this is a
// floor and not a cap.
const READ_WINDOW_BYTES = 1 << 20

// The same default and ceiling the host's `read` uses, for the same reason: a
// wider window is context the caller did not ask for. `limit` above the cap is
// refused instead of clamped, so a caller that asked for 5000 lines learns why
// it got 2000 rather than silently losing the rest.
const READ_LIMIT = 2000

/**
 * The footer line that closes the read window, worded exactly as the host's
 * `read` words it, so the model reads one format whichever world the file is in.
 * @param window - the returned window: 1-based first line, the lines, the file's line count, and whether bytes capped it.
 * @returns the parenthesised footer.
 */
function readFooter({ offset, lines, totalLines, truncatedByBytes }) {
  const endLine = lines.at(-1)?.number ?? Math.max(0, offset - 1)
  if (truncatedByBytes) {
    return `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  }
  if (endLine < totalLines) {
    return `(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`
  }
  return `(End of file - total ${totalLines} lines)`
}

/**
 * Render the model-facing read envelope: the host's `<path>/<type>/<content>`
 * wrapper around the numbered window and its footer.
 * @param path - the resolved path shown in `<path>`.
 * @param window - the returned window (see {@link readFooter}).
 * @returns the model-facing text block.
 */
function formatReadOutput(path, window) {
  const footer = readFooter(window)
  const body = window.lines.length > 0
    ? `${window.lines.map((line) => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

/**
 * Split the script's selected text into numbered lines.
 *
 * A capped window can end mid-line, and half a line is worse than one line
 * fewer: the partial tail is dropped and the footer says the output was capped.
 * @param body - the script's selected text, newline-terminated when complete.
 * @param offset - the 1-based number of the first line.
 * @param capped - whether the output window cut the text.
 * @returns the lines and whether bytes (rather than `limit`) ended the window.
 */
function toLines(body, offset, capped) {
  let text = body
  if (capped) {
    const lastBreak = text.lastIndexOf('\n')
    text = lastBreak >= 0 ? text.slice(0, lastBreak) : ''
  }
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = trimmed.length === 0 ? [] : trimmed.split('\n')
  return {
    lines: lines.map((line, index) => ({ number: offset + index, text: line })),
    truncatedByBytes: capped,
  }
}

export function createWslReadTool({ config, runner }) {
  return {
    name: 'wsl-read',
    description:
      'Read a UTF-8 text file inside the WSL distribution and return line-numbered content. ' +
      '`path` is a Linux path: `~` expands to the distribution user\'s home and a relative path ' +
      'resolves against the calling session\'s workspace. `offset` is the 1-based first line and `limit` ' +
      'the number of lines to return, so a large file is paged rather than truncated. ' +
      'The read fails loudly for a directory, a binary file, or one that is not valid UTF-8 text — for ' +
      'those, use the `wsl` tool (`file`, `od`, `iconv`) instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to read inside the distribution. `~` and relative paths are resolved there.',
        },
        offset: {
          type: 'number',
          description: '1-based first line to return. Defaults to 1.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.`,
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
          offset: { type: 'integer' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                number: { type: 'integer' },
                text: { type: 'string' },
              },
              required: ['number', 'text'],
            },
          },
          totalLines: { type: 'integer' },
        },
        required: ['path', 'offset', 'lines', 'totalLines'],
      },
      render: (args, value) => {
        const limit = args.limit === undefined ? READ_LIMIT : args.limit
        const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
        const truncatedByBytes = value.lines.length < limit && endLine < value.totalLines
        return [{
          type: 'text',
          text: formatReadOutput(value.path, {
            offset: value.offset,
            lines: value.lines,
            totalLines: value.totalLines,
            truncatedByBytes,
          }),
        }]
      },
      // The window in persisted `meta`, so a UI's read card survives replay: the
      // canonical output object is not on the wire, only the model-facing text.
      presentationMeta: (_args, value) => ({
        path: value.path,
        offset: value.offset,
        lines: value.lines.map(({ number, text }) => ({ number, text })),
        totalLines: value.totalLines,
      }),
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) {
        throw new Error('path must be a non-empty string')
      }
      if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 1)) {
        throw new Error('offset must be a positive integer')
      }
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
        throw new Error('limit must be a positive integer')
      }
      if (args.limit !== undefined && args.limit > READ_LIMIT) {
        throw new Error(`limit must be less than or equal to ${READ_LIMIT}`)
      }
      if (args.distro !== undefined && typeof args.distro !== 'string') {
        throw new Error('wsl-read: distro must be a string')
      }
      checkAsRootArgument('wsl-read', args.asRoot)
      assertRootAllowed(config, 'wsl-read', args.asRoot)

      const target = config.translatePaths ? windowsPathToWsl(args.path) : args.path
      const offset = args.offset ?? 1
      const limit = args.limit ?? READ_LIMIT
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
      const totalLines = Number(header.fields[1])
      if (!Number.isInteger(totalLines)) {
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
      const window = toLines(header.body, offset, result.truncated === true)
      return {
        path: target,
        offset,
        lines: window.lines,
        totalLines,
      }
    },
    // Result-time display: a `read` card carrying the numbered window a capable
    // UI renders as a code view. The structured data comes from the persisted
    // `meta`; a malformed or absent one declines to `undefined` (generic fallback)
    // rather than throwing on replay of obsolete logged output.
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = result.meta
      if (meta === null || typeof meta !== 'object' || !Array.isArray(meta.lines)) return undefined
      if (typeof meta.path !== 'string' || !Number.isInteger(meta.offset) || !Number.isInteger(meta.totalLines)) {
        return undefined
      }
      const window = {
        offset: meta.offset,
        lines: meta.lines.filter((line) => typeof line?.number === 'number' && typeof line?.text === 'string'),
        totalLines: meta.totalLines,
        truncatedByBytes: false,
      }
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: window.lines,
        totalLines: meta.totalLines,
        content: [{ type: 'text', text: window.lines.map((line) => `${line.number}: ${line.text}`).join('\n') }],
      }
    },
    // Pure display: a generic card titled by the file with the read window
    // appended, and a follow-along location whose line is the read's offset.
    presentCall(args) {
      const { offset, limit } = args
      const window = limit !== undefined && limit > 0
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Read ${args.path}${window}`,
        kind: 'read',
        locations: [{ path: args.path, line: offset ?? 1 }],
      }
    },
  }
}
