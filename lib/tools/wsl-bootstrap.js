// The `wsl-bootstrap` tool: install the toolchain a project needs inside the
// distribution.
//
// Off by default in the panel, and the two gates are deliberate:
//
//   1. the tool is only MOUNTED when the user turns on 「wsl-bootstrap 安装工具链」,
//      so a model cannot discover it on a profile where nobody asked for it, and
//   2. `dryRun` defaults to TRUE, so the first call prints the commands and the
//      caller has to ask a second time to run them.
//
// The steps come from lib/bootstrap.js, never from the caller: this tool can
// install five known recipes and nothing else. It is the only place the plugin
// runs as root on its own initiative, which is why the recipe list is short and
// every recipe is spelled out in the plan.

import { BOOTSTRAP_TIMEOUT_MS, parsePresence, planFor, presenceProbe, RECIPE_IDS, renderOutcome, renderPlan, resolveRecipes } from '../bootstrap.js'

/** Reading the apt index to simulate an install: slower than a probe, faster than an install. */
const SIMULATE_TIMEOUT_MS = 60 * 1000

export function createWslBootstrapTool({ config, runner }) {
  return {
    name: 'wsl-bootstrap',
    description:
      'Install the toolchain a project needs inside the WSL distribution: ' + RECIPE_IDS.join(', ') + '. ' +
      'Steps run as root inside the distribution (`wsl -u root`, which needs no password), because `sudo` cannot ' +
      'answer a prompt from a tool call. The recipes are fixed and the plan shows every command, so nothing ' +
      'arbitrary can be installed. dryRun defaults to TRUE and only prints the plan; call again with ' +
      '`dryRun: false` to install. Satisfied recipes are skipped.',
    parameters: {
      type: 'object',
      properties: {
        recipes: {
          type: 'array',
          items: { type: 'string', enum: RECIPE_IDS },
          description: 'Recipes to install: `node` (Node.js LTS + corepack), `pnpm`, `python` (python3 + pip + venv), '
            + '`build` (build-essential), `tools` (jq, rsync, curl, git). Dependencies are added when needed.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Default true: print the exact commands and change nothing. Set false to install.',
        },
        distro: {
          type: 'string',
          description: 'WSL distribution to install into. Defaults to the system default.',
        },
      },
      required: ['recipes'],
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
    async execute(args, exec) {
      if (!Array.isArray(args.recipes) || args.recipes.length === 0) {
        throw new Error(`wsl-bootstrap: recipes must be a non-empty array of ${RECIPE_IDS.join(', ')}`)
      }
      for (const id of args.recipes) {
        if (typeof id !== 'string') throw new Error('wsl-bootstrap: every recipe must be a string')
      }
      if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') {
        throw new Error('wsl-bootstrap: dryRun must be a boolean')
      }

      const resolved = runner.resolveDistro(args.distro)
      // `/` on purpose: installing is not about a project directory, and the
      // session workspace may be a slow Windows mount.
      const opts = { distro: args.distro, workdir: '/', exec }

      // Presence is probed for EVERY recipe's commands, not only the requested
      // ones: the closure below needs to know whether `curl` exists before it can
      // decide whether the `tools` recipe has to travel with `node`.
      const probe = await runner.runWsl(presenceProbe(), {
        ...opts,
        timeoutMs: config.internalTimeoutMs,
      })
      if (probe.exitCode !== 0) {
        const detail = (probe.stderr.trim() || probe.stdout.trim() || `exit code ${probe.exitCode}`).split(/\r?\n/)[0]
        throw new Error(
          `wsl-bootstrap: could not inspect ${resolved === null ? 'the default distribution' : `distro "${resolved}"`}: ${detail}`,
        )
      }
      const present = parsePresence(probe.stdout)
      // Throws with the valid list when an id is unknown — before anything runs.
      const recipes = resolveRecipes(args.recipes, present)
      const plan = planFor(recipes, present)

      if (plan.steps.length === 0) {
        return { summary: renderPlan({ recipes, ...plan }, { distro: resolved }) }
      }

      if (args.dryRun !== false) {
        // Best effort: `apt-get -s` reports what apt WOULD do without touching
        // anything. A failure here (a stale index, a package the mirror does not
        // have) is worth reporting, but it must not replace the plan.
        const aptStep = plan.steps.find((step) => step.simulate !== null)
        let simulation = null
        if (aptStep !== undefined) {
          const sim = await runner.runWsl(aptStep.simulate, { ...opts, timeoutMs: SIMULATE_TIMEOUT_MS })
          simulation = [sim.stdout, sim.stderr].filter((text) => text.trim() !== '').join('\n').trim() || null
        }
        return { summary: renderPlan({ recipes, ...plan }, { distro: resolved, simulation }) }
      }

      const results = []
      for (const step of plan.steps) {
        const run = await runner.runWsl(step.command, {
          ...opts,
          asRoot: step.root === true,
          timeoutMs: BOOTSTRAP_TIMEOUT_MS,
        })
        const output = [run.stdout, run.stderr].filter((text) => text.trim() !== '').join('\n')
        const ok = run.exitCode === 0 && run.timedOut !== true
        results.push({
          id: step.id,
          what: step.what,
          ok,
          exitCode: run.timedOut === true ? 'timed out' : run.exitCode,
          output,
        })
        // Stop at the first failure: a later step may depend on this one (pnpm
        // needs node), and half-installed state is easier to reason about when
        // the log ends where the trouble started.
        if (!ok) break
      }
      return { summary: renderOutcome(results) }
    },
    presentCall: () => ({ card: 'generic', title: 'Install toolchain in WSL' }),
  }
}
