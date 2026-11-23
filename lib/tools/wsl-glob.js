import { windowsPathToWsl } from '../paths.js'
import {
  GLOB_ERROR,
  GLOB_MAX_RESULTS,
  GLOB_WINDOW_BYTES,
  globScript,
  parseGlobOutput,
  renderGlob,
  validatePattern,
} from '../glob.js'

/**
 * The platform `glob` tool, pointed at a distribution.
 *
 * Discovery was the one file operation `wsl-grep` could not stand in for: a search
 * needs content to match, so listing a tree went through `wsl` (`find` / `rg --files`
 * text the model then parsed) or through the `\\wsl.localhost` share, which is 9p —
 * slow, and denied on the root-owned directories a distribution has everywhere.
 * @param ctx - plugin context; read only for the optional `spillStore` service.
 * @param config - resolved configuration (see `resolveConfig`).
 * @param runner - the mount's runner (see `createRunner`).
 */
export function createWslGlobTool({ ctx, config, runner }) {
  return {
    name: 'wsl-glob',
    description:
      'List files inside the WSL distribution whose names match a glob pattern and return the matching paths ' +
      'only, sorted by modification time (oldest first). `path` is a Linux path: `~` expands to the distribution user\'s home ' +
      "and a relative path resolves against the calling session's workspace. Uses `rg --files` when the " +
      'distribution has it; without ripgrep only basename patterns (no "/") work, through a GNU `find` ' +
      'fallback. Hidden files are included and VCS metadata is skipped. Returns up to 100 paths; a larger ' +
      'result is cut, and the paths that were read are saved to a file whose path the answer names (the ' +
      'complete list when the walk itself was not capped).',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g. "*.ts", "**/*.test.js"). A pattern without "/" matches the base name at any depth; a slash-anchored one ("src/*.ts") is relative to the session workspace, exactly like the platform glob. Without ripgrep, only a basename pattern (optionally prefixed with "**/") is accepted.',
        },
        path: {
          type: 'string',
          description: "Directory to list beneath. Defaults to the calling session's workspace; a relative path resolves against it.",
        },
        distro: {
          type: 'string',
          description: 'Distribution name; omit for the default one.',
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
          engine: { type: 'string' },
          files: {
            type: 'array',
            items: { type: 'string' },
          },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          partial: { type: 'boolean' },
          spillPath: { type: 'string' },
          spillComplete: { type: 'boolean' },
          savedCount: { type: 'integer' },
          shown: { type: 'integer' },
        },
        required: ['pattern', 'path', 'engine', 'files', 'total', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: renderGlob(value) }],
    },
    async execute(args, exec) {
      const pattern = validatePattern(args.pattern)
      if (args.path !== undefined && (typeof args.path !== 'string' || args.path.trim().length === 0)) {
        throw new Error('wsl-glob: path must be a non-empty string when given')
      }
      if (args.distro !== undefined && typeof args.distro !== 'string') {
        throw new Error('wsl-glob: distro must be a string')
      }
      // Refused, not ignored: the other file tools REQUIRE the panel switch before
      // `asRoot` does anything, and silently downgrading an elevated request to the
      // user account is the one failure mode they go out of their way to avoid.
      if (args.asRoot !== undefined && typeof args.asRoot !== 'boolean') {
        throw new Error('wsl-glob: asRoot must be a boolean')
      }
      if (args.asRoot === true) {
        throw new Error(
          'wsl-glob: asRoot is not supported — listing needs no elevated read; ' +
          'use wsl-read or wsl-grep with asRoot for protected paths',
        )
      }

      const target = config.translatePaths ? windowsPathToWsl(args.path ?? '.') : (args.path ?? '.')
      const result = await runner.runWsl(globScript({ path: target, pattern, maxBytes: GLOB_WINDOW_BYTES }), {
        distro: args.distro,
        exec,
        outputBytes: GLOB_WINDOW_BYTES + 8192,
        // Discovery is bounded like the platform glob's 30 s: a walk of `/` must not
        // hang the call (or buffer an unbounded list) just because it was asked for.
        timeoutMs: config.internalTimeoutMs,
      })
      if (result.exitCode !== 0) {
        throw new Error(`wsl-glob: ${target}: ${scriptReason(result)}`)
      }
      const parsed = parseGlobOutput(result.stdout)
      if (parsed === null) {
        throw new Error(`wsl-glob: ${target}: the listing produced no header line`)
      }
      // `total` counts the whole walk, so it can exceed the 100 paths this call
      // keeps; `capped` means even the buffered body was cut. Either way the answer
      // is incomplete, and the spill below is where the rest lives.
      const files = parsed.files.slice(0, GLOB_MAX_RESULTS)
      const shown = files.length
      const truncated = parsed.capped || parsed.total > shown || result.truncated === true
      const value = {
        pattern,
        path: target,
        engine: parsed.engine,
        files,
        total: parsed.total,
        truncated,
        partial: parsed.partial,
        shown,
      }

      if (truncated) {
        const spillStore = ctx?.get?.('spillStore')
        const agentId = exec?.agent?.id
        if (typeof spillStore?.saveText === 'function' && agentId) {
          try {
            const ref = await spillStore.saveText({
              owner: { sessionId: agentId },
              source: {
                kind: 'tool',
                toolName: 'wsl-glob',
                callId: String(exec.callId ?? ''),
                label: `wsl-glob ${pattern}`,
              },
              suggestedName: 'wsl-glob.txt',
              content: parsed.files.join('\n'),
            })
            const locator = ref?.locator
            if (locator !== undefined && locator !== null) {
              value.spillPath = String(locator)
              // The file holds every record this side received, which can be more
              // than the 100 inline paths, but fewer than `total` when the byte
              // window cut the walk — the footer names the saved count too.
              value.savedCount = parsed.files.length
              // `result.truncated` is the provider's own loss (the body did not fit
              // the read window); the script caps the body before that happens, but
              // a host that truncates anyway must not be called complete either.
              value.spillComplete = parsed.capped !== true && result.truncated !== true
            }
          } catch {
            // Spilling is best effort: storage must not fail a listing that already
            // succeeded, and the inline footer still says the rest is missing.
          }
        }
      }
      return value
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'search',
      title: `Glob ${args.pattern}${args.path === undefined ? '' : ` in ${args.path}`}`,
    }),
  }
}

/**
 * The one line worth showing when the script refused.
 *
 * The script tags its own messages with `wsl-glob: ` and the tool prefixes
 * `wsl-glob: <path>:`, so the tag is stripped here — otherwise one failure would
 * read as two nested ones. The runner already removes wsl.exe's known launcher
 * noise, so the first remaining line is the script's own reason; a launcher that
 * died before printing one is reported by its exit code.
 */
function scriptReason(result) {
  const lines = String(result.stderr ?? '')
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text !== '')
  // The tagged line is the script's own reason; a launcher warning may precede it,
  // and taking the first line blindly reported that warning as the cause (the same
  // trap `wsl-grep`'s reasonOf fixes on its side).
  const tagged = lines.find((text) => text.startsWith(GLOB_ERROR))
  if (tagged !== undefined) return tagged.slice(GLOB_ERROR.length)
  if (lines.length > 0) return lines[0]
  return `exit code ${result.exitCode}`
}
