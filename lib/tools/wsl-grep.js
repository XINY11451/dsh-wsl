import { windowsPathToWsl } from '../paths.js'
import { grepScript, parseGrepZ, parseHeader, parseRgJson, previewLine, reasonOf } from '../fs-ops.js'
import { assertRootAllowed, checkAsRootArgument } from '../root.js'

// The platform's `grep` tool caps a call at 250 matches and 2000 bytes per
// previewed line. Matching those numbers matters more than they look: the model
// already knows how much a `grep` result costs, and a `wsl-grep` that returned
// ten thousand lines would be a different tool wearing the same name.
const MAX_MATCHES = 250
const MAX_LINE_BYTES = 2000
const SEARCH_WINDOW_BYTES = 1 << 20

export function createWslGrepTool({ config, runner }) {
  return {
    name: 'wsl-grep',
    description:
      'Search file contents inside the WSL distribution with a ripgrep regular expression and return the matching ' +
      'lines with their line numbers, grouped by file. `path` is a Linux path: `~` expands to the distribution ' +
      "user's home and a relative path resolves against the calling session's workspace. Uses `rg` when the " +
      'distribution has it and GNU `grep -E` otherwise, so the pattern must be valid in both (no lookaround, no ' +
      'backreferences). Returns up to 250 matches; a larger result is cut, and `wsl-read` on a matched file gives ' +
      'the surrounding context.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression to search for (ripgrep syntax).',
        },
        path: {
          type: 'string',
          description: "File or directory to search. Defaults to the calling session's workspace; a relative path resolves against it.",
        },
        include: {
          type: 'string',
          description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
        },
        distro: {
          type: 'string',
          description: 'Distribution name; omit for the default one.',
        },
        asRoot: {
          type: 'boolean',
          description: 'Search as root, to reach files the user cannot read. Refused unless 管理员模式 is on in the plugin settings.',
        },
      },
      required: ['pattern'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          include: { type: 'string' },
          engine: { type: 'string' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                lineNumber: { type: 'integer' },
                line: { type: 'string' },
              },
              required: ['path', 'lineNumber', 'line'],
            },
          },
          fileCount: { type: 'integer' },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
        required: ['pattern', 'path', 'engine', 'matches', 'fileCount', 'total', 'truncated'],
      },
      render: (_args, value) => {
        if (value.total === 0) return [{ type: 'text', text: 'No matches found' }]
        const header = value.truncated
          ? `Found ${value.matches.length} of ${value.total} matches`
          : `Found ${value.total} ${value.total === 1 ? 'match' : 'matches'}`
        const groups = new Map()
        for (const match of value.matches) {
          const group = groups.get(match.path)
          if (group === undefined) groups.set(match.path, [`Line ${match.lineNumber}: ${match.line}`])
          else group.push(`Line ${match.lineNumber}: ${match.line}`)
        }
        const body = [...groups].map(([path, rows]) => `${path}\n${rows.join('\n')}`).join('\n\n')
        const footer = value.truncated
          ? `\n\n(Only the first ${value.matches.length} matches are shown; narrow ` +
            '`pattern`, `path`, or `include` to see the rest.)'
          : ''
        return [{ type: 'text', text: `${header}\n\n${body}${footer}` }]
      },
    },
    async execute(args, exec) {
      const pattern = validatePattern(args.pattern)
      if (args.path !== undefined && (typeof args.path !== 'string' || args.path.trim().length === 0)) {
        throw new Error('wsl-grep: path must be a non-empty string when given')
      }
      if (args.include !== undefined) validateInclude(args.include)
      if (args.distro !== undefined && typeof args.distro !== 'string') {
        throw new Error('wsl-grep: distro must be a string')
      }
      checkAsRootArgument('wsl-grep', args.asRoot)
      assertRootAllowed(config, 'wsl-grep', args.asRoot)

      const target = config.translatePaths ? windowsPathToWsl(args.path ?? '.') : (args.path ?? '.')
      const result = await runner.runWsl(grepScript({ path: target, pattern, include: args.include }), {
        distro: args.distro,
        exec,
        asRoot: args.asRoot === true,
        outputBytes: Math.max(config.maxOutputBytes, SEARCH_WINDOW_BYTES),
      })
      if (result.exitCode !== 0) {
        throw new Error(`wsl-grep: ${target}: ${reasonOf(result)}`)
      }
      const header = parseHeader(result.stdout)
      if (header === null) {
        throw new Error(`wsl-grep: ${target}: the search produced no header line (exit code 0)`)
      }
      const engine = header.fields[0]
      if (engine !== 'rg' && engine !== 'grep') {
        throw new Error(`wsl-grep: ${target}: the header line named an unknown engine`)
      }
      const found = (engine === 'rg' ? parseRgJson(header.body) : parseGrepZ(header.body))
        .map((match) => ({
          path: displayPath(match.file),
          lineNumber: match.line,
          line: previewLine(match.text, MAX_LINE_BYTES),
        }))
      // Every match the search printed is counted, so `total` is what the tree
      // held rather than what this call chose to keep.
      const total = found.length
      const matches = found.slice(0, MAX_MATCHES)
      return {
        pattern,
        path: target,
        ...(args.include === undefined ? {} : { include: args.include }),
        engine,
        matches,
        fileCount: new Set(matches.map((match) => match.path)).size,
        total,
        truncated: total > matches.length || result.truncated === true,
      }
    },
    presentCall: (args) => {
      const where = args.path === undefined ? '' : ` in ${args.path}`
      const filter = args.include === undefined ? '' : ` (${args.include})`
      return { card: 'generic', kind: 'search', title: `Grep ${args.pattern}${where}${filter}` }
    },
  }
}

function validatePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('wsl-grep: pattern must be a non-empty string')
  }
  return pattern
}

/**
 * Reject an `include` that is not ONE positive glob filter, the same contract the
 * platform `grep` enforces: `rg --glob` and `grep --include` both take one
 * pattern, so a comma-separated list would silently search the wrong files.
 */
function validateInclude(include) {
  if (typeof include !== 'string' || include.trim().length === 0) {
    throw new Error('wsl-grep: include must be a non-empty glob when given')
  }
  if (include.startsWith('!')) {
    throw new Error('wsl-grep: include must be a positive glob filter; negated patterns ("!…") are not supported')
  }
  let depth = 0
  for (const char of include) {
    if (char === '{') depth += 1
    else if (char === '}') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) {
      throw new Error('wsl-grep: include must be one glob, not a comma-separated list (use {a,b} alternation instead)')
    }
  }
}

/**
 * The path a match is reported under. Both engines echo the target back as it was
 * given, so a search of `.` answers `./src/a.ts`; the leading `./` is dropped
 * because it is noise the caller did not ask for.
 */
function displayPath(path) {
  return path.startsWith('./') ? path.slice(2) : path
}
