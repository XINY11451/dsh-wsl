// dsh-wsl: model-facing WSL tools for DeepSeek Harness (DSH).
//
// Registers up to six tools, each one switchable from the plugin's left-sidebar
// panel (`wsl-term` has no switch: opening a terminal is the consent it needs):
//   - `wsl`          : run a Linux command through wsl.exe, returning stdout/stderr
//                      with exit-code / signal / timeout / truncation markers.
//   - `wsl-path`     : convert between Windows and WSL paths via `wslpath`.
//   - `wsl-env`      : summarize the WSL environment (distros, kernel, cpu, mem,
//                      disk) so an agent knows what it is running on.
//   - `wsl-doctor`   : compare a project's toolchain with what the distro really has.
//   - `wsl-bootstrap`: install a fixed toolchain recipe inside the distro (dry run first).
//   - `wsl-term`     : drive the session's own terminal / a private PTY across steps.
//
// `wsl` runs each command in a fresh shell, so no state persists between its calls;
// `wsl-term` is the one shell that does. This plugin publishes nothing into an agent
// preset — its own `cordis.patch.yml` inserts the `tool-wsl` row process-wide, which is
// why the tools reach every preset with no preset entry of its own (and why adding one
// there would fail). It consumes the host-plane `tools` and `subprocess` registries and
// reads a few optional services at call time (`jobs`, `webServer`, `profileContext`,
// `terminalController`, `spillStore`, `shellEnv`); every one of them may be absent.
//
// The implementation lives in `lib/`: `config` (defaults, environment overrides
// and the plugin's own switches), `paths` (path translation and shell quoting),
// `guard` (the destructive-command rules), `result` (markers and truncation),
// `runner` (the one spawn path), `tools/` (the tool definitions), `terminal*` /
// `pty-transport` / `term-bridge` (the terminal engine) and `client.js` (the
// sidebar panel, a separate web-platform bundle).
//
// A configuration change is a mount, not something a running session re-reads: every
// switch below is consulted once, in `apply`, and re-read in place on a volatile update.

import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { CAPABILITY_PROBE, capabilityLines, parseFacts } from './lib/diagnostics.js'
import { parseDefaultDistro } from './lib/tools/wsl-env.js'
import { resolveConfig } from './lib/config.js'
import { pickSchemaBuilder } from './lib/schema.js'
import { createRunner } from './lib/runner.js'
import {
  readTerminalCwd,
  readTerminalScrollback,
  reviewTerminalWrite,
  verifyTerminalRewrite,
  verifyTerminalScrollbackRewrite,
  writeTerminalCwd,
  writeTerminalScrollback,
} from './lib/terminal-cwd.js'
import { createWslTool } from './lib/tools/wsl.js'
import { createWslPathTool } from './lib/tools/wsl-path.js'
import { createWslEnvTool } from './lib/tools/wsl-env.js'
import { createWslDoctorTool } from './lib/tools/wsl-doctor.js'
import { createWslBootstrapTool } from './lib/tools/wsl-bootstrap.js'
import { createWslReadTool } from './lib/tools/wsl-read.js'
import { createWslWriteTool } from './lib/tools/wsl-write.js'
import { createWslEditTool } from './lib/tools/wsl-edit.js'
import { createWslGrepTool } from './lib/tools/wsl-grep.js'
import { createWslTermTool } from './lib/tools/wsl-term.js'
import { createLazyTerminalTransport } from './lib/pty-transport.js'
import { answerJson, isJsonRequest, readJsonBody } from './lib/http.js'
import { createSubtaskLog, projectSubtask } from './lib/subtasks.js'
import { createChannel } from './lib/channel.js'
import { execFile } from 'node:child_process'

export const name = 'tool-wsl'
export const inject = ['tools', 'subprocess']

// The schema is what gives this plugin a settings surface at all: the platform
// projects the config of every entry that declares one (`ctx.settings.describe()`
// is keyed by entry id), and the sidebar panel reads and writes that projection.
// It needs `@deepseek-ai/schemastery`, which a real DSH profile supplies (the
// plugin declares it as an optional peer dependency) but which is absent when this
// module is imported standalone, as `test/smoke.mjs` does. A soft import keeps the
// tools runnable there: without a schema every switch keeps its default and only
// the panel is missing — and `lib/schema.js` explains why the PICKING, not just
// the import, is the fragile part.
let Schema = null
try {
  Schema = pickSchemaBuilder(await import('@deepseek-ai/schemastery'))
} catch {
  Schema = null
}
if (Schema === null) {
  // Not fatal — the tools run on their defaults — but it is exactly the difference
  // between a panel with switches and one without, so say so instead of failing
  // quietly.
  console.warn(
    'dsh-wsl-tool: no schema builder (@deepseek-ai/schemastery) — the tools run on ' +
    'their defaults and the sidebar panel will not offer the switches',
  )
}

/**
 * The plugin's own configuration, in one place, and the tolerance around building it.
 *
 * Every field is ALSO settable by hand in a profile patch
 * (`- id: tool-wsl` / `config:`) and by the environment, and `lib/config.js`
 * documents the precedence: this configuration wins, the environment is the
 * deployment default, the built-in defaults are last.
 *
 * `distro` and `timeoutMs` are values rather than switches, but they are here so a
 * patch (or a future row in the panel) can set them without a schema change.
 *
 * EVERY field is `.volatile()`, and that is not decoration: DSH's settings service
 * projects a plugin's config into a form only through `volatileForm()`, which keeps
 * a field only when its nearest ancestor is marked volatile — a schema without one
 * contributes no form at all, so the entry never reaches `ctx.settings.describe()`,
 * its namespace is never served to the browser, and the sidebar panel waits for a
 * scope that will never arrive. Volatile is also what the platform means by "can be
 * edited without remounting", which is what the update hook below relies on.
 *
 * A volatile field must not sit inside another volatile one, so `tools` is a plain
 * object whose leaf switches are volatile, not a volatile object.
 */
export function buildConfig(Schema) {
  if (Schema === null || Schema === undefined) return undefined
  try {
    return defineConfig(Schema)
  } catch (error) {
    // A builder that is present but is not the one this plugin expects (an incompatible
    // `@deepseek-ai/schemastery` in the profile) used to throw HERE, at module scope, during
    // import — so all six tools disappeared instead of degrading to "no panel". Building the
    // schema must never be the thing that decides whether a tool exists.
    console.warn(
      'dsh-wsl-tool: building the Config schema failed — the tools run on their defaults ' +
      'and the sidebar panel will not offer the switches',
      error,
    )
    return undefined
  }
}

