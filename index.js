// dsh-wsl: model-facing WSL tools for DeepSeek Harness (DSH).
//
// Registers three tools:
//   - `wsl`      : run a Linux command through wsl.exe, return stdout/stderr
//                  with exit-code / signal / truncation markers. Supports
//                  workdir, timeoutMs, extra env vars, a configurable distro,
//                  automatic Windows->WSL path translation, and a guard that
//                  refuses obviously destructive commands unless explicitly
//                  allowed.
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

// wsl.exe writes UTF-16LE to a redirected stdout/stderr by default. Setting
// WSL_UTF8=1 makes every wsl.exe-owned stream (launcher warnings, the
// `wsl -l -v` table) UTF-8; the Linux command's own output is already UTF-8
// and passes through unchanged.
const WSL_SPAWN_ENV = { WSL_UTF8: '1' }

// wsl.exe emits this locale-dependent launcher warning to stderr whenever
// Windows has a localhost proxy configured and WSL runs in NAT mode. It
// repeats on every call, so drop it; the tokens "localhost" and "proxy"
// ("代理") stay stable across locales.
const LOCALHOST_PROXY_WARNING = /^\s*wsl:\s.*(localhost|127\.0\.0\.1).*(proxy|代理)/i

// Strip the wsl.exe launcher's per-call localhost-proxy warning from stderr.
function cleanStderr(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !LOCALHOST_PROXY_WARNING.test(line))
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

// Translate literal Windows drive paths (C:\foo or C:/foo) into WSL /mnt/c/foo.
// The `\b` before the drive letter keeps URLs like `https://` intact — the `s`
// there follows `p`, so it has no word boundary. Backslashes are only rewritten
// inside the matched path segment (which ends at whitespace or a quote).
function windowsPathToWsl(text) {
  if (typeof text !== 'string') return text
  return text.replace(/\b([a-zA-Z]):[\\/]([^\s"'`]*)/g, (_m, drive, rest) =>
    `/mnt/${drive.toLowerCase()}/` + rest.replace(/\\/g, '/'))
}

// Commands that will never be run silently. Each entry is matched against the
// final (post-cd) command string. When one matches, the call is refused unless
// the caller passed `allowDangerous: true`.
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\b/, // rm -rf / recursive rm
  /\bdd\s+[^\n]*\bof=\/dev\/(sd|nvme|mmcblk|vd|xvd)/,        // dd onto a block device
  /\bmkfs(\.\w+)?\b/,                                         // mkfs / mkfs.ext4 ...
  /\b(mke2fs|mkswap|wipefs|fdisk|sfdisk|parted|gdisk)\b/,     // other disk tools
  /\b(shutdown|poweroff|reboot|halt)\b/,                      // power control
  /:\s*\(\s*\)\s*\{[^\n]*\|[^\n]*&[^\n]*\}\s*;\s*:/,         // fork bomb
  /[^>]\s*>\s*\/dev\/(sd|nvme|mmcblk|vd|xvd)/,               // redirect onto a block device
]

function dangerousReason(command) {
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(command)) return true
  }
  return false
}

