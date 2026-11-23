// Project-against-distribution diagnostics for `wsl-doctor`: one probe script,
// its parser, and the compact report composed from it.
//
// The question this answers is "will the tooling this project expects actually
// work inside this distribution?" — the two ways that goes wrong are invisible
// from either side alone:
//
//   1. a tool the project needs is simply absent from the Linux side, and
//   2. a tool IS found, but it is a WINDOWS binary reached through interop,
//      because WSL appends the Windows PATH to the Linux one.
//
// The second is the nastier of the two. Measured on the author's machine: `npm`
// in the distribution resolves to `/mnt/c/Program Files/nodejs/npm` while `node`
// does not exist there at all, so `npm install` runs the Windows npm against a
// Linux working directory and fails in ways that name neither cause. Nothing in
// the platform reports that; a listing here does.

const WINDOWS_MOUNT_RE = /^\/mnt\/[a-z]\//

/**
 * Manifests that say what a project needs, and the commands each one implies.
 *
 * Only the ones with a stable, single-command answer are listed: guessing at a
 * `scripts` block or a language server would produce noise, and a report that
 * cries wolf is worse than a shorter one.
 */
export const MANIFEST_NEEDS = [
  // `npm` travels with `node` on purpose: a Node project's most likely command is
  // `npm install`, and the measured failure is exactly that npm resolving to the
  // WINDOWS one while the Linux side has no node at all.
  { file: 'package.json', commands: ['node', 'npm'], what: 'Node.js' },
  { file: 'pnpm-lock.yaml', commands: ['pnpm'], what: 'pnpm' },
  { file: 'yarn.lock', commands: ['yarn'], what: 'Yarn' },
  { file: '.nvmrc', commands: ['node'], what: 'Node.js' },
  { file: 'tsconfig.json', commands: ['node'], what: 'Node.js' },
  { file: 'Cargo.toml', commands: ['cargo', 'rustc'], what: 'Rust' },
  { file: 'go.mod', commands: ['go'], what: 'Go' },
  { file: 'pyproject.toml', commands: ['python3', 'pip3'], what: 'Python' },
  { file: 'requirements.txt', commands: ['python3', 'pip3'], what: 'Python' },
  { file: 'Dockerfile', commands: ['docker'], what: 'Docker' },
  { file: 'docker-compose.yml', commands: ['docker'], what: 'Docker' },
  { file: 'compose.yaml', commands: ['docker'], what: 'Docker' },
  { file: 'Makefile', commands: ['make'], what: 'make' },
  { file: 'CMakeLists.txt', commands: ['cmake'], what: 'CMake' },
]

/**
 * Commands the probe resolves, whether or not the project asks for them.
 *
 * A fixed superset costs one shell round trip and lets the caller filter by
 * manifest, so a new manifest mapping never has to touch the shell script.
 */
export const PROBED_COMMANDS = [
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack',
  'python3', 'pip3', 'go', 'cargo', 'rustc',
  'docker', 'gcc', 'g++', 'make', 'cmake',
  // Editor, device and SDK shims: names a Linux side usually has too, so finding
  // them as `.exe`s through interop is a real shadow rather than a Windows-only
  // tool being reachable. (`cmd.exe`/`powershell.exe` are deliberately NOT here:
  // they have no Linux namesake to shadow, and including them made every default
  // WSL install look like it needed `appendWindowsPath=false`.)
  'code', 'adb', 'dotnet', 'qrcp',
  'jq', 'rg', 'rsync', 'curl', 'git', 'tar', 'sudo',
]

/** Commands whose version is worth a second process; the rest are binary-hunted only. */
const VERSION_COMMANDS = ['node', 'python3', 'gcc', 'docker', 'git', 'make', 'go', 'cargo']

/**
 * Shadows that mean the Windows PATH is where a NATIVE toolchain should be: a
 * Windows `npm` with no Linux `node` is the measured failure this tool exists for,
 * and the `appendWindowsPath=false` advice is aimed at it.
 *
 * `code`, `adb`, `dotnet` and `qrcp` are deliberately NOT here even though they are
 * reported as shadows: their Windows binaries are often the intended ones (VS
 * Code's Remote-WSL shim, a phone's adb), and following the advice for them would
 * break those workflows. They stay in the fact line, out of the remedy trigger.
 */
