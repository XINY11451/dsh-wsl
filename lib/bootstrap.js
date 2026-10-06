// Install recipes for `wsl-bootstrap`: what each one needs, the exact commands
// it would run, and how a plan is rendered before anything is executed.
//
// Two rules shape this file.
//
//   1. **A plan is always shown first.** `dryRun` is the default, so the model
//      has to see the commands and ask again to run them. The recipes are apt
//      and a Node tarball today; that list is deliberately short, because an
//      installer that can do anything is an installer nobody can review.
//   2. **Installing inside the distribution needs root**, and WSL's root needs
//      no password (`wsl -u root`, measured), while `sudo` in a tool call cannot
//      answer a prompt at all. So the steps run through `-u root` — which is
//      exactly why this tool is OFF by default in the panel and why its
//      recipes, not the caller, decide every command.

/** Ceiling for one install step: apt on a cold index is slow, a hang is worse. */
export const BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Node LTS into /usr/local, checksum-verified.
 *
 * The LTS line is discovered rather than hardcoded: this file cannot know which
 * major is current when it runs, and a stale major would install an end-of-life
 * runtime that looks like a success. `SHASUMS256.txt` is the same file the
 * download is verified against, so discovery and verification cost one fetch
 * each and both go through the release directory that actually exists.
 *
 * Written for `bash -lc` as root, in `/`. No `${...}` on purpose: this string is
 * interpolated nowhere, but keeping it brace-free makes that checkable by eye.
 */
export const NODE_LTS_SCRIPT = String.raw`set -eu
arch=$(dpkg --print-architecture 2>/dev/null || echo amd64)
case "$arch" in
  amd64) nodeArch=x64 ;;
  arm64) nodeArch=arm64 ;;
  armhf) nodeArch=armv7l ;;
  *) nodeArch=x64 ;;
esac
shasums=$(mktemp)
base=""
for line in 26 24 22 20; do
  if curl -fsS "https://nodejs.org/dist/latest-v$line.x/SHASUMS256.txt" -o "$shasums" 2>/dev/null; then
    base="https://nodejs.org/dist/latest-v$line.x"
    break
  fi
done
if [ -z "$base" ]; then
  rm -f "$shasums"
  echo "node: could not reach nodejs.org for any supported LTS line (tried 26, 24, 22, 20)"
  exit 1
fi
file=$(awk -v suffix="linux-$nodeArch.tar.xz" '$2 ~ suffix"$" { print $2; exit }' "$shasums")
expected=$(awk -v name="$file" '$2 == name { print $1 }' "$shasums")
if [ -z "$file" ]; then
  rm -f "$shasums"
  echo "node: $base has no linux-$nodeArch build"
  exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp" "$shasums"' EXIT
curl -fsS "$base/$file" -o "$tmp/node.tar.xz"
echo "$expected  $tmp/node.tar.xz" | sha256sum -c -
tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1
corepack enable >/dev/null 2>&1 || true
echo "installed: $(node --version) (npm $(npm --version)) from $base/$file"
`

/**
 * One recipe per capability a project plausibly lacks.
 *
 * `check` is what the plan probes: if every command already resolves on the
 * Linux side the recipe is skipped, so a second run is a no-op rather than a
 * reinstall.
 */
export const RECIPES = [
  {
    id: 'node',
    what: 'Node.js LTS into /usr/local, with corepack',
    check: ['node'],
    command: NODE_LTS_SCRIPT,
  },
  {
    id: 'pnpm',
    what: 'pnpm through corepack',
    check: ['pnpm'],
    command: 'corepack enable pnpm && corepack prepare pnpm@latest --activate && pnpm --version',
  },
  {
    id: 'python',
    what: 'python3, pip and venv (apt)',
    check: ['python3', 'pip3'],
    apt: ['python3', 'python3-pip', 'python3-venv'],
  },
  {
    id: 'build',
    what: 'build-essential: gcc, g++, make (apt)',
    check: ['gcc', 'make'],
    apt: ['build-essential'],
  },
  {
    id: 'tools',
    what: 'jq, rsync, curl, git, ca-certificates (apt)',
    check: ['jq', 'rsync', 'curl', 'git'],
    apt: ['jq', 'rsync', 'curl', 'git', 'ca-certificates'],
  },
]

/** Recipe ids, for the tool schema and the error message. */
export const RECIPE_IDS = RECIPES.map((recipe) => recipe.id)

const recipeById = new Map(RECIPES.map((recipe) => [recipe.id, recipe]))

/**
 * Validate a requested recipe list and close it over its dependencies.
 *
 * `pnpm` without a runtime is useless, and the Node recipe downloads with curl —
 * if curl is absent the `tools` recipe has to travel with it, or the plan fails
 * on a machine that looks like it should have worked.
 *
 * @param requested - recipe ids from the caller.
 * @param present - commands already usable on the Linux side (see `parsePresence`).
 * @throws when an id is unknown, naming the valid ones.
 */