/** The schema itself, in one place; the builder is supplied by {@link buildConfig}. */
function defineConfig(Schema) {
  return Schema.object({
  tools: Schema.object({
    wsl: Schema.boolean().default(true).description('注册 `wsl` 工具：在 WSL 发行版中执行 Linux 命令。').volatile(),
    path: Schema.boolean().default(true).description('注册 `wsl-path` 工具：在 Windows 路径与 `/mnt/...` 之间互转。').volatile(),
    env: Schema.boolean().default(true).description('注册 `wsl-env` 工具：汇总发行版、内核、systemd、cgroup、GPU 直通、docker 与挂载盘。').volatile(),
    doctor: Schema.boolean().default(false).description('注册 `wsl-doctor` 工具：对照项目清单与发行版实际能力，指出缺什么，以及哪些命令其实是 Windows 的。默认关（诊断类，需要时再开）。').volatile(),
    bootstrap: Schema.boolean().default(false).description('注册 `wsl-bootstrap` 工具：在发行版里补装缺失的工具链。默认关；打开后它以 root 执行固定配方，且调用方仍需显式 `dryRun: false`。').volatile(),
    read: Schema.boolean().default(true).description('注册 `wsl-read` 工具：读取发行版内的文本文件，可按行分页；二进制与非 UTF-8 文件明确报错，不返回乱码。').volatile(),
    write: Schema.boolean().default(true).description('注册 `wsl-write` 工具：写入发行版内的文本文件，整文件替换；先写同目录临时文件再改名，失败不留半截文件。').volatile(),
    edit: Schema.boolean().default(true).description('注册 `wsl-edit` 工具：在发行版内的文件里做精确字符串替换；要求唯一匹配，文件须为 2 MiB 以内的 UTF-8 文本。').volatile(),
    grep: Schema.boolean().default(true).description('注册 `wsl-grep` 工具：在发行版内按正则搜索文件内容，按文件分组返回行号；有 `rg` 用 `rg`，没有则退回 GNU `grep -E`。').volatile(),
  }).description('要注册哪些工具；改动即时生效（面板开关一拨，工具就出现或消失，不需要重启）。'),
  backgroundJobs: Schema.boolean().default(true).description('允许长任务以 `runInBackground` 后台执行，结果由内置 job 工具读取。').volatile(),
  translatePaths: Schema.boolean().default(true).description('命令中的 Windows 路径默认转为 `/mnt/...`。').volatile(),
  startInSessionWorkspace: Schema.boolean().default(true).description('未传 `workdir` 时从会话目录启动；默认开。关闭后使用下方固定目录，该目录留空时为家目录 `~`。').volatile(),
  workdir: Schema.string().default('').description('未传 `workdir` 时使用的固定 Linux 目录（如 `/mnt/d/project`），优先于「跟随会话工作区」；留空表示不指定。').volatile(),
  dangerGuard: Schema.boolean().default(true).description('危险命令（删除、分区、关机等）需显式 `allowDangerous` 才放行；关闭后模型可直接执行。').volatile(),
  allowRoot: Schema.boolean().default(false).description('允许 `wsl` 与四个文件工具（`wsl-read`/`wsl-write`/`wsl-edit`/`wsl-grep`）以 root 执行（`asRoot: true`）。WSL 的 root 免密，所以这项开关就是授权本身；默认关。').volatile(),
  channelEnabled: Schema.boolean().default(false).description('启用 WSL 通道：在 WSL 终端里用 `dsh -- "问题"` 把话发进指定会话，回复流式回到终端。默认关。').volatile(),
  channelSession: Schema.string().default('').description('WSL 通道的落点会话 id；留空表示使用最近活跃的会话（通常就是你在看的那段对话）。终端里的 `dsh use <id>` 可临时切换。').volatile(),
  autoInstallShim: Schema.boolean().default(true).description('启动时检查 WSL 里的 dsh 命令：没安装或与当前版本不一致就自动装好，不用再手动点「安装」。默认开。').volatile(),
  distro: Schema.string().default('').description('固定使用的发行版；留空表示使用系统默认（也可用 `DSH_WSL_DISTRO`）。').volatile(),
  timeoutMs: Schema.number().default(0).description('默认命令超时（毫秒）；0 表示使用内置默认（也可用 `DSH_WSL_TIMEOUT_MS`）。').volatile(),
  }).description('dsh-wsl 的功能开关与默认值。')
}

/** The plugin's config, or `undefined` when no usable builder is available. */
export const Config = buildConfig(Schema)

/**
 * The read-only route the browser half fetches for 「复制插件信息」. Namespaced under
 * the published package name so it cannot collide with another plugin's route.
 */
const INFO_ROUTE = '/dsh-wsl-tool/info'

/**
 * The sidebar terminal's startup directory, as one GET/POST pair.
 *
 * That value does NOT live in this plugin's configuration: the 新建终端 shell belongs
 * to another plugin, and only the profile's own patch layer can override its `args`.
 * So the panel edits that file through these routes, and `lib/terminal-cwd.js` owns the
 * rules for doing it safely (one line, backed up first, read back afterwards).
 *
 * `GET`  -> `{ path, available, error }`: what the patch says now, and whether the
 *           terminal row is there at all (`available: false` means the opt-in has not
 *           been applied, which is a different instruction than an empty value).
 * `POST` -> `{ ok, path, error }`, body `{ path }`; `path: ''` removes the flag.
 */
const TERMINAL_ROUTE = '/dsh-wsl-tool/terminal-cwd'

/**
 * The panel's WSL-channel facts and its one install action (`index.js` publishes them
 * beside the other routes; the `dsh` CLI inside WSL never uses these — it talks to the
 * channel's own server with the token from `channel.json`).
 */
const CHANNEL_STATE_ROUTE = '/dsh-wsl-tool/channel'
const CHANNEL_INSTALL_ROUTE = '/dsh-wsl-tool/channel-install'
const CHANNEL_NEW_ROUTE = '/dsh-wsl-tool/channel-new'
/**
 * Candidate directories for the panel's two path settings, read from the distro so a user
 * picks instead of typing. Read-only and best effort: a stopped WSL simply answers [].
 */
const PATHS_ROUTE = '/dsh-wsl-tool/paths'
/**
 * One directory listing for the panel's path browser: `?path=` (a WSL path, `~` allowed)
 * answers the normalized directory, its parent and its immediate subdirectories. The
 * panel walks parent/child through this, so any directory in the distro is reachable
 * without typing before the final choice.
 */
const DIRS_ROUTE = '/dsh-wsl-tool/dirs'
/** What the client's dock row above the composer reads. */
const SUBTASK_ROUTE = '/dsh-wsl-tool/subtasks'

/** The profile patch layer this plugin reads and edits, under `DSH_PROFILE_DIR`. */
const PATCH_FILE_NAME = 'cordis.patch.yml'

/**
 * The profile patch this process was started with, or `null` when it cannot be found.
 *
 * The host's own answer comes first: `profileContext.patchPath` is the file the platform's
 * settings UI edits — `dsh-app-boot` and `dsh-config-editor` both read it, and it is the
 * only reliable source. `DSH_PROFILE_DIR` is injected into MODEL TOOL subprocesses, not
 * into the desktop host process itself: measured, the host answered "no DSH_PROFILE_DIR"
 * while the profile patch sat exactly where it belonged. The environment therefore stays
 * as a fallback for a test or a host without that service, never as the primary.
 *
 * Read at REQUEST time rather than captured at mount: the value belongs to the host, and a
 * request that cannot name a file must say so instead of writing to a path from boot.
 */
