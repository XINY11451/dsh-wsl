// dsh-wsl: model-facing WSL tools for DeepSeek Harness (DSH).
//
// Registers three tools:
//   - `wsl`      : run a Linux command through wsl.exe, return stdout/stderr
//                  with exit-code / signal / timeout / truncation markers.
//                  Supports workdir, timeoutMs, extra env vars, a configurable
//                  distro, automatic Windows->WSL path translation, and a guard
//                  that refuses destructive commands unless explicitly allowed.
//   - `wsl-path` : convert between Windows and WSL paths via `wslpath`.
//   - `wsl-env`  : summarize the WSL environment (distros, kernel, cpu, mem,
//                  disk) so an agent knows what it is running on.
//
// Each call runs in a fresh `bash -lc`, so no state persists between calls.
// This plugin publishes nothing and only consumes the host-plane `subprocess`
// and `tools` registries, so it sits loose in an agent preset without a realm.

const DEFAULT_DISTRO = 'Ubuntu-22.04'
const DEFAULT_WORKDIR = '~'
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_SPILL_BYTES = 64 * 1024 * 1024
const GRACE_MS = 3000

// The plugin's OWN probes (`wsl -l -v`, `wslpath`, the `wsl-env` sweep) are
// never the user's command, so they get a hard ceiling: a wedged WSL service
// must not hang a tool call forever. User commands get no default timeout —
// only an explicit `timeoutMs`.
const INTERNAL_TIMEOUT_MS = 30_000

// Windows `CreateProcess` caps the whole command line at 32767 characters, so a
// larger script makes wsl.exe itself fail to launch with an opaque
// "filename or extension is too long". Scripts above this threshold are fed to
// `bash -ls` on stdin instead, where no such limit applies.
const MAX_COMMAND_CHARS = 30_000

// `setTimeout` stores its delay in a signed 32-bit int; a larger value
// overflows and fires IMMEDIATELY, so a huge `timeoutMs` would kill the
// command instantly instead of never timing out. Clamp to the largest sane
// delay (about 24.8 days) instead of aborting the user's intent.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

// wsl.exe writes UTF-16LE to a redirected stdout/stderr by default. Setting
// WSL_UTF8=1 makes every wsl.exe-owned stream (launcher warnings, the
// `wsl -l -v` table) UTF-8; the Linux command's own output is already UTF-8
// and passes through unchanged. It changes ENCODING only — launcher messages
// stay in the system locale.
const WSL_SPAWN_ENV = { WSL_UTF8: '1' }

// wsl.exe emits this locale-dependent launcher warning to stderr whenever
// Windows has a localhost proxy configured and WSL runs in NAT mode. It
// repeats on every call, so drop it; the tokens "localhost" and "proxy"
// ("代理") stay stable across locales.
const LOCALHOST_PROXY_WARNING = /^\s*wsl:\s.*(localhost|127\.0\.0\.1).*(proxy|代理)/i

// procps (`ps`, `top`, `free`, `w`) probes the console for a window size; a
// redirected wsl.exe stream has no real terminal, so it reports a bogus
// 131072x1 and warns on stderr. Pure noise for every call, so drop it.
const BOGUS_SCREEN_SIZE_WARNING = /^\s*your \d+x\d+ screen size is bogus\.?\s*expect trouble\.?\s*$/i

// Strip wsl.exe launcher / procps noise lines from stderr.
function cleanStderr(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !LOCALHOST_PROXY_WARNING.test(line) && !BOGUS_SCREEN_SIZE_WARNING.test(line))
    .join('\n')
}

// --- small helpers ---------------------------------------------------------

// Shell-quote a value for a single-quoted `export KEY='value'` fragment.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// Only allow distribution names that cannot inject shell syntax into argv.
const DISTRO_RE = /^[A-Za-z0-9._-]+$/
function resolveDistro(arg) {
  const distro = arg ?? process.env.DSH_WSL_DISTRO ?? DEFAULT_DISTRO
  if (typeof distro !== 'string' || !DISTRO_RE.test(distro) || distro.trim() === '') {
    throw new Error('wsl: distro must be a simple name (letters, digits, dot, dash, underscore)')
  }
  return distro
}

// Characters that may appear inside a Windows path segment but cannot be part
// of it: whitespace ends the segment, and shell metacharacters end the token.
const PATH_CHAR = `[^\\s"'` + '`' + `|&;<>()]`