function formatResult(value) {
  let body = value.stdout || ''
  if (value.stderr && value.stderr.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${value.stderr}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (value.truncated) markers.push('[output truncated]')
  if (value.signal !== null && value.signal !== undefined) markers.push(`[killed by signal: ${value.signal}]`)
  else if (value.exitCode !== 0 && value.exitCode !== null) markers.push(`[exit code: ${value.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

// --- shared runner ---------------------------------------------------------

async function runWsl(ctx, command, opts = {}) {
  const distro = resolveDistro(opts.distro)
  const workdir = opts.workdir !== undefined && opts.workdir !== '' ? windowsPathToWsl(opts.workdir) : DEFAULT_WORKDIR

  let full = `cd ${workdir === '~' ? '~' : shellQuote(workdir)} && ${command}`
  if (opts.env && typeof opts.env === 'object') {
    const exports = Object.entries(opts.env)
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => (v === undefined ? `unset ${k}` : `export ${k}=${shellQuote(v)}`))
    if (exports.length > 0) full = exports.join('; ') + '; ' + full
  }

  const controller = new AbortController()
  const timer = opts.timeoutMs !== undefined ? setTimeout(() => controller.abort(), opts.timeoutMs) : null
  try {
    const handle = ctx.subprocess.spawn({
      argv: ['wsl.exe', '-d', distro, '-e', 'bash', '-lc', full],
      // Required by the dsh 0.1.5 subprocess seam: every spawn spec states its
      // own working directory. The Linux-side directory is set by the `cd`
      // prefix above, so the Windows-side cwd only has to be a real directory.
      cwd: process.cwd(),
      env: WSL_SPAWN_ENV,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
        stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
      },
      graceMs: GRACE_MS,
      signal: controller.signal,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout.readFrom(0)
    const stderr = handle.collected.stderr.readFrom(0)
    return {
      exitCode: outcome.exitCode ?? null,
      signal: outcome.signal ?? null,
      stdout: stdout.text,
      stderr: cleanStderr(stderr.text),
      truncated: stdout.lossy || stderr.lossy,
    }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// --- tools -----------------------------------------------------------------

function wslTool(ctx) {
  return {
    name: 'wsl',
    description:
      `Execute a Linux command through WSL (wsl.exe -d <distro> -e bash -lc) and return its stdout/stderr. ` +
      `Each call runs in a fresh shell: no state persists between calls — pass \`workdir\` (a WSL/Linux path, default \`~\`) or \`cd\` inside the command. ` +
      `Windows paths like \`C:\\...\` in \`command\`/\`workdir\` are translated to \`/mnt/c/...\` automatically. ` +
      `The distro defaults to \`${DEFAULT_DISTRO}\` (override with the \`distro\` arg or the \`DSH_WSL_DISTRO\` env var). ` +
      `Non-zero exits are reported as \`[exit code: N]\`. Long output is truncated to its tail. ` +
      `Set \`timeoutMs\` to bound long-running commands. Pass \`env\` to set variables. ` +
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
          description: 'Working directory inside WSL (a Linux path, or a Windows path like C:\\dir which is translated). Defaults to `~`.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds. The process is killed on expiry.',
        },
        distro: {
          type: 'string',
          description: `WSL distribution name (default \`${DEFAULT_DISTRO}\`). Overrides the DSH_WSL_DISTRO env var.`,
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra environment variables to export before running the command.',
        },
        allowDangerous: {
          type: 'boolean',
          description: 'Must be true to run commands matched as destructive (rm -rf, dd onto a block device, mkfs, shutdown, ...).',
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
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['exitCode', 'signal', 'stdout', 'stderr', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: formatResult(value) }],
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
      if (args.env !== undefined && (typeof args.env !== 'object' || args.env === null || Array.isArray(args.env))) {
        throw new Error('wsl: env must be an object of string values')
      }

      const command = windowsPathToWsl(args.command)
      if (dangerousReason(command) && args.allowDangerous !== true) {
        throw new Error(
          'wsl: command matches a destructive pattern (rm -rf, dd onto a block device, mkfs, shutdown, ...). ' +
          'If this is intended, re-issue it with `allowDangerous: true`.',
        )
      }

      return runWsl(ctx, command, {
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
          description: "Conversion direction: 'win' (Linux->Windows) or 'linux' (Windows->WSL). Default auto.",
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
      const looksWindows = /^[a-zA-Z]:[\\/]/.test(args.path)
      const direction = args.direction === 'win' || args.direction === 'linux'
        ? args.direction
        : (looksWindows ? 'linux' : 'win')
      // wslpath -u <windows>  -> WSL path;  wslpath -w <linux>  -> Windows path
      const flag = direction === 'win' ? '-w' : '-u'
      const res = await runWsl(ctx, `wslpath ${flag} ${shellQuote(args.path)}`, { distro: args.distro })
      if (res.exitCode !== 0) {
        throw new Error(`wsl-path: wslpath failed: ${res.stderr || res.stdout}`)
      }
      return { input: args.path, converted: res.stdout.trim() }
    },
    presentCall: (args) => ({ card: 'text', title: args.path, description: 'path conversion' }),
  }
}

function wslEnvTool(ctx) {
  return {
    name: 'wsl-env',
    description:
      `Summarize the WSL environment: registered distributions, default distro, kernel, CPU count, memory and disk usage. ` +
      `No arguments. Useful for deciding what is available before running commands.`,
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
      const lines = []
      const distro = resolveDistro(args.distro)

      const uname = await runWsl(ctx, 'uname -sr && echo "nproc: $(nproc)"', { distro })
      if (uname.exitCode === 0) lines.push(uname.stdout.trim())

      const mem = await runWsl(ctx, "free -h | awk 'NR==1 || NR==2'", { distro })
      if (mem.exitCode === 0) lines.push(mem.stdout.trimEnd())

      const disk = await runWsl(ctx, 'df -h / /home 2>/dev/null || df -h /', { distro })
      if (disk.exitCode === 0) lines.push(disk.stdout.trimEnd())

      // List distros from the Windows side (wsl.exe -l -v writes to stdout on the host).
      const list = await runWslRaw(ctx, ['wsl.exe', '-l', '-v'])
      if (list.exitCode === 0) lines.push('--- distributions ---\n' + list.stdout.trimEnd())

      return { summary: lines.filter((l) => l.length > 0).join('\n\n') }
    },
    presentCall: () => ({ card: 'text', title: 'wsl environment', description: 'inspect WSL environment' }),
  }
}

// Like runWsl but runs an arbitrary argv directly (no cd/env prefix).
async function runWslRaw(ctx, argv) {
  const controller = new AbortController()
  try {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: process.cwd(),
      env: WSL_SPAWN_ENV,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
        stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
      },
      graceMs: GRACE_MS,
      signal: controller.signal,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout.readFrom(0)
    const stderr = handle.collected.stderr.readFrom(0)
    return {
      exitCode: outcome.exitCode ?? null,
      signal: outcome.signal ?? null,
      stdout: stdout.text,
      stderr: cleanStderr(stderr.text),
      truncated: stdout.lossy || stderr.lossy,
    }
  } finally {
    controller.abort()
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
