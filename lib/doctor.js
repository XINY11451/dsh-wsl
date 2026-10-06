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
  'jq', 'rsync', 'curl', 'git', 'tar', 'sudo',
]

/** Commands whose version is worth a second process; the rest are binary-hunted only. */
const VERSION_COMMANDS = ['node', 'python3', 'gcc', 'docker', 'git', 'make', 'go', 'cargo']

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
  const add = (commands, because, versionHint) => {
    for (const command of commands) {
      const existing = needs.get(command)
      if (existing === undefined) needs.set(command, { command, because: [because], versionHint })
      else if (!existing.because.includes(because)) existing.because.push(because)
      else if (existing.versionHint === null && versionHint !== null) existing.versionHint = versionHint
    }
  }

  for (const entry of manifestsPresent(facts)) add(entry.commands, entry.file, null)

  const manager = facts['pkg.manager'] ?? ''
  if (manager.startsWith('pnpm')) add(['pnpm'], 'package.json packageManager', null)
  else if (manager.startsWith('yarn')) add(['yarn'], 'package.json packageManager', null)

  const engine = facts['pkg.node'] ?? ''
  if (engine !== '') add(['node'], `package.json engines.node ${engine}`, engine)
  if ((facts['pkg.nvmrc'] ?? '') !== '') add(['node'], `.nvmrc ${facts['pkg.nvmrc']}`, facts['pkg.nvmrc'])

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

  const interop = PROBED_COMMANDS
    .map((command) => ({ command, ...commandState(facts, command) }))
    .filter((entry) => entry.state === 'interop')
  if (interop.length > 0) {
    lines.push('Windows binaries on the Linux PATH (interop): ' +
      interop.map((entry) => `${entry.command} -> ${entry.path}`).join(', '))
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

  const blocked = needs.filter((need) => commandState(facts, need.command).state !== 'linux').map((need) => need.command)
  if (blocked.length > 0) {
    const recipes = suggestionRecipes(blocked)
    const how = options.bootstrapAvailable === true
      ? `wsl-bootstrap({ recipes: [${recipes.map((id) => `"${id}"`).join(', ')}] }) installs them inside the distribution (dry run first, then dryRun: false)`
      : `turn on 「wsl-bootstrap 安装工具链」 in the left sidebar's WSL panel, then call wsl-bootstrap({ recipes: [${recipes.map((id) => `"${id}"`).join(', ')}] })`
    lines.push(`next: ${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} not usable — ${how}`)
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
    else if (command === 'jq' || command === 'rsync' || command === 'curl' || command === 'git') recipes.add('tools')
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