// One Windows drive-absolute path: `C:\foo`, `C:/foo`, and — the case the
// first version got wrong — a path whose LATER segments contain spaces, e.g.
// `C:\Program Files\Git`.
//
// A space only continues the match when the following chunk itself contains a
// backslash. That rule is both necessary and safe:
//   * necessary — every segment boundary inside a real Windows path is written
//     with a backslash, so a chunk after a space contains one unless the space
//     is the start of a separate shell word;
//   * safe — an unconsumed chunk is left verbatim, so `C:\Program Files` still
//     becomes `/mnt/c/Program Files` (only the part that had backslashes is
//     rewritten), while `echo C:\x && ls` stops at the `&&`.
const DRIVE_PATH_RE = new RegExp(
  `\\b([A-Za-z]):([\\\\/])(${PATH_CHAR}*(?:\\s+${PATH_CHAR}*\\\\${PATH_CHAR}*)*)`,
  'g',
)

// Windows reaches a WSL filesystem as a UNC path: `\\wsl.localhost\<distro>\home\x`
// or the legacy `\\wsl$\<distro>\home\x`. Inside a Linux command both mean the
// Linux path, so translate them too.
const WSL_UNC_RE = new RegExp(
  `\\\\\\\\wsl(?:\\.localhost|\\$)(?:\\\\+([^\\\\/\\s"'` + '`' + `|&;<>()]+))?((?:[\\\\/]${PATH_CHAR}*)*)`,
  'g',
)