function resolvePatchFile(ctx, env) {
  let service
  try {
    service = ctx === undefined || ctx === null || typeof ctx.get !== 'function'
      ? undefined
      : ctx.get('profileContext')
  } catch {
    service = undefined
  }
  const patchPath = service === undefined || service === null ? undefined : service.patchPath
  if (typeof patchPath === 'string' && patchPath.trim() !== '') return patchPath.trim()
  const dir = env === undefined || env === null ? undefined : env.DSH_PROFILE_DIR
  if (typeof dir === 'string' && dir.trim() !== '') return join(dir.trim(), PATCH_FILE_NAME)
  return null
}

/** Why the file could not be named, worded so the next reader knows where to look. */
const NO_PATCH_ERROR = '宿主既没有 profileContext.patchPath 也没有 DSH_PROFILE_DIR，读不到 profile 的 patch 文件'

/**
 * How many of THIS plugin's own backups to keep beside the patch.
 *
 * One backup per save is the point — the file is the user's composition — but leaving
 * every one of them forever would litter the profile directory. Old ones are pruned by
 * age, and only files matching the exact name this plugin writes are ever considered.
 */
const MAX_PATCH_BACKUPS = 10

/**
 * `cordis.patch.yml.bak-YYYYMMDD-HHMMSSmmm` (with a `-N` counter as a last resort).
 *
 * The millisecond field is not cosmetic: pruning FREES names, and without it the next
 * save reuses the un-suffixed name of the second — so a freed (old) name would sort as
 * the newest and the wrong backup would be deleted. The older name without milliseconds is
 * still recognized, so backups written by a previous build are pruned by the same rule.
 */
const BACKUP_NAME_RE = /\.bak-(\d{8})-(\d{6})(\d{3})?(?:-(\d+))?$/

/**
 * The chronological key a backup name carries: fixed-width stamp text, then the counter.
 *
 * A string, not a number: `YYYYMMDDHHMMSSmmm` is 17 digits, past what a double holds
 * exactly, and fixed width means plain string comparison IS chronological.
 */
function backupOrder(name) {
  const match = BACKUP_NAME_RE.exec(name)
  if (match === null) return { stamp: '', counter: 0 }
  return {
    stamp: `${match[1]}${match[2]}${match[3] ?? '000'}`,
    counter: match[4] === undefined ? 1 : Number(match[4]),
  }
}

/**
 * Copy the patch next to itself before touching it.
 *
 * The file is the user's own composition: an edit that turns out badly has to be
 * recoverable by hand even if this process dies mid-write. The stamp carries milliseconds
 * (with a counter as a last resort), and no colons, because Windows refuses those in a
 * file name.
 */
