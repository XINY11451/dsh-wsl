// dsh-wsl: model-facing WSL tools for DeepSeek Harness (DSH).
//
// Registers up to three tools, each one switchable from the plugin's
// left-sidebar panel:
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
// The implementation lives in `lib/`: `config` (defaults, environment overrides
// and the plugin's own switches), `paths` (path translation and shell quoting),
// `guard` (the destructive-command rules), `result` (markers and truncation),
// `runner` (the one spawn path), `tools/` (the three tool definitions) and
// `client.js` (the sidebar panel, a separate web-platform bundle).
//
// A configuration change is a mount, not something a running session re-reads:
// every switch below is consulted once, in `apply`.

import { resolveConfig } from './lib/config.js'
import { createRunner } from './lib/runner.js'
import { createWslTool } from './lib/tools/wsl.js'
import { createWslPathTool } from './lib/tools/wsl-path.js'
import { createWslEnvTool } from './lib/tools/wsl-env.js'

export const name = 'tool-wsl'
export const inject = ['tools', 'subprocess']

// The schema is what gives this plugin a settings surface at all: the platform
// derives the namespace the sidebar panel writes to from the entry's id plus this
// schema. It needs `@deepseek-ai/schemastery`, which a real DSH profile supplies
// (the plugin declares it as an optional peer dependency) but which is absent when
// this module is imported standalone, as `test/smoke.mjs` does. A soft import
// keeps the tools runnable there: without a schema every switch keeps its default
// and only the panel is missing.
let Schema = null
try {
  ({ Schema } = await import('@deepseek-ai/schemastery'))
} catch {
  Schema = null
}

/**
 * The plugin's own configuration.
 *
 * Every field is ALSO settable by hand in a profile patch
 * (`- id: tool-wsl` / `config:`) and by the environment, and `lib/config.js`
 * documents the precedence: this configuration wins, the environment is the
 * deployment default, the built-in defaults are last.
 *
 * `distro` and `timeoutMs` are deliberately absent from the sidebar panel (they
 * are values, not features) but stay here so a patch or a panel could grow a
 * field for them without a schema change.
 */
export const Config = Schema?.object({
  tools: Schema.object({
    wsl: Schema.boolean().default(true).description('注册 `wsl` 工具：在 WSL 里执行 Linux 命令。'),
    path: Schema.boolean().default(true).description('注册 `wsl-path` 工具：Windows 路径与 /mnt/... 互转。'),
    env: Schema.boolean().default(true).description('注册 `wsl-env` 工具：汇总 WSL 环境能力。'),
  }).description('要注册哪几个工具。'),
  backgroundJobs: Schema.boolean().default(true).description('允许 `runInBackground`，由内置 job 工具读回结果。'),
  translatePaths: Schema.boolean().default(true).description('默认把命令里的 Windows 路径转成 /mnt/...。'),
  startInSessionWorkspace: Schema.boolean().default(false).description('未传 `workdir` 时从会话工作区开始，而不是 Linux 家目录。'),
  dangerGuard: Schema.boolean().default(true).description('危险命令必须显式 `allowDangerous` 才放行。关掉后模型可直接删除/分区。'),
  distro: Schema.string().default('').description('要固定使用的发行版；留空则用系统默认（也可用 DSH_WSL_DISTRO）。'),
  timeoutMs: Schema.number().default(0).description('默认命令超时毫秒数；0 表示用内置默认（也可用 DSH_WSL_TIMEOUT_MS）。'),
}).description('dsh-wsl 的功能开关与默认值。')

export function apply(ctx, settings = {}) {
  // Resolved once per mount: a settings change is a restart, not a live edit.
  const config = resolveConfig(process.env, settings)
  const runner = createRunner(ctx, config)
  // `ctx` is passed to the `wsl` tool for the optional `jobs` service only
  // (background commands); it is read with ctx.get at call time, never injected,
  // so a preset without tool-jobs still mounts this plugin.
  if (config.tools.wsl) ctx.tools.register(createWslTool({ ctx, config, runner }))
  if (config.tools.path) ctx.tools.register(createWslPathTool({ config, runner }))
  if (config.tools.env) ctx.tools.register(createWslEnvTool({ config, runner }))
}