// Translate literal Windows paths into their WSL/Linux form.
//   C:\Users\me\a.txt            -> /mnt/c/Users/me/a.txt
//   C:\Program Files\Git\cmd     -> /mnt/c/Program Files/Git/cmd
//   \\wsl.localhost\Ubuntu\home  -> /home
// A single lowercase letter followed by `/` is NOT rewritten: `a:/b` is
// ordinary text far more often than it is a drive path, and the backslash form
// (`a:\b`, or an uppercase `C:/...`) still is.
function windowsPathToWsl(text) {
  if (typeof text !== 'string' || text.length === 0) return text

  const withDrives = text.replace(DRIVE_PATH_RE, (match, letter, separator, rest) => {
    if (separator === '/' && letter !== letter.toUpperCase()) return match
    const tail = rest.replace(/\\/g, '/')
    return `/mnt/${letter.toLowerCase()}/${tail}`.replace(/\/{2,}/g, '/')
  })

  return withDrives.replace(WSL_UNC_RE, (_match, _distro, tail) => {
    const path = String(tail ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    return path.startsWith('/') ? path : `/${path}`
  })
}

// `~` must stay OUTSIDE the quotes or bash never expands it, so a `~`-rooted
// path is split: the tilde stays bare and only the remainder is quoted.
// `~/my dir` -> `~/'my dir'`; anything else is quoted whole. A path that is
// literally named `~foo` therefore cannot be expressed — acceptable, and the
// safe direction: an unexpanded tilde fails loudly instead of silently.
const TILDE_PATH_RE = /^(~[A-Za-z0-9._-]*)((?:\/.*)?)$/
function quotePath(path) {
  const match = TILDE_PATH_RE.exec(path)
  if (match === null) return shellQuote(path)
  const [, tilde, rest] = match
  return rest.length <= 1 ? tilde : `${tilde}/${shellQuote(rest.slice(1))}`
}

function buildCdCommand(workdir) {
  return `cd ${quotePath(workdir)}`
}

// --- destructive-command guard ---------------------------------------------

// `rm` is the one command whose flag spelling is genuinely open-ended:
// `rm -rf`, `rm -fr`, `rm -r -f`, `rm -R --force`, `rm --recursive --force`.
// A regex over the whole command missed the separated and long forms, so scan
// each `rm` invocation and collect its flags individually. The prefix and the
// trailing lookahead tolerate everything that can wrap a command word: quotes,
// backticks, `$(`/`)` command substitution, and a `\rm` escape.
const RM_INVOCATION = /(?:^|[\s;&|"'`(\\])(?:\S*\/)?rm(?=[\s"'`)}]|$)/g
const TILDE_STRIP_RE = /^["'`]+|["'`]+$/g

// `$IFS` (and `${IFS}`) expands to whitespace, so `rm$IFS-rf` is the same
// command as `rm -rf`. Normalize it for MATCHING only; the command that runs is
// untouched, so the worst case is refusing an exotic but harmless literal.
const IFS_ESCAPE_RE = /\$\{?IFS\}?/g

function rmIsDestructive(segment) {
  RM_INVOCATION.lastIndex = 0
  let match
  while ((match = RM_INVOCATION.exec(segment)) !== null) {
    let recursive = false
    let force = false
    for (const rawToken of segment.slice(match.index + match[0].length).split(/\s+/)) {
      const token = rawToken.replace(TILDE_STRIP_RE, '')
      if (token === '--') break
      if (token === '--recursive') recursive = true
      else if (token === '--force') force = true
      else if (/^-[A-Za-z]+$/.test(token)) {
        if (token.includes('r') || token.includes('R')) recursive = true
        if (token.includes('f')) force = true
      }
    }
    if (recursive && force) return true
  }
  return false
}

// Commands that will never be run silently. Each entry is matched against the
// final (post-translation) command string. When one matches, the call is
// refused unless the caller passed `allowDangerous: true`.
const DESTRUCTIVE_PATTERNS = [
  [/\bdd\b[^\n]*\bof=\s*\/dev\/(sd|hd|nvme|mmcblk|vd|xvd|disk)/, 'dd onto a block device'],
  [/\bmkfs(\.\w+)?\b/, 'mkfs (format a filesystem)'],
  [/\b(mke2fs|mkswap|wipefs|fdisk|sfdisk|gdisk|sgdisk|parted|blkdiscard)\b/, 'disk partitioning / wiping tool'],
  [/\b(shutdown|poweroff|reboot|halt)\b/, 'power control'],
  [/\bsystemctl\s+(poweroff|reboot|halt)\b/, 'power control'],
  [/[^>]\s*>>?\s*\/dev\/(sd|hd|nvme|mmcblk|vd|xvd|disk)/, 'redirect onto a block device'],
  [/:\s*\(\s*\)\s*\{[^\n]*\|[^\n]*&[^\n]*\}\s*;\s*:/, 'fork bomb'],
]

// Returns a human-readable reason when `command` is destructive, else null.
function destructiveReason(command) {
  const scanned = command.replace(IFS_ESCAPE_RE, ' ')
  if (rmIsDestructive(scanned)) return 'recursive forced delete (`rm -r -f`)'
  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(scanned)) return reason
  }
  return null
}

// --- result shaping --------------------------------------------------------

// Windows exit codes are unsigned 32-bit; wsl.exe reports its own failures as
// -1, which reaches us as 4294967295. Show the signed value a human expects.
function normalizeExitCode(exitCode) {
  if (exitCode === 0xFFFFFFFF) return -1
  return exitCode
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

// One collected stream -> text plus the truncation facts the model needs to
// recover what the 64 KiB in-memory tail dropped.
function streamFacts(read) {
  if (read === undefined || read === null) {
    return { text: '', totalBytes: 0, droppedBytes: 0, lossy: false, spillPath: null }
  }
  const text = read.text ?? ''
  const totalBytes = typeof read.nextOffset === 'number' ? read.nextOffset : byteLength(text)
  return {
    text,
    totalBytes,
    droppedBytes: read.lossy ? Math.max(0, totalBytes - byteLength(text)) : 0,
    lossy: read.lossy === true,
    spillPath: read.spillPath ?? null,
  }
}

function truncationMarkers(value) {
  const markers = []
  for (const stream of ['stdout', 'stderr']) {
    const dropped = value[`${stream}DroppedBytes`] ?? 0
    if (dropped <= 0) continue
    const total = value[`${stream}TotalBytes`] ?? 0
    const spill = value[`${stream}SpillPath`]
    const recovery = spill === null || spill === undefined
      ? 'earlier bytes were dropped'
      : `full stream: ${spill}`
    markers.push(`[${stream} truncated: kept the last ${total - dropped} of ${total} bytes; ${recovery}]`)
  }
  return markers.length > 0 ? markers : ['[output truncated]']
}

function formatResult(value, args = {}) {
  let body = value.stdout || ''
  if (value.stderr && value.stderr.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${value.stderr}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = []
  if (value.truncated) markers.push(...truncationMarkers(value))
  if (value.timedOut) {
    const requested = args?.timeoutMs
    const after = typeof requested === 'number' ? `${requested}ms` : 'the requested timeout'
    markers.push(`[timed out after ${after}; the command was killed]`)
  } else if (value.signal !== null && value.signal !== undefined) {
    markers.push(`[killed by signal: ${value.signal}]`)
  } else if (value.exitCode !== 0 && value.exitCode !== null) {
    markers.push(`[exit code: ${value.exitCode}]`)
  }
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

// --- shared runner ---------------------------------------------------------

// The single spawn path: every call in this plugin goes through it, so the
// stdio shape, grace period, timeout classification and truncation facts are
// identical for the model-facing tool and the plugin's own probes.
async function spawnWsl(ctx, argv, timeoutMs, stdinData) {
  const controller = new AbortController()
  let timedOut = false
  let timer = null
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    const delay = Math.min(timeoutMs, MAX_TIMER_DELAY_MS)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, delay)
  }

  try {
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv,
        // Required by the dsh 0.1.5 subprocess seam: every spawn spec states its
        // own working directory. The Linux-side directory is set by the `cd`
        // prefix the caller builds, so the Windows-side cwd only has to be a
        // real directory (it also becomes the initial WSL cwd).
        cwd: process.cwd(),
        env: WSL_SPAWN_ENV,
        stdio: {
          stdin: typeof stdinData === 'string' ? { data: stdinData } : 'ignore',
          stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
          stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
        },
        graceMs: GRACE_MS,
        signal: controller.signal,
      })
    } catch (error) {
      throw new Error(`wsl: could not launch ${argv[0]}: ${error?.message ?? String(error)}`)
    }

    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error(`wsl: ${argv[0]} failed to run: ${error?.message ?? String(error)}`)
    }

    const stdout = streamFacts(handle.collected?.stdout?.readFrom(0))
    const stderr = streamFacts(handle.collected?.stderr?.readFrom(0))

    return {
      exitCode: normalizeExitCode(outcome.exitCode ?? null),
      signal: outcome.signal ?? null,
      timedOut,
      stdout: stdout.text,
      stderr: cleanStderr(stderr.text),
      truncated: stdout.lossy || stderr.lossy,
      stdoutTotalBytes: stdout.totalBytes,
      stdoutDroppedBytes: stdout.droppedBytes,
      stderrTotalBytes: stderr.totalBytes,
      stderrDroppedBytes: stderr.droppedBytes,
      stdoutSpillPath: stdout.spillPath,
      stderrSpillPath: stderr.spillPath,
    }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// A launcher-level "no such distro" means bash never ran, so surface it as a
// tool error instead of handing the model a meaningless exit code. The
// WSL_E_* code is locale-independent, unlike the message around it.
const DISTRO_NOT_FOUND_RE = /WSL_E_DISTRO_NOT_FOUND/
function assertDistroReachable(distro, result) {
  if (result.exitCode === 0) return
  if (!DISTRO_NOT_FOUND_RE.test(result.stderr) && !DISTRO_NOT_FOUND_RE.test(result.stdout)) return
  throw new Error(
    `wsl: distribution "${distro}" is not registered. Run the wsl-env tool (or \`wsl -l -v\`) ` +
    `to list the available distributions.`,
  )
}

async function runWsl(ctx, command, opts = {}) {
  const distro = resolveDistro(opts.distro)
  const workdir = opts.workdir !== undefined && opts.workdir !== '' ? windowsPathToWsl(opts.workdir) : DEFAULT_WORKDIR

  let full = `${buildCdCommand(workdir)} && ${command}`
  if (opts.env && typeof opts.env === 'object') {
    const exports = Object.entries(opts.env)
      .map(([k, v]) => (v === undefined ? `unset ${k}` : `export ${k}=${shellQuote(v)}`))
    if (exports.length > 0) full = exports.join('; ') + '; ' + full
  }

  const argv = full.length > MAX_COMMAND_CHARS
    ? ['wsl.exe', '-d', distro, '-e', 'bash', '-ls']
    : ['wsl.exe', '-d', distro, '-e', 'bash', '-lc', full]
  const result = await spawnWsl(
    ctx,
    argv,
    opts.timeoutMs,
    full.length > MAX_COMMAND_CHARS ? full : undefined,
  )
  assertDistroReachable(distro, result)
  return result
}

// Like runWsl but runs an arbitrary argv directly (no cd/env prefix).
async function runWslRaw(ctx, argv, timeoutMs) {
  return await spawnWsl(ctx, argv, timeoutMs)
}

// --- tools -----------------------------------------------------------------

function wslTool(ctx) {
  return {
    name: 'wsl',
    description:
      `Execute a Linux command through WSL (wsl.exe -d <distro> -e bash -lc) and return its stdout/stderr. ` +
      `Each call runs in a fresh shell: no state persists between calls — pass \`workdir\` (a WSL/Linux path, default \`~\`) or \`cd\` inside the command. ` +
      `Windows paths in \`command\`/\`workdir\` are translated automatically: \`C:\\dir\\file\` and \`C:\\Program Files\\x\` become \`/mnt/c/...\`, and \`\\\\wsl.localhost\\<distro>\\home\\x\` becomes \`/home/x\`. ` +
      `The distro defaults to \`${DEFAULT_DISTRO}\` (override with the \`distro\` arg or the \`DSH_WSL_DISTRO\` env var). ` +
      `Non-zero exits are reported as \`[exit code: N]\`; a timeout as \`[timed out ...]\`. ` +
      `Output is capped at ${MAX_OUTPUT_BYTES / 1024} KiB per stream: the tail is kept and the marker names the file holding the complete stream, which you can read. ` +
      `Set \`timeoutMs\` to bound long-running commands. Pass \`env\` to set variables. ` +
      `Set \`translatePaths: false\` when the command hands a Windows path to a Windows program through interop (WSL does not translate \`/mnt/c/...\` back, so \`notepad.exe C:\\file.txt\` needs the original spelling). ` +
      `Destructive commands are refused unless \`allowDangerous\` is true.`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The Linux command to execute inside WSL.',
        },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
        },
        workdir: {
          type: 'string',
          description: 'Working directory inside WSL (a Linux path such as /home/me or ~/src, or a Windows path like C:\\dir which is translated). Defaults to `~`.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds. The process is killed on expiry and the result is marked as timed out.',
        },
        distro: {
          type: 'string',
          description: `WSL distribution name (default \`${DEFAULT_DISTRO}\`). Overrides the DSH_WSL_DISTRO env var.`,
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra environment variables to export before running the command. Keys must be valid shell names.',
        },
        allowDangerous: {
          type: 'boolean',
          description: 'Must be true to run commands matched as destructive (recursive forced delete, dd onto a block device, mkfs, partitioning, shutdown, fork bomb, ...).',
        },
        translatePaths: {
          type: 'boolean',
          description: 'Default true: rewrite Windows paths in `command` to their /mnt/... form. Set false to pass the command through verbatim, e.g. when a Windows program launched via interop must receive a native path.',
        },
      },
      required: ['command', 'description'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          truncated: { type: 'boolean' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          stdoutTotalBytes: { type: 'integer' },
          stdoutDroppedBytes: { type: 'integer' },
          stderrTotalBytes: { type: 'integer' },
          stderrDroppedBytes: { type: 'integer' },
          stdoutSpillPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          stderrSpillPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: [
          'exitCode', 'signal', 'timedOut', 'truncated', 'stdout', 'stderr',
          'stdoutTotalBytes', 'stdoutDroppedBytes', 'stderrTotalBytes', 'stderrDroppedBytes',
          'stdoutSpillPath', 'stderrSpillPath',
        ],
      },
      render: (args, value) => [{ type: 'text', text: formatResult(value, args) }],
    },
    async execute(args) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('wsl: command must be a non-empty string')
      }
      if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        throw new Error('wsl: description must be a non-empty string')
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error('wsl: timeoutMs must be a positive number')
      }
      if (args.translatePaths !== undefined && typeof args.translatePaths !== 'boolean') {
        throw new Error('wsl: translatePaths must be a boolean')
      }
      if (args.env !== undefined && (typeof args.env !== 'object' || args.env === null || Array.isArray(args.env))) {
        throw new Error('wsl: env must be an object of string values')
      }
      if (args.env !== undefined) {
        // Silently dropping a bad key would run the command with the variable
        // missing, which is worse than refusing it.
        for (const [key, value] of Object.entries(args.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`wsl: env key ${JSON.stringify(key)} is not a valid shell variable name`)
          }
          if (value !== undefined && typeof value !== 'string') {
            throw new Error(`wsl: env["${key}"] must be a string`)
          }
        }
      }

      const command = args.translatePaths === false ? args.command : windowsPathToWsl(args.command)
      const reason = destructiveReason(command)
      if (reason !== null && args.allowDangerous !== true) {
        throw new Error(
          `wsl: refused a destructive command (${reason}). ` +
          'If this is intended, re-issue it with `allowDangerous: true`.',
        )
      }

      return await runWsl(ctx, command, {
        distro: args.distro,
        workdir: args.workdir,
        env: args.env,
        timeoutMs: args.timeoutMs,
      })
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: args.command,
      description: args.description,
      ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
    }),
  }
}