const TOOLCHAIN_SHADOWS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack',
  'python3', 'pip3', 'gcc', 'g++', 'make', 'cmake', 'go', 'cargo',
])

/**
 * One shell round trip collecting every fact the report needs.
 *
 * Each line is `key=value`; `command -v` is classified in the shell so a Windows
 * binary is never mistaken for a Linux one. `timeout` guards the version probes:
 * a tool that hangs on `--version` must not hang the doctor.
 */
export const PROJECT_PROBE = [
  // --- project shape -------------------------------------------------------
  ...[
    'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', '.nvmrc',
    'tsconfig.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt',
    'Dockerfile', 'docker-compose.yml', 'compose.yaml', 'Makefile', 'CMakeLists.txt',
    '.python-version', 'Gemfile', 'composer.json',
  ].map((file) => `[ -e ${file} ] && echo "file.${file}=1"`),
  // A text scan rather than a JSON parse: the Linux side may have no node or jq
  // at all, which is exactly the situation this tool exists to report.
  String.raw`[ -f package.json ] && echo "pkg.manager=$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"`,
  String.raw`[ -f package.json ] && echo "pkg.node=$(sed -n 's/.*"engines"[^}]*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"`,
  String.raw`[ -f .nvmrc ] && echo "pkg.nvmrc=$(tr -d '\r\n' < .nvmrc)"`,
  // --- where each command actually comes from ------------------------------
  ...PROBED_COMMANDS.map((command) =>
    String.raw`p=$(command -v ${command} 2>/dev/null); case "$p" in /mnt/*) echo "cmd.${command}=interop:$p" ;; '') echo "cmd.${command}=missing" ;; *) echo "cmd.${command}=$p" ;; esac`),
  // --- versions, best effort ----------------------------------------------
  ...VERSION_COMMANDS.map((command) =>
    String.raw`v=$(timeout 2 ${command} --version 2>/dev/null | head -1 | tr -d '\r'); [ -n "$v" ] && echo "ver.${command}=$v"`),
  // --- boundary facts: interop PATH, networking, workspace mount -----------
  // /etc/wsl.conf is parsed SECTION-AWARE: `appendWindowsPath` anywhere outside
  // `[interop]` is not the interop setting. An EMPTY value means the key is
  // absent, which is WSL's default (on); a line that never appears at all means
  // the probe could not run, and the report then omits the interop line rather
  // than inventing a state.
  String.raw`echo "interop.appendWindowsPath=$(awk '/^[[:space:]]*\[/ { sec=$0; next } /^[[:space:]]*appendWindowsPath[[:space:]]*=/ && sec ~ /^[[:space:]]*\[interop\]/ { sub(/^[^=]*=[[:space:]]*/, ""); print; exit }' /etc/wsl.conf 2>/dev/null | tr -d '\r')"`,
  // An absent key and an UNREADABLE /etc/wsl.conf both leave the value empty, but
  // they mean different things: absent is WSL's default (on), unreadable is an
  // unknown. This separate fact is what keeps the report from guessing.
  String.raw`echo "interop.conf=$(if [ -e /etc/wsl.conf ] && [ ! -r /etc/wsl.conf ]; then echo unreadable; else echo ok; fi)"`,
  String.raw`echo "path.windows=$(printf '%s' "$PATH" | tr ':' '\n' | grep -c '^/mnt/[a-z]/')"`,
  // `wslinfo` ships with WSL 2.x only; an older install has no networking mode
  // to report, and an older `wslinfo` may print usage instead — the report only
  // trusts an exact nat/mirrored answer.
  String.raw`echo "net.mode=$(if command -v wslinfo >/dev/null 2>&1; then wslinfo --networking-mode 2>/dev/null | head -1 | tr -d '\r'; fi)"`,
  String.raw`echo "net.gateway=$(ip route 2>/dev/null | awk '/^default/ { print $3; exit }')"`,
  // The mount of `.` is the session workspace by construction: the probe runs in
  // the directory the report is about. findmnt is the precise source; the
  // stat//proc/mounts fallbacks keep the line alive on a minimal util-linux (which
  // has neither). `stat -f` spells 9p as `v9fs`, and the reader maps it back.
  String.raw`mp=$(stat -c %m . 2>/dev/null); echo "mount.target=$(findmnt -no TARGET --target . 2>/dev/null || printf '%s' "$mp")"`,
  String.raw`echo "mount.fstype=$(findmnt -no FSTYPE --target . 2>/dev/null || { s=$(stat -f -c %T . 2>/dev/null); if [ "$s" = v9fs ]; then echo 9p; else echo "$s"; fi; })"`,
  String.raw`mo=$(findmnt -no OPTIONS --target . 2>/dev/null | head -1); if [ -z "$mo" ] && [ -n "$mp" ]; then mo=$(awk -v t="$mp" '$2 == t { print $4; exit }' /proc/mounts 2>/dev/null); fi; echo "mount.options=$mo"`,
  // --- privileges ----------------------------------------------------------
  String.raw`echo "user.uid=$(id -u)"`,
  String.raw`echo "user.name=$(id -un 2>/dev/null)"`,
  String.raw`if sudo -n true 2>/dev/null; then echo "sudo.passwordless=1"; else echo "sudo.passwordless=0"; fi`,
].join('\n')