export function resolveRecipes(requested, present = {}) {
  const chosen = new Set()
  for (const id of requested) {
    if (!recipeById.has(id)) {
      throw new Error(`wsl-bootstrap: unknown recipe ${JSON.stringify(id)}; valid recipes are ${RECIPE_IDS.join(', ')}`)
    }
    chosen.add(id)
  }
  if (chosen.has('pnpm')) chosen.add('node')
  if ((chosen.has('node') || chosen.has('pnpm')) && present.curl !== true) chosen.add('tools')
  // Stable, dependency-first order: node before pnpm before the apt bulk.
  return RECIPES.filter((recipe) => chosen.has(recipe.id)).map((recipe) => recipe.id)
}

/** The read-only probe that decides which recipes still have work to do. */
export function presenceProbe(recipes = RECIPE_IDS) {
  const commands = []
  for (const id of recipes) {
    const recipe = recipeById.get(id)
    if (recipe !== undefined) commands.push(...recipe.check)
  }
  return [...new Set(commands)]
    .map((command) => `if command -v ${command} >/dev/null 2>&1; then echo "have.${command}=1"; else echo "have.${command}=0"; fi`)
    .join('\n')
}

/** Parse `have.<command>=1|0` output into a plain presence map. */
export function parsePresence(text) {
  const present = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^have\.([A-Za-z0-9_+-]+)=([01])$/.exec(line.trim())
    if (match === null) continue
    present[match[1]] = match[2] === '1'
  }
  return present
}

/**
 * Turn recipes plus presence facts into the steps a run would take.
 *
 * All apt recipes collapse into ONE step: `apt-get update` is the slow half of
 * every apt call, and running it once is the difference between a plan that
 * finishes and one that looks stuck.
 *
 * @returns `{ skipped, steps }`, where each step is
 *   `{ id, what, command, root, simulate }` — `simulate` is the read-only
 *   dry-run form of the same action, `null` when there is none.
 */
export function planFor(recipes, present = {}) {
  const skipped = []
  const steps = []
  const aptPackages = []
  const aptSources = []

  for (const id of recipes) {
    const recipe = recipeById.get(id)
    if (recipe === undefined) continue
    if (recipe.check.every((command) => present[command] === true)) {
      skipped.push({ id, what: recipe.what })
      continue
    }
    if (Array.isArray(recipe.apt)) {
      aptPackages.push(...recipe.apt)
      aptSources.push(id)
      continue
    }
    steps.push({
      id,
      what: recipe.what,
      command: recipe.command,
      root: true,
      // A tarball download has no meaningful simulation, and `corepack` needs the
      // runtime on PATH before it can do anything at all.
      simulate: null,
    })
  }

  if (aptPackages.length > 0) {
    const packages = [...new Set(aptPackages)].sort().join(' ')
    steps.push({
      id: aptSources.join('+'),
      what: `apt packages: ${packages}`,
      command: `export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y ${packages}`,
      root: true,
      simulate: `apt-get -s install -y ${packages}`,
    })
  }

  return { skipped, steps }
}

/** Render the plan the caller reviews before anything runs. */
export function renderPlan({ recipes, skipped, steps }, options = {}) {
  const header = options.distro === null || options.distro === undefined
    ? 'dry run — nothing has been installed'
    : `dry run — nothing has been installed (distro ${options.distro})`
  const lines = [header]

  if (skipped.length > 0) {
    lines.push('already present:\n' + skipped.map((entry) => `  ${entry.id} — ${entry.what}`).join('\n'))
  }
  if (steps.length === 0) {
    lines.push('nothing to install: every requested recipe is already satisfied')
    return lines.join('\n\n')
  }

  const rootNote = 'runs as root inside the distribution (`wsl -u root`, which needs no password)'
  lines.push(`to install (${recipes.join(', ')}):\n` + steps.map((step) =>
    `  [${step.id}] ${step.what} — ${rootNote}\n${step.command.split('\n').map((line) => `      ${line}`).join('\n')}`).join('\n'))

  if (options.simulation !== undefined && options.simulation !== null && options.simulation !== '') {
    lines.push(`apt would report:\n${options.simulation.split('\n').map((line) => `  ${line}`).join('\n')}`)
  }
  lines.push('run it for real with `dryRun: false`.')
  return lines.join('\n\n')
}

/**
 * Render the outcome of an executed plan.
 *
 * @param results - `{ id, what, ok, exitCode, output }` per step, in order.
 */
export function renderOutcome(results) {
  if (results.length === 0) return 'nothing to install: every requested recipe is already satisfied'
  const lines = results.map((result) => {
    const status = result.ok ? 'ok' : `FAILED (exit code ${result.exitCode})`
    const tail = tailOf(result.output, 4000)
    return `[${result.id}] ${result.what}: ${status}${tail === '' ? '' : `\n${tail}`}`
  })
  const failed = results.filter((result) => !result.ok)
  if (failed.length > 0) {
    lines.push('stopped at the first failure; later steps were not run. Fix the cause above, then call ' +
      'wsl-bootstrap again — recipes that are already satisfied are skipped.')
  }
  return lines.join('\n\n')
}

/** Keep the end of a command's output, where the reason for a failure lives. */
export function tailOf(text, maxChars) {
  const value = String(text ?? '').trimEnd()
  if (value.length <= maxChars) return value
  return `… (earlier output dropped)\n${value.slice(value.length - maxChars)}`
}
