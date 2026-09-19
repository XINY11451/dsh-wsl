// dsh-wsl: model-facing WSL tools for DeepSeek Harness (DSH).
//
// Registers three tools:
//   - `wsl`      : run a Linux command through wsl.exe, returning stdout/stderr
//                  with exit-code / signal / timeout / truncation markers.
//   - `wsl-path` : convert between Windows and WSL paths via `wslpath`.
//   - `wsl-env`  : summarize the WSL environment (distros, kernel, cpu, mem,
//                  disk) so an agent knows what it is running on.
//
// Each call runs in a fresh shell, so no state persists between calls. This
// plugin publishes nothing and only consumes the host-plane `subprocess` and
// `tools` registries, so it sits loose in an agent preset without a realm.
//
// The implementation lives in `lib/`: `config` (defaults and environment
// overrides), `paths` (path translation and shell quoting), `guard` (the
// destructive-command rules), `result` (markers and truncation), `runner` (the
// one spawn path) and `tools/` (the three tool definitions).

import { resolveConfig } from './lib/config.js'
import { createRunner } from './lib/runner.js'
import { createWslTool } from './lib/tools/wsl.js'
import { createWslPathTool } from './lib/tools/wsl-path.js'
import { createWslEnvTool } from './lib/tools/wsl-env.js'

export const name = 'tool-wsl'
export const inject = ['tools', 'subprocess']

export function apply(ctx) {
  // Read the environment once per mount: a configuration change is a mount
  // (i.e. a DSH restart), not something a running session re-reads.
  const config = resolveConfig()
  const runner = createRunner(ctx, config)
  // `ctx` is passed for the optional `jobs` service only (background commands);
  // it is read with ctx.get at call time, never injected, so a preset without
  // tool-jobs still mounts this plugin.
  ctx.tools.register(createWslTool({ ctx, config, runner }))
  ctx.tools.register(createWslPathTool({ config, runner }))
  ctx.tools.register(createWslEnvTool({ config, runner }))
}