/** Parse key=value output; see diagnostics.parseFacts for the same contract. */
export function parseProbe(text) {
  const facts = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (key === '' || /\s/.test(key)) continue
    facts[key] = line.slice(separator + 1).trim()
  }
  return facts
}

/** The manifests present in the probed directory, in declaration order. */
export function manifestsPresent(facts) {
  return MANIFEST_NEEDS.filter((entry) => facts[`file.${entry.file}`] === '1')
}

/**
 * What the project asks for, deduplicated and ordered by first appearance.
 *
 * `packageManager` (a Corepack field) names the package manager explicitly, so it
 * adds one even when no lockfile is present; a lockfile alone implies one too.
 */
export function needsFromFacts(facts) {
  const needs = new Map()
  const add = (commands, because) => {
    for (const command of commands) {
      const existing = needs.get(command)
      if (existing === undefined) needs.set(command, { command, because: [because] })
      else if (!existing.because.includes(because)) existing.because.push(because)
    }
  }

  for (const entry of manifestsPresent(facts)) add(entry.commands, entry.file)

  const manager = facts['pkg.manager'] ?? ''
  if (manager.startsWith('pnpm')) add(['pnpm'], 'package.json packageManager')
  else if (manager.startsWith('yarn')) add(['yarn'], 'package.json packageManager')

  const engine = facts['pkg.node'] ?? ''
  if (engine !== '') add(['node'], `package.json engines.node ${engine}`)
  if ((facts['pkg.nvmrc'] ?? '') !== '') add(['node'], `.nvmrc ${facts['pkg.nvmrc']}`)

  return [...needs.values()]
}

/**
 * Classify one proxied command: usable, a Windows binary, or absent.
 * @returns `{ state, path }` where state is `linux` | `interop` | `missing`.
 */
export function commandState(facts, command) {
  const raw = facts[`cmd.${command}`]
  if (raw === undefined || raw === 'missing') return { state: 'missing', path: null }
  if (raw.startsWith('interop:')) return { state: 'interop', path: raw.slice('interop:'.length) }
  return { state: 'linux', path: raw }
}

/**
 * The version token inside a `--version` line.
 *
 * Tool output has no common shape: `v24.11.0`, `Python 3.10.12`,
 * `gcc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0`, `git version 2.34.1`,
 * `Docker version 24.0.7, build …`. The first dotted number is the version in all
 * of them, and keeping the raw line made one report row three times longer than
 * the others without saying more.
 */
export function versionToken(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  const match = /v?(\d+(?:\.\d+)+)/.exec(text)
  return match === null ? text.split(/\s+/)[0] : match[1]
}

function versionOf(facts, command) {
  return versionToken(facts[`ver.${command}`] ?? '')
}