function backupPatchFile(file) {
  const iso = new Date().toISOString()
  // 20261005-144428123, no colons: Windows refuses them in a file name.
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}${iso.slice(20, 23)}`
  let target = `${file}.bak-${stamp}`
  let suffix = 2
  while (existsSync(target)) {
    target = `${file}.bak-${stamp}-${suffix}`
    suffix += 1
  }
  copyFileSync(file, target)
  return target
}

/**
 * Keep the newest {@link MAX_PATCH_BACKUPS} backups of one patch, delete the rest.
 *
 * Deliberately conservative: a file is a candidate only when its name starts with this
 * patch's name and matches the exact stamp format above, so a `.bak` the user made by
 * hand (or another patch's backup) is never touched. `keep` is the backup that was just
 * written and is never a candidate, whatever the mtimes say. Never throws — a backup that
 * could not be pruned is a tidiness problem, not a reason to fail a save.
 */
function prunePatchBackups(file, keep) {
  const dir = dirname(file)
  const prefix = `${basename(file)}.bak-`
  const protectedName = typeof keep === 'string' ? basename(keep) : ''
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const mine = []
  for (const name of names) {
    if (name === protectedName) continue
    if (!name.startsWith(prefix) || !BACKUP_NAME_RE.test(name)) continue
    let time = 0
    try {
      time = statSync(join(dir, name)).mtimeMs
    } catch {
      // Raced away (or unreadable): it cannot be ordered, so treat it as the oldest.
    }
    mine.push({ name, time, order: backupOrder(name) })
  }
  // The backup just written counts against the budget too, so the total on disk never
  // exceeds the cap.
  const reserved = protectedName !== '' && names.includes(protectedName) ? 1 : 0
  const budget = MAX_PATCH_BACKUPS - reserved
  if (mine.length <= budget) return
  // Newest first by mtime, with the name's own timestamp as the tie-break so a burst of
  // saves in one clock tick still has a defined order.
  mine.sort((left, right) => {
    if (right.time !== left.time) return right.time - left.time
    if (left.order.stamp !== right.order.stamp) return left.order.stamp < right.order.stamp ? 1 : -1
    return right.order.counter - left.order.counter
  })
  for (const entry of mine.slice(budget)) {
    try {
      rmSync(join(dir, entry.name), { force: true })
    } catch (error) {
      console.warn('dsh-wsl-tool: could not prune an old profile-patch backup', error)
    }
  }
}

/**
 * Serve the terminal startup directory.
 *
 * Takes the host context because the file's location comes from it
 * (`profileContext.patchPath`). Never throws: every failure becomes a structured answer the
 * panel can show, because a 500 here would take the panel's field down without saying why.
 */
async function serveTerminalCwd(ctx, request, response) {
  const file = resolvePatchFile(ctx, process.env)
  if (file === null) {
    answerJson(response, 200, { ok: false, path: '', scrollback: null, available: false, error: NO_PATCH_ERROR })
    return
  }

  if (request.method === 'GET') {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      answerJson(response, 200, { path: '', scrollback: null, available: false, error: `读不到 ${PATCH_FILE_NAME}` })
      return
    }
    const cwdRead = readTerminalCwd(text)
    const scrollRead = readTerminalScrollback(text)
    answerJson(response, 200, {
      path: cwdRead.path,
      scrollback: scrollRead.value,
      available: cwdRead.row,
      error: cwdRead.error ?? scrollRead.error,
    })
    return
  }

  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'GET, POST' })
    response.end()
    return
  }

  // This route WRITES a file in the user's profile, and the host's web server carries no
  // origin policy of its own (its README: "route owners … enforce their own request
  // policy"). Requiring the JSON content type is the same gate the platform's own upload
  // route uses: `application/json` is not a CORS-safelisted content type, so a cross-site
  // page can only send it after a preflight — and this server answers no preflight — while
  // a form or a `no-cors` fetch cannot set it at all. The panel is same-origin and already
  // sends it, so this costs an honest caller nothing and keeps a hostile page from
  // rewriting the patch.
  if (!isJsonRequest(request)) {
    answerJson(response, 415, { ok: false, path: '', scrollback: null, error: '请求必须是 application/json' })
    return
  }

  const body = await readJsonBody(request)
  if (body.error !== undefined) {
    answerJson(response, 400, { ok: false, path: '', scrollback: null, error: body.error })
    return
  }
  const wantsPath = typeof body.value.path === 'string'
  const wantsScrollback = body.value.scrollback !== undefined && body.value.scrollback !== null
  if (!wantsPath && !wantsScrollback) {
    answerJson(response, 400, { ok: false, path: '', scrollback: null, error: '请求体里需要 path 或 scrollback 字段' })
    return
  }
  // One property per request: the write is only accepted when exactly one line changed,
  // and that guarantee is what makes a mis-write recoverable.
  if (wantsPath && wantsScrollback) {
    answerJson(response, 400, { ok: false, path: '', scrollback: null, error: '一次请求只能修改一项' })
    return
  }

  let original
  try {
    original = readFileSync(file, 'utf8')
  } catch {
    answerJson(response, 200, { ok: false, path: '', scrollback: null, error: `读不到 ${PATCH_FILE_NAME}` })
    return
  }

  const currentPath = readTerminalCwd(original).path
  const currentScrollback = readTerminalScrollback(original).value
  const refused = (error) => answerJson(response, 200, { ok: false, path: currentPath, scrollback: currentScrollback, error })

  // Bad input (a line break, a quote, a non-number) and an unrecognized file both stop
  // HERE, with the file still byte-for-byte what it was.
  const next = wantsPath ? writeTerminalCwd(original, body.value.path) : writeTerminalScrollback(original, body.value.scrollback)
  if (!next.ok) {
    refused(next.error)
    return
  }
  if (next.text === original) {
    // Already what was asked for: no write, and no backup for a no-op.
    answerJson(response, 200, { ok: true, path: currentPath, scrollback: currentScrollback, error: null })
    return
  }

  let backup
  try {
    backup = backupPatchFile(file)
  } catch (error) {
    console.warn('dsh-wsl-tool: could not back up the profile patch', error)
    refused('备份 profile patch 失败，未改动文件')
    return
  }
  prunePatchBackups(file, backup)

  /**
   * Put the previous content back and describe what happened.
   *
   * `writeFileSync` truncates before it writes, so a failure part-way through (ENOSPC, EIO,
   * a dropped network share) can leave the user's hand-written patch truncated — the same
   * class of surprise the verify path already undoes, and it must not be left behind either.
   * @param {string} reason - what the caller should be told first.
   */
  const restoreAndRefuse = (reason) => {
    let restored = true
    try {
      writeFileSync(file, original, 'utf8')
    } catch (error) {
      console.error('dsh-wsl-tool: could not restore the profile patch', error)
      restored = false
    }
    refused(`${reason}${restored ? '，已还原' : '，且还原失败，请从备份恢复'}`)
  }

  try {
    writeFileSync(file, next.text, 'utf8')
  } catch (error) {
    console.warn('dsh-wsl-tool: writing the profile patch failed', error)
    restoreAndRefuse('写入 profile patch 失败')
    return
  }

  // Read back what actually landed. Anything other than exactly one changed line is
  // undone from the copy held in memory, so a surprise never stays in the user's file —
  // unless the file is no longer our text at all, which means somebody else wrote to it
  // after us and their version must not be overwritten.
  let written = null
  try {
    written = readFileSync(file, 'utf8')
  } catch {
    written = null
  }
  const verify = wantsPath ? verifyTerminalRewrite : verifyTerminalScrollbackRewrite
  const expected = wantsPath ? next.path : next.value
  const review = reviewTerminalWrite(original, written, next.text, expected, verify)
  if (review.verdict === 'conflict') {
    answerJson(response, 200, { ok: false, path: '', scrollback: null, error: review.error })
    return
  }
  if (review.verdict === 'undo') {
    restoreAndRefuse(`写入校验失败（${review.error}）`)
    return
  }

  answerJson(response, 200, {
    ok: true,
    path: readTerminalCwd(next.text).path,
    scrollback: readTerminalScrollback(next.text).value,
    error: null,
  })
}

/** Read this package's own manifest once; a broken manifest must not break the route. */
let manifestCache
function readManifest() {
  if (manifestCache !== undefined) return manifestCache
  try {
    manifestCache = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  } catch {
    manifestCache = null
  }
  return manifestCache
}

/** Only a DSH package counts as the application: never this plugin's own manifest. */
const DSH_PACKAGE = /^@deepseek-ai\/dsh(?:-desktop|-desktop-host)?$/

/**
 * The DSH build this plugin is running inside, best effort.
 *
 * There is no environment variable for it — measured on the desktop build:
 * `DSH_HOME`, `DSH_PROFILE`, `DSH_PROFILE_DIR`, `DSH_SESSION_ID`, `DSH_SHELL` and
 * `DSH_WEB_URL`, and no version. So it is read from the application's own manifest
 * instead: the host process is `<install>\DeepSeek Harness.exe`, whose asar sits at
 * `resources/app.asar`, and the CLI entry in `argv[1]` leads into the same tree. Both
 * routes are tried, and a candidate is accepted only when its manifest belongs to a
 * DSH package, so a wrong guess degrades to "unreadable" rather than to a wrong
 * version number.
 */
function dshVersion() {
  const candidates = []
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    const install = dirname(process.execPath)
    candidates.push(join(install, 'resources', 'app.asar', 'package.json'))
    candidates.push(join(install, 'resources', 'app', 'package.json'))
  }
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') {
    let dir = dirname(process.argv[1])
    for (let level = 0; level < 4; level += 1) {
      candidates.push(join(dir, 'package.json'))
      dir = dirname(dir)
    }
  }
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
      if (typeof manifest?.name !== 'string' || !DSH_PACKAGE.test(manifest.name)) continue
      if (typeof manifest.version === 'string' && manifest.version !== '') {
        return { name: manifest.name, version: manifest.version }
      }
    } catch {
      // Missing, unreadable or not JSON: the next candidate's turn.
    }
  }
  return null
}

/**
 * The WSL facts worth copying — the default distribution, the kernel and the
 * capability flags that `wsl-env` reports. Probes run concurrently (one WSL round
 * trip each) and every one of them is allowed to fail: a machine without WSL still
 * produces the rest of the block, and the copied text never invents a value.
 */
async function wslFacts(runner, config) {
  const attempt = (promise) => Promise.resolve(promise).catch(() => null)
  const opts = { distro: undefined, timeoutMs: config.internalTimeoutMs, exec: undefined }
  const [uname, list, caps] = await Promise.all([
    attempt(runner.runWsl('uname -srm', opts)),
    attempt(runner.spawnWsl(['wsl.exe', '-l', '-v'], config.internalTimeoutMs)),
    attempt(runner.runWsl(CAPABILITY_PROBE, opts)),
  ])
  const facts = {
    defaultDistro: list !== null && list.exitCode === 0 ? parseDefaultDistro(list.stdout) : null,
    kernel: uname !== null && uname.exitCode === 0 ? uname.stdout.trim() : null,
    capabilities: caps !== null && caps.exitCode === 0 ? capabilityLines(parseFacts(caps.stdout)) : null,
  }
  if (facts.defaultDistro === null && facts.kernel === null && facts.capabilities === null) return null
  return facts
}

/**
 * This plugin's own facts, as the panel copies them out.
 *
 * The version comes from the manifest next to this file rather than from a string
 * written here, so a release cannot forget to update it. Everything else is the
 * effective configuration — the same resolved object the tools read — so the copied
 * block cannot disagree with the running plugin. `dsh` and `wsl` are the two facts
 * the browser half cannot reach on its own, and both degrade to `null` rather than
 * to a guess. `terminal` answers the one question the bridge raises in practice —
 * is a page polling right now — with counts only, never ids.
 *
 * No paths, host names or credentials: this route is served by the local web server
 * and a browser (or anything else on the machine) can fetch it.
 */
async function selfInfo(config, runner, terminalTransport) {
  const manifest = readManifest()
  const repository = typeof manifest?.repository?.url === 'string'
    ? manifest.repository.url.replace(/^git\+/, '')
    : null
  let terminal = null
  if (terminalTransport !== null && terminalTransport !== undefined) {
    const bridge = typeof terminalTransport.status === 'function' ? terminalTransport.status() : null
    // A lazy handle with no resolved generation yet (a host that offers neither a browser
    // terminal nor a PTY provider) reports no terminal at all, exactly like the old null did.
    const kind = typeof terminalTransport.kind === 'string' ? terminalTransport.kind : null
    if (kind !== null) {
      terminal = {
        // 'bridge' when a page is driving the sidebar terminal, 'pty' when only this plugin can.
        kind,
        bridgeCapable: terminalTransport.bridgeCapable === true,
        bridge: bridge !== null && typeof bridge === 'object'
          ? {
              client: bridge.client === true,
              attachments: typeof bridge.attachments === 'number' ? bridge.attachments : 0,
              pending: typeof bridge.pending === 'number' ? bridge.pending : 0,
            }
          : null,
      }
    }
  }
  return {
    name: manifest?.name ?? 'dsh-wsl-tool',
    version: manifest?.version ?? null,
    repository,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dsh: dshVersion(),
    wsl: await wslFacts(runner, config),
    terminal,
    config: {
      tools: { ...config.tools },
      backgroundJobs: config.backgroundJobs,
      translatePaths: config.translatePaths,
      startInSessionWorkspace: config.startInSessionWorkspace,
      dangerGuard: config.dangerGuard,
      allowRoot: config.allowRoot,
      distro: config.distro,
      commandTimeoutMs: config.commandTimeoutMs,
      maxOutputBytes: config.maxOutputBytes,
    },
  }
}

export function apply(ctx, settings = {}) {
  // Resolved once per mount. Behaviour reads this object at call time, so the
  // volatile-update hook below can change it in place without remounting.
  const config = resolveConfig(process.env, settings)
  const runner = createRunner(ctx, config)
  // One log for the whole run, one bucket per conversation: the terminal tool records into it
  // and the client's dock row reads it back over the route below. It is in-memory on purpose —
  // the terminals it describes disappear with this run too.
  const subtasks = createSubtaskLog()
  // ONE terminal transport for this mount: the tool drives it and the subtask route asks it
  // whether a recorded terminal is still alive. Whichever generation the host offers is picked
  // here — a `terminalController` with follow/write (browser terminals, the user can watch), the
  // browser bridge on 0.2.1 (`lib/term-bridge.js`: this plugin's own page holds the Remote
  // attachment, and the private PTY below is its fallback), or a PTY alone when no page is
  // available. It is a LAZY handle: the host may mount its web-app rows after this plugin's
  // apply (0.2.1-rc.3 does), and resolving once here would freeze the private-PTY fallback in
  // place for the whole run. `upgradeTerminalTransport` below re-resolves when the service is
  // really there.
  let terminalTransport = null
  try {
    terminalTransport = createLazyTerminalTransport({ ctx, config })
  } catch (error) {
    console.warn('dsh-wsl-tool: no usable terminal transport', error)
    terminalTransport = null
  }

  // ------------------------------------------------------------- tool switches
  //
  // Registering a tool is a live operation (`register` returns its own disposer),
  // so `tools.*` is not a restart-only setting: the volatile-update hook below
  // diffs the desired set against the mounted one. That matters because the panel
  // is where these are toggled — measured: a user flipped a tool switch 24 seconds
  // after starting the app and the tool was still missing, which reads as "the
  // switch did nothing".
  //
  // Every factory is built lazily inside its own `register`, so a tool that is
  // switched on later gets a fresh definition rather than a stale captured one.
  const toolFactories = {
    wsl: () => createWslTool({ ctx, config, runner }),
    path: () => createWslPathTool({ config, runner }),
    env: () => createWslEnvTool({ config, runner }),
    doctor: () => createWslDoctorTool({ config, runner }),
    // The installer is NOT registered by default: turning on its switch is the
    // user's decision to let this plugin add software to their distribution.
    bootstrap: () => createWslBootstrapTool({ config, runner }),
    // The file tools exist because the platform's own file tools cannot reach a
    // distribution: `\\wsl.localhost\...` is a 9p share, and a write over it
    // fails at the rename that makes the write atomic. These run the same
    // operations inside the distribution instead, through the runner that
    // already knows how to talk to `wsl.exe`.
    read: () => createWslReadTool({ config, runner }),
    write: () => createWslWriteTool({ config, runner }),
    edit: () => createWslEditTool({ config, runner }),
    // Searching is the one file operation whose answer depends on what the distribution has
    // installed: `rg` when present, GNU `grep -E` otherwise. Doing it here rather than through
    // `wsl` keeps the result grouped by file with line numbers, which a raw shell grep cannot
    // promise once a path contains a colon.
    grep: () => createWslGrepTool({ config, runner }),
    // The terminal tool has NO switch: driving a shell IS the thing it exists for, and on a build
    // where the sidebar cannot be joined it opens its own shell instead. It reads the transport
    // lazily, so a build with neither generation still mounts this plugin and reports that
    // clearly instead of failing to load.
    term: () => createWslTermTool({ ctx, config, subtasks, transport: terminalTransport }),
  }
  // Tools with no switch of their own are always mounted.
  const alwaysOn = new Set(['term'])
  /** name -> disposer for the tools currently mounted by this plugin. */
  const mountedTools = new Map()
  const syncTools = () => {
    for (const [name, factory] of Object.entries(toolFactories)) {
      const wanted = alwaysOn.has(name) || config.tools[name] === true
      const disposer = mountedTools.get(name)
      if (wanted && disposer === undefined) {
        try {
          mountedTools.set(name, ctx.tools.register(factory()))
        } catch (error) {
          // A tool whose factory throws must not take the other five down.
          console.error(`dsh-wsl-tool: registering the ${name} tool failed`, error)
        }
      } else if (!wanted && disposer !== undefined) {
        mountedTools.delete(name)
        try {
          disposer()
        } catch (error) {
          console.error(`dsh-wsl-tool: unregistering the ${name} tool failed`, error)
        }
      }
    }
  }
  syncTools()

  // The transport resolved above may be the private-PTY fallback only because the host had not
  // mounted its web-app rows (and `terminalController`) yet — 0.2.1-rc.3 mounts them after a
  // profile plugin's apply, which silently demoted every browser-terminal feature for the whole
  // run. Upgrade as soon as the service is really there, then re-register `wsl-term` so its
  // description stops claiming the sidebar terminal cannot be joined.
  let transportUpgraded = false
  const upgradeTerminalTransport = () => {
    if (transportUpgraded || terminalTransport === null || typeof terminalTransport.upgrade !== 'function') return
    // Already a bridge (an older ordering, or a host that had everything up): nothing to do.
    if (terminalTransport.bridgeCapable === true) {
      transportUpgraded = true
      return
    }
    if (terminalTransport.upgrade() !== true) return
    transportUpgraded = true
    const mounted = mountedTools.get('term')
    if (mounted !== undefined) {
      mountedTools.delete('term')
      try {
        mounted()
      } catch (error) {
        console.warn('dsh-wsl-tool: re-mounting the terminal tool after the transport upgrade failed', error)
      }
      syncTools()
    }
    console.info('dsh-wsl-tool: the browser terminal bridge became available; terminal transport upgraded')
  }
  try {
    if (typeof ctx?.inject === 'function') {
      // Both services, so the bridge's routes go up with a web server that can serve them.
      ctx.inject(['terminalController', 'webServer'], () => upgradeTerminalTransport())
    }
  } catch {
    // A host without inject keeps the transport it resolved; the timer below is the fallback.
  }
  const upgradeTimer = setTimeout(upgradeTerminalTransport, 2_500)
  if (typeof upgradeTimer.unref === 'function') upgradeTimer.unref()

  // ------------------------------------------------------------ WSL channel
  //
  // The `dsh` shim inside WSL talks to this small server, not to the plugin's web
  // routes: those bind 127.0.0.1, which under WSL2 NAT is the WSL side itself. The
  // channel therefore listens on the address WSL uses as its default gateway (the
  // Windows host) and authenticates every request with a per-mount token. It is
  // optional and defensive: a failure here must not take the tools down, and a host
  // without `wsl.exe` simply reports "channel unavailable" in the panel.
  const runWslHost = (argv, distro) => new Promise((resolve) => {
    const args = typeof distro === 'string' && distro !== '' ? ['-d', distro, ...argv] : argv
    execFile('wsl.exe', args, {
      timeout: 30000,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, WSL_UTF8: '1' },
    }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' && stderr !== '' ? stderr : (error?.message ?? ''),
      })
    })
  })
  let channel = null
  try {
    channel = createChannel({
      ctx,
      config,
      wsl: (argv) => runWslHost(argv, config.distro),
      // Lets a terminal prompt carry the screen of the terminal it was typed in (read-only).
      transport: terminalTransport,
    })
    // Lazy on purpose: a disabled channel must not bind a port or spawn wsl.exe. Turning
    // the switch on (or a mount that already has it on) starts it; the panel's install
    // action starts it too, because the shim needs the port and token it writes.
    channel.refresh().catch((error) => {
      console.warn('dsh-wsl-tool: the WSL channel server did not start', error)
    })
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => { channel.stop() }, 'dsh-wsl-tool: WSL channel server')
    }
  } catch (error) {
    console.warn('dsh-wsl-tool: the WSL channel is unavailable', error)
    channel = null
  }

  // The terminal context captured by the channel goes to the MODEL, not to the transcript:
  // `systemPrompt.context` contributes hidden runtime context to the next request (the same
  // mechanism working-directory and mnemon use), and it is a one-shot for the message it
  // belongs to. The one-shot is advanced here, at the end of an assembly — NOT taken here:
  // the agent loop assembles a step twice (`assemble()` and then `refreshContext()` right
  // before the request), so dropping the entry in this waterfall emptied the provider before
  // the request that needed it (live-verified 2026-10-25: the capture was fine, the request's
  // runtime context was empty). The first assembly marks it served; the next one drops it.
  // A host without `systemPrompt` keeps the old behaviour (nothing hidden, nothing shown).
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['systemPrompt'], (inner) => {
        try {
          const systemPrompt = typeof inner?.get === 'function' ? inner.get('systemPrompt') : inner?.systemPrompt
          if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.context !== 'function') return
          const baseOrder = typeof systemPrompt.getContextOrder === 'function'
            ? Number(systemPrompt.getContextOrder('HARNESS_SOURCE'))
            : Number.NaN
          systemPrompt.context({
            name: 'dsh-wsl:terminal-history',
            order: Number.isFinite(baseOrder) ? baseOrder + 25 : 225,
            // A context of the person's own terminal is data, not prompt text: no interpolation.
            interpolate: false,
            text: (context) => {
              if (channel === null) return ''
              const session = context?.agent?.session?.id ?? context?.agent?.id ?? ''
              return channel.terminalContextFor(String(session))
            },
          })
          ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
            const assembled = await next()
            try {
              const session = context?.agent?.session?.id ?? context?.agent?.id ?? ''
              channel?.rotateTerminalContext?.(String(session))
            } catch {
              // Bookkeeping; it must never fail a request.
            }
            return assembled
          })
        } catch (error) {
          console.warn('dsh-wsl-tool: could not register the terminal-history prompt context', error)
        }
      })
    }
  } catch {
    // An older host without `systemPrompt` simply gets no hidden terminal context.
  }

  // ---------------------------------------------------------------- self info
  //
  // The panel's 「复制插件信息」 needs facts this half already has and the browser
  // half cannot know: the package name and version (read from this plugin's own
  // manifest, so a release never has to edit a string) and the effective
  // configuration. It is published on a read-only route the browser can fetch,
  // namespaced so it cannot collide, and it deliberately carries no paths, host
  // names or credentials — only versions, platform and the switch states the panel
  // already shows.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (inner) => {
        const webServer = inner.webServer
        if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
        // Two routes, published together: the read-only self info, and the terminal
        // startup directory the panel reads and writes. Both are optional — an older
        // host without `webServer` simply gets no panel features that need one.
        const publish = (path, handler, label) => {
          const disposer = webServer.register({ kind: 'exact', path, handler })
          if (typeof inner.effect === 'function') inner.effect(() => disposer, label)
        }
        publish(INFO_ROUTE, async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          let body
          try {
            // The WSL probes cost a few WSL round trips; they run concurrently and
            // every one of them may fail without failing the request.
            body = JSON.stringify(await selfInfo(config, runner, terminalTransport))
          } catch (error) {
            console.warn('dsh-wsl-tool: reading self info failed', error)
            body = JSON.stringify({ name: 'dsh-wsl-tool', version: null, dsh: null, wsl: null })
          }
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            // A copied block must describe this moment, not a cached one.
            'cache-control': 'no-store',
          })
          response.end(body)
        }, 'dsh-wsl-tool: self-info route')
        publish(TERMINAL_ROUTE, (request, response) => serveTerminalCwd(ctx, request, response),
          'dsh-wsl-tool: terminal-cwd route')
        // The client's dock row above the composer reads this: which terminal subtasks this
        // conversation has, running first, with each one's result, commands and shell decision.
        // Every conversation is returned and the client filters by its own session id, because
        // this route has no session of its own. A `?session=` names the dock's own conversation
        // so the terminals the USER opened can be listed as records beside the subtasks (owner
        // request), labelled as user-created and ended only once the terminal is gone.
        // The dock names its own conversation with `?session=`: that request assembles THAT
        // conversation only, asks the terminal transport for its inventory at most ONCE, and
        // answers user-terminal records plus the conversation's subtasks. Without the parameter
        // every conversation the log has seen is returned with its owned-shell liveness only —
        // the browser reads one key, so paying a page round trip per historical session (the
        // client polls every 2 s) buys nothing. A failure answers a structured 500: a hung
        // response would leave the dock's poll loop waiting forever, because its fetch has no
        // timeout of its own.
        publish(SUBTASK_ROUTE, async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          // The transport is what keeps the row honest: an entry whose terminal no longer
          // exists reads as closed, whatever the log last heard. Its absence is not an error —
          // the projection falls back to what the log recorded.
          const controller = terminalTransport
          /** The shells THIS plugin opened for one conversation (sync; no page needed). */
          const ownedOf = (sessionId) => {
            const found = []
            const seen = new Set()
            const add = (info) => {
              const id = String(info?.id ?? '')
              if (id === '' || seen.has(id)) return
              seen.add(id)
              found.push(info)
            }
            if (controller !== null && typeof controller.list === 'function') {
              try {
                const listed = controller.list(sessionId)
                if (Array.isArray(listed)) for (const info of listed) add(info)
              } catch {
                // The projection falls back to the last snapshot; nothing else to do here.
              }
            }
            return found
          }
          /** The terminals the USER opened; only a live page can answer (one round trip). */
          const inventoryOf = async (sessionId) => {
            if (controller === null || typeof controller.userTerminals !== 'function') return []
            try {
              const listed = await controller.userTerminals(sessionId)
              return Array.isArray(listed) ? listed : []
            } catch {
              return []
            }
          }
          const sessions = {}
          /**
           * Project one conversation's log against the shell descriptions that are live now.
           * @param {string} sessionId - conversation to project.
           * @param {Array<object>} live - terminal descriptions that still exist.
           * @param {{ reconcile?: boolean }} [options] - `reconcile` retires user-terminal records
           *   whose shell is gone. It is only allowed when `live` really is the full inventory (the
           *   `?session=` path); the no-parameter path only knows owned shells, so a user terminal
           *   would look closed there.
           */
          const project = (sessionId, live, options = {}) => {
            const log = subtasks.list(sessionId)
            const byId = new Map((Array.isArray(live) ? live : []).map((info) => [String(info?.id), info]))
            const entries = log.entries.map((entry) => {
              const projected = entry.terminalId === null
                ? projectSubtask(entry)
                : projectSubtask(entry, byId.get(String(entry.terminalId)) ?? null)
              if (options.reconcile === true && entry.userTerminal === true
                && entry.status !== 'done' && projected.status === 'done') {
                // The shell is gone (the user closed the tab) but the record still says running.
                // Closing it here is what lets the log's own trim() reclaim the entry instead of
                // holding it for the whole run as an eternally-open row.
                subtasks.finish(sessionId, entry.title, {
                  result: projected.result ?? '终端已关闭',
                  terminalKept: false,
                })
              }
              return projected
            })
            sessions[sessionId] = {
              total: log.total,
              // A terminal the user keeps open is not "a subtask running": count real work only.
              running: entries.filter((entry) => entry.status !== 'done' && entry.userTerminal !== true).length,
              entries,
            }
          }
          /** Whether a stored terminal description differs enough to be worth rewriting. */
          const descriptionChanged = (stored, info) => stored === null || stored === undefined
            || String(stored.title ?? '') !== String(info?.title ?? '')
            || String(stored.state ?? '') !== String(info?.state ?? '')
            || String(stored.cwd ?? '') !== String(info?.cwd ?? '')
          try {
            let wanted = ''
            try {
              wanted = new URL(String(request.url ?? '/'), 'http://localhost').searchParams.get('session') ?? ''
            } catch {
              wanted = ''
            }
            if (wanted !== '') {
              // ONE inventory read for the whole request: it is what lists the user's own
              // terminals as records and what keeps their rows from reading as closed.
              const shared = await inventoryOf(wanted)
              for (const info of shared) {
                const id = String(info?.id ?? '')
                if (id === '') continue
                const log = subtasks.list(wanted)
                const mine = log.entries
                  .filter((entry) => entry.terminalCreated !== true && String(entry.terminalId) === id)
                const record = mine.find((entry) => entry.userTerminal === true)
                if (record !== undefined) {
                  // The title and the flag stay as they are, and so does `updatedAt` unless the
                  // shell really changed: rewriting it on every 2 s poll would keep these records
                  // pinned above the conversation's real subtasks in the dock's order.
                  if (descriptionChanged(record.terminalSnapshot ?? null, info)) {
                    subtasks.start(wanted, record.title, { terminalId: id, terminalCreated: false, terminalSnapshot: info })
                  }
                  continue
                }
                // A normal subtask that an explicit call recorded on this terminal stays as it
                // is; the terminal gets its own record beside it. Titles are unique across the
                // USER-TERMINAL records, not just this id's: a closed terminal's record keeps its
                // title (and must read as ended), and a re-created tab with the same shell name
                // gets a "#2" of its own instead of rewriting the old record in place.
                const base = `用户建立的终端「${info?.title ?? 'WSL'}」`
                const taken = new Set(log.entries
                  .filter((entry) => entry.userTerminal === true)
                  .map((entry) => entry.title))
                let title = base
                for (let index = 2; taken.has(title); index += 1) title = `${base} #${index}`
                const created = subtasks.start(wanted, title, {
                  terminalId: id,
                  terminalCreated: false,
                  terminalSnapshot: info,
                })
                created.userTerminal = true
              }
              // `reconcile`: this list is the full inventory, so a user-terminal record whose
              // shell is absent really has ended.
              project(wanted, [...ownedOf(wanted), ...shared], { reconcile: true })
            } else {
              for (const sessionId of Object.keys(subtasks.snapshot())) {
                project(sessionId, ownedOf(sessionId))
              }
            }
            answerJson(response, 200, { sessions })
          } catch (error) {
            console.warn('dsh-wsl-tool: assembling the subtask log failed', error)
            answerJson(response, 500, { sessions: {}, error: String(error?.message ?? error) })
          }
        }, 'dsh-wsl-tool: subtask route')
        // The two path settings are chosen, not typed: list directories that actually
        // exist in the distro (home, its children, /mnt/c, /mnt/d and D: top-level dirs).
        // Read-only; a stopped WSL answers an empty list and the panel keeps working.
        publish(PATHS_ROUTE, async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          const options = []
          try {
            const script = [
              'printf "%s\\n" "$HOME"',
              'for d in "$HOME"/*/; do [ -d "$d" ] && printf "%s\\n" "${d%/}"; done',
              'printf "%s\\n" /mnt/c /mnt/d',
              'for d in /mnt/d/*/; do [ -d "$d" ] && printf "%s\\n" "${d%/}"; done',
            ].join('; ')
            const result = await runWslHost(['-e', 'bash', '-lc', script], config.distro)
            const seen = new Set()
            for (const line of String(result?.stdout ?? '').split(/\r?\n/)) {
              const candidate = line.trim()
              if (candidate === '' || !candidate.startsWith('/') || seen.has(candidate)) continue
              seen.add(candidate)
              options.push(candidate)
              if (options.length >= 40) break
            }
          } catch {
            /* empty list: the panel shows its built-in fallbacks */
          }
          answerJson(response, 200, { options })
        }, 'dsh-wsl-tool: path candidates route')
        // Directory browser for the two path settings: parent + immediate subdirectories,
        // normalized in the distro. Read-only; a missing directory answers with an error
        // the panel can show instead of an exception.
        publish(DIRS_ROUTE, async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          let requested = ''
          try {
            requested = new URL(String(request.url ?? '/'), 'http://localhost').searchParams.get('path') ?? ''
          } catch {
            requested = ''
          }
          // A Windows path (the sidebar terminal accepts one) is translated to its /mnt/<drive>
          // form so the browser can still walk it.
          const windowsPath = /^([A-Za-z]):[\\/](.*)$/.exec(requested.trim())
          if (windowsPath !== null) {
            requested = `/mnt/${windowsPath[1].toLowerCase()}/${windowsPath[2].replace(/\\/g, '/')}`
          }
          let payload
          try {
            const script = [
              'P="$1"',
              // `${P#~/}` would not strip here: the pattern's `~/` is tilde-expanded first.
              'case "$P" in "~") P="$HOME" ;; "~/"*) P="$HOME/${P:2}" ;; esac',
              'if [ -z "$P" ]; then P="$HOME"; fi',
              'if [ ! -d "$P" ]; then printf "NODIR\\n"; exit 3; fi',
              'cd "$P" || exit 4',
              'pwd -P',
              'find . -mindepth 1 -maxdepth 1 -type d -printf "%f\\n" 2>/dev/null | LC_ALL=C sort | head -n 300',
            ].join('\n')
            const result = await runWslHost(['-e', 'bash', '-c', script, 'dsh-dirs', requested], config.distro)
            const lines = String(result?.stdout ?? '').split(/\r?\n/)
            if (result?.code !== 0 || lines[0] === 'NODIR') {
              payload = {
                path: requested,
                parent: null,
                entries: [],
                error: lines[0] === 'NODIR' ? '这个目录不存在' : String(result?.stderr ?? '读取目录失败').trim(),
              }
            } else {
              const resolved = lines.shift()
              const names = lines.filter((name) => name !== '' && name !== '.' && name !== '..')
              const parent = resolved === '/' ? null : (resolved.slice(0, resolved.lastIndexOf('/')) || '/')
              payload = {
                path: resolved,
                parent,
                entries: names.slice(0, 300).map((name) => ({
                  name,
                  path: resolved === '/' ? `/${name}` : `${resolved}/${name}`,
                })),
              }
            }
          } catch (error) {
            payload = { path: requested, parent: null, entries: [], error: String(error?.message ?? error) }
          }
          answerJson(response, 200, payload)
        }, 'dsh-wsl-tool: directory browser route')
        // The panel's WSL-channel block. State is read by the browser (same origin); the
        // install action writes the shim into the distro and is the only write here, so it
        // demands a JSON content type — a cross-site form cannot send that without a
        // preflight this server never approves.
        publish(CHANNEL_STATE_ROUTE, async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          let payload
          try {
            payload = channel === null
              ? { available: false, enabled: false, shim: { installed: false } }
              : { available: true, ...(await channel.panelState()) }
          } catch (error) {
            payload = { available: false, enabled: false, error: String(error?.message ?? error) }
          }
          answerJson(response, 200, payload)
        }, 'dsh-wsl-tool: channel state route')
        publish(CHANNEL_INSTALL_ROUTE, async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!isJsonRequest(request)) {
            answerJson(response, 415, { ok: false, detail: 'content-type must be application/json' })
            return
          }
          // `readJsonBody` RESOLVES with `{ value }` or `{ error }`; it does not throw.
          const installBody = await readJsonBody(request)
          if (installBody.error !== undefined) {
            answerJson(response, 400, { ok: false, detail: installBody.error })
            return
          }
          if (channel === null) {
            answerJson(response, 503, { ok: false, detail: 'the WSL channel is unavailable in this host' })
            return
          }
          try {
            answerJson(response, 200, await channel.install())
          } catch (error) {
            answerJson(response, 500, { ok: false, detail: String(error?.message ?? error) })
          }
        }, 'dsh-wsl-tool: channel install route')
        // Create a session from the panel's picker, so a fresh profile can adopt the
        // feature without guessing an id. Same JSON-only rule as the install route.
        publish(CHANNEL_NEW_ROUTE, async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!isJsonRequest(request)) {
            answerJson(response, 415, { ok: false, detail: 'content-type must be application/json' })
            return
          }
          const body = await readJsonBody(request)
          if (body.error !== undefined) {
            answerJson(response, 400, { ok: false, detail: body.error })
            return
          }
          if (channel === null) {
            answerJson(response, 503, { ok: false, detail: 'the WSL channel is unavailable in this host' })
            return
          }
          try {
            const result = await channel.createSession(
              typeof body.value?.sessionId === 'string' ? body.value.sessionId.trim() : '',
            )
            answerJson(response, 200, result)
          } catch (error) {
            answerJson(response, 500, { ok: false, detail: String(error?.message ?? error) })
          }
        }, 'dsh-wsl-tool: channel new-session route')
      })
    }
  } catch (error) {
    console.warn('dsh-wsl-tool: could not publish the plugin routes', error)
  }

  // A volatile edit is written into the same object the loader handed us and then
  // announced, so re-resolving in place is what makes every switch take effect
  // without a restart: the behaviour values are read at call time, and the tool
  // switches are diffed into the registry by `syncTools` above. The panel says a
  // change applies immediately, because it does.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      try {
        Object.assign(config, resolveConfig(process.env, settings))
        syncTools()
        // The channel advertises `enabled` and the default session in its state file, so a
        // switch flip has to rewrite it; a channel whose first bind failed gets one more try.
        channel?.refresh().catch((error) => {
          console.warn('dsh-wsl-tool: refreshing the WSL channel failed', error)
        })
      } catch (error) {
        console.error('dsh-wsl-tool: applying a live settings change failed', error)
      }
    })
  }
}