function wslPathTool(ctx) {
  return {
    name: 'wsl-path',
    description:
      `Convert between Windows and WSL/Linux paths using \`wslpath\`. ` +
      `Pass a Windows path (e.g. \`C:\\Users\\me\\a.txt\`) to get its \`/mnt/c/...\` form, or a Linux path (e.g. \`/home/me/a.txt\`) to get its \`\\\\wsl.localhost\\...\` form. ` +
      `Use \`direction\` to force \`win\` or \`linux\`; leave it unset for auto-detection.`,
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
          description: `WSL distribution name (default \`${DEFAULT_DISTRO}\`).`,
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
    async execute(args) {
      if (typeof args.path !== 'string' || args.path.trim() === '') {
        throw new Error('wsl-path: path must be a non-empty string')
      }
      const looksWindows = /^[a-zA-Z]:[\\/]/.test(args.path) || /^\\\\/.test(args.path)
      const direction = args.direction === 'win' || args.direction === 'linux'
        ? args.direction
        : (looksWindows ? 'linux' : 'win')
      // wslpath -u <windows>  -> WSL path;  wslpath -w <linux>  -> Windows path
      const flag = direction === 'win' ? '-w' : '-u'
      const res = await runWsl(ctx, `wslpath ${flag} ${quotePath(args.path)}`, {
        distro: args.distro,
        timeoutMs: INTERNAL_TIMEOUT_MS,
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

function wslEnvTool(ctx) {
  return {
    name: 'wsl-env',
    description:
      `Summarize the WSL environment: registered distributions, default distro, kernel, CPU count, memory and disk usage. ` +
      `Useful for deciding what is available before running commands.`,
    parameters: {
      type: 'object',
      properties: {
        distro: {
          type: 'string',
          description: `WSL distribution name to probe (default \`${DEFAULT_DISTRO}\`).`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const distro = resolveDistro(args.distro)
      const opts = { distro, timeoutMs: INTERNAL_TIMEOUT_MS }

      // The probes are independent, so run them concurrently: each wsl.exe
      // launch costs a WSL round trip, and four sequential ones dominate the
      // tool's latency.
      const [uname, mem, disk, list] = await Promise.all([
        runWsl(ctx, 'uname -sr && echo "nproc: $(nproc)"', opts),
        runWsl(ctx, "free -h | awk 'NR==1 || NR==2'", opts),
        runWsl(ctx, 'df -h / /home 2>/dev/null || df -h /', opts),
        runWslRaw(ctx, ['wsl.exe', '-l', '-v'], INTERNAL_TIMEOUT_MS),
      ])

      const failure = (label, result) => {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
        return `[${label} unavailable: ${detail.split(/\r?\n/)[0]}]`
      }

      // Nothing worked: report it instead of returning a summary that silently
      // omits the kernel, memory and disk the caller asked for.
      if (uname.exitCode !== 0) {
        const detail = uname.stderr.trim() || uname.stdout.trim() || `exit code ${uname.exitCode}`
        throw new Error(`wsl-env: could not probe distro "${distro}": ${detail}`)
      }

      const lines = [`distro: ${distro}`, uname.stdout.trim()]
      lines.push(mem.exitCode === 0 ? mem.stdout.trimEnd() : failure('memory', mem))
      lines.push(disk.exitCode === 0 ? disk.stdout.trimEnd() : failure('disk', disk))
      lines.push(
        list.exitCode === 0
          ? '--- distributions ---\n' + list.stdout.trimEnd()
          : failure('distribution list', list),
      )

      return { summary: lines.filter((line) => line.length > 0).join('\n\n') }
    },
    presentCall: () => ({ card: 'text', title: 'wsl environment', description: 'inspect WSL environment' }),
  }
}

// --- plugin -----------------------------------------------------------------

export const name = 'tool-wsl'
export const inject = ['tools', 'subprocess']

export function apply(ctx) {
  ctx.tools.register(wslTool(ctx))
  ctx.tools.register(wslPathTool(ctx))
  ctx.tools.register(wslEnvTool(ctx))
}

// Pure helpers exposed for the regression suite in `test/`. Not a stable API.
export const __internals = {
  cleanStderr,
  shellQuote,
  quotePath,
  resolveDistro,
  windowsPathToWsl,
  buildCdCommand,
  destructiveReason,
  normalizeExitCode,
  formatResult,
  streamFacts,
}