/**
 * Compose the report.
 *
 * @param facts - probe output, parsed.
 * @param options.workspace - the Linux directory that was probed, for the header.
 * @param options.workspaceLine - already-formatted workspace note (see diagnostics.js).
 * @param options.bootstrapAvailable - whether the `wsl-bootstrap` tool is mounted,
 *   which decides whether the suggestion can name a tool or a panel switch.
 * @param options.rootEnabled - the panel's 管理员模式 switch.
 * @param options.rootProbe - 'available' | 'unavailable' | null, measured only when
 *   root is switched on (probing it otherwise would run a root command the user
 *   has not authorised).
 */
export function composeDoctorReport(facts, options = {}) {
  const base = facts['base.distro'] ?? null
  const header = []
  header.push(base === null ? 'distro: (system default)' : `distro: ${base}`)
  if (typeof options.workspaceLine === 'string' && options.workspaceLine !== '') header.push(options.workspaceLine)

  const manifests = manifestsPresent(facts).map((entry) => entry.file)
  header.push(manifests.length === 0
    ? 'project: no manifest found in the probed directory'
    : `project: ${manifests.join(', ')}`)

  const needs = needsFromFacts(facts)
  const lines = [header.join('\n')]

  if (needs.length === 0) {
    lines.push('needs: nothing inferred from this directory (no package.json, lockfile or language manifest)')
  } else {
    const needsLines = needs.map((need) => {
      const { state, path } = commandState(facts, need.command)
      const because = need.because.join('; ')
      if (state === 'linux') {
        const version = versionOf(facts, need.command)
        return `  ok      ${need.command}${version === null ? '' : ` — ${version}`} (from ${because})`
      }
      if (state === 'interop') {
        return `  WINDOWS ${need.command} — resolves to ${path}, a Windows binary reached through interop; ` +
          `the Linux side has no ${need.command}. Running it against a Linux directory is a common source of ` +
          'errors that name neither cause. (from ' + because + ')'
      }
      return `  MISSING ${need.command} — not on PATH in this distribution (from ${because})`
    })
    lines.push(`needs (from the project): ${needs.map((need) => need.command).join(', ')}\n${needsLines.join('\n')}`)
  }

  // What IS usable, briefly: this is what tells the caller it can proceed with
  // most of the work even when one tool is missing.
  const usable = []
  for (const command of PROBED_COMMANDS) {
    const { state } = commandState(facts, command)
    if (state !== 'linux') continue
    const version = versionOf(facts, command)
    usable.push(version === null ? command : `${command} ${version}`)
  }
  if (usable.length > 0) lines.push(`usable on the Linux side: ${usable.join(', ')}`)

  // The Windows PATH bridge as ONE line: the state of the setting, how many
  // Windows entries are on PATH, and which commands those entries shadow. The
  // per-need WINDOWS lines stay separate on purpose — they explain one broken
  // tool in the context that asked for it.
  const appendedRaw = facts['interop.appendWindowsPath']
  const interop = PROBED_COMMANDS
    .map((command) => ({ command, ...commandState(facts, command) }))
    .filter((entry) => entry.state === 'interop')
  const entryCountRaw = facts['path.windows'] ?? ''
  const windowsEntryCount = /^\d+$/.test(entryCountRaw) ? Number(entryCountRaw) : null
  let appendState = null
  if (facts['interop.conf'] === 'unreadable') {
    appendState = 'unknown (unreadable)'
  } else if (appendedRaw !== undefined) {
    // The configured value may carry quotes or a trailing comment; only the first
    // token is the setting. (A quoted "false" is not WSL's format, but accepting it
    // costs nothing and a rejected value would fall back to "unset" silently.)
    const value = appendedRaw.trim().toLowerCase()
      .split(/\s+/)[0]
      .replace(/^["']|["']$/g, '')
    if (value === '') appendState = 'on (default)'
    else if (value === 'true') appendState = 'on (configured)'
    else if (value === 'false') appendState = 'off (configured)'
  }
  const appendOn = appendState === 'on (default)' || appendState === 'on (configured)'
  const shadows = interop.map((entry) => entry.command)
  if (appendState !== null) {
    if (appendState === 'unknown (unreadable)') {
      lines.push('interop: appendWindowsPath state could not be read (/etc/wsl.conf is unreadable)' +
        (shadows.length === 0 ? '' : `; shadows on PATH: ${shadows.join(', ')}`))
    } else if (appendState === 'off (configured)' && windowsEntryCount === 0) {
      lines.push('interop: appendWindowsPath=off (configured) — no Windows entries on PATH')
    } else {
      const entryText = windowsEntryCount === null
        ? ''
        : ` — ${windowsEntryCount} Windows PATH ${windowsEntryCount === 1 ? 'entry' : 'entries'}`
      // `off` with Windows entries still on PATH means they were exported by hand
      // (or the shell predates the config change); saying so avoids the apparent
      // contradiction of an off setting with shadows in the same line.
      const stale = appendState === 'off (configured)' && windowsEntryCount !== null && windowsEntryCount !== 0
        ? ' — but Windows entries are still on PATH (exported by hand, or this shell predates the change)'
        : ''
      lines.push(`interop: appendWindowsPath=${appendState}${entryText}${stale}` +
        (shadows.length === 0 ? '' : `; shadows: ${shadows.join(', ')}`))
    }
  }
  // The interop remedy is a `next:` line, so it is emitted with the other next
  // steps at the end instead of interrupting the fact lines. It fires only for a
  // shadowed TOOLCHAIN, not for every shadow: an intentional Windows `code`/`adb`
  // would otherwise be told to break its own workflow (see TOOLCHAIN_SHADOWS).
  const toolchainShadows = shadows.filter((command) => TOOLCHAIN_SHADOWS.has(command))
  const interopNext = appendOn && toolchainShadows.length > 0
    ? 'next: set [interop] appendWindowsPath=false in /etc/wsl.conf, then wsl --shutdown'
    : null

  // WSL's networking mode decides whether a Windows-side service is reachable
  // from the distribution at all. Only the two defined modes get a line;
  // "unknown" is silence, not a guess.
  const netMode = (facts['net.mode'] ?? '').trim().toLowerCase()
  const gateway = (facts['net.gateway'] ?? '').trim()
  if (netMode === 'nat') {
    lines.push('network: NAT — Windows loopback (127.0.0.1) is not reachable from this distro' +
      (gateway === '' ? '' : `, default gateway ${gateway}`) +
      '; a Windows-side service must bind 0.0.0.0 (or set [wsl2] networkingMode=mirrored in .wslconfig, then wsl --shutdown)')
  } else if (netMode === 'mirrored') {
    lines.push('network: mirrored — Windows and WSL share localhost in both directions')
  }

  // The workspace mount decides whether chmod is real. A 9p/drvfs bridge without
  // the `metadata` automount option reads every file back as 777 no matter what
  // chmod wrote, which silently breaks anything that relies on modes.
  const mountTarget = (facts['mount.target'] ?? '').trim()
  const mountFs = (facts['mount.fstype'] ?? '').trim()
  const mountOptions = (facts['mount.options'] ?? '').trim()
  const fsLower = mountFs.toLowerCase()
  // `stat -f -c %T` calls the 9p bridge `v9fs`; findmnt calls it `9p`. Same mount,
  // two names.
  const bridgeFs = fsLower.includes('9p') || fsLower.includes('drvfs') || fsLower.includes('v9fs')
  // A KNOWN non-Windows filesystem under /mnt (tmpfs at /mnt/wsl, ext4 at
  // /mnt/data) is not the drive bridge even though its path looks like one, so
  // the /mnt fallback only applies when the filesystem could not be identified.
  const maybeBridge = bridgeFs || (mountFs === '' && mountTarget.startsWith('/mnt/'))
  if (maybeBridge && mountTarget !== '' && mountOptions !== '') {
    // `metadata` is a flag, so it is matched as a token rather than a substring.
    // WSL renders it either as its own comma-separated option or inside the
    // semicolon-separated `aname=` value (`…;gid=1000;metadata;symlinkroot=/mnt/`),
    // so both separators are tokenized.
    const hasMetadata = mountOptions.split(/[,;]/).some((token) => token.trim().toLowerCase() === 'metadata')
    const kind = mountFs === '' ? '9p' : mountFs
    lines.push(hasMetadata
      ? `mount: ${mountTarget} (${kind}) carries metadata — chmod sticks (a 600 read back as 600)`
      : `mount: ${mountTarget} (${kind}) has no metadata — chmod does not stick (a 600 reads back 777); ` +
        'add metadata to [automount] options in /etc/wsl.conf, then wsl --shutdown')
  }

  const uid = facts['user.uid'] ?? ''
  const userName = facts['user.name'] ?? ''
  const privilege = []
  if (uid !== '') privilege.push(`uid=${uid}${userName === '' ? '' : ` (${userName})`}`)
  if (facts['sudo.passwordless'] === '1') privilege.push('sudo: passwordless')
  else if (facts['sudo.passwordless'] === '0') privilege.push('sudo: requires a password (unusable from a tool call)')
  if (options.rootEnabled === true) {
    privilege.push(options.rootProbe === 'available'
      ? 'root: available through `wsl -u root` (no password) — use the `asRoot` parameter of `wsl`'
      : options.rootProbe === 'unavailable'
        ? 'root: `wsl -u root` did not answer — privileges are not available'
        : 'root: switched on in the panel, but the probe did not run')
  } else {
    privilege.push('root: switched off (left sidebar → WSL panel → 管理员模式 turns it on)')
  }
  if (privilege.length > 0) lines.push(`privileges: ${privilege.join(' · ')}`)

  if (interopNext !== null) lines.push(interopNext)

  const blocked = needs.filter((need) => commandState(facts, need.command).state !== 'linux').map((need) => need.command)
  if (blocked.length > 0) {
    // Only commands a recipe actually covers belong in the "install them" sentence: the old
    // text named every blocked command (`docker`, `go`, `cargo`) beside a recipe list that
    // does not contain it, so the suggestion promised something it would not do.
    const isCovered = (command) => suggestionRecipes([command]).length > 0
    const covered = blocked.filter(isCovered)
    const uncovered = blocked.filter((command) => !isCovered(command))
    if (covered.length > 0) {
      const recipes = suggestionRecipes(covered)
      const how = options.bootstrapAvailable === true
        ? `wsl-bootstrap({ recipes: [${recipes.map((id) => `"${id}"`).join(', ')}] }) installs them inside the distribution (dry run first, then dryRun: false)`
        : `turn on 「wsl-bootstrap 安装工具链」 in the left sidebar's WSL panel, then call wsl-bootstrap({ recipes: [${recipes.map((id) => `"${id}"`).join(', ')}] })`
      lines.push(`next: ${covered.join(', ')} ${covered.length === 1 ? 'is' : 'are'} not usable — ${how}`)
    }
    if (uncovered.length > 0) {
      lines.push(`next: ${uncovered.join(', ')} ${uncovered.length === 1 ? 'has' : 'have'} no built-in install recipe; install ${uncovered.length === 1 ? 'it' : 'them'} inside the distribution by hand`)
    }
  } else if (needs.length > 0) {
    lines.push('next: every tool this project asks for resolves on the Linux side')
  }

  return lines.filter((line) => line.length > 0).join('\n\n')
}

/**
 * Map missing commands onto the install recipes that provide them.
 *
 * Exported because it is the one piece of "what to do next" logic the test suite
 * can hold still without a distribution in the loop.
 */
export function suggestionRecipes(commands) {
  const recipes = new Set()
  for (const command of commands) {
    // `npm` is not installable on its own: it arrives with the runtime.
    if (command === 'node' || command === 'npm') recipes.add('node')
    else if (command === 'pnpm' || command === 'yarn' || command === 'corepack') recipes.add('pnpm')
    else if (command === 'python3' || command === 'pip3') recipes.add('python')
    else if (command === 'gcc' || command === 'g++' || command === 'make') recipes.add('build')
    else if (command === 'jq' || command === 'rg' || command === 'rsync' || command === 'curl' || command === 'git') recipes.add('tools')
  }
  // A package manager without a runtime is useless, so the recipe set carries
  // its own dependency.
  if (recipes.has('pnpm')) recipes.add('node')
  return [...recipes]
}

/** Whether a probed path lives on a Windows drive mount (used by the tests). */
export function isWindowsMount(path) {
  return typeof path === 'string' && WINDOWS_MOUNT_RE.test(path)
}
