// dsh-wsl-tool, browser half.
//
// This file is a PLAIN hand-written bundle, exactly like the ones DSH ships: no
// build step, no `import`/`export` keywords, no JSX, no TypeScript. The page
// loads it as a script, the module loader below hands it a `require`, and the
// only two modules it may ask for are React and the client UI primitives.
//
// What it contributes:
//   - one rail entry in the left sidebar (`sidebar.panellist`, a list seat), and
//   - the panel behind that entry (`main`, a keyed seat under the same id),
//     whose switches edit this plugin's own Host configuration row.
//
// The Host half reads its settings ONCE per mount (see `lib/config.js`), so a
// switch here changes the documented file/profile configuration; it does not
// reconfigure a running session. The panel says so in one line instead of
// pretending otherwise.
//
// Layout facts this file depends on (all verified against the shipped client):
//   - `sidebar.panellist` entries carry `id`, `order` and `label`, and render
//     their own icon (there is no icon field).
//   - `main` is keyed by that same id, and its `inject` callback supplies extra
//     props to the panel component.
//   - `ctx.configForms.get(rowId)` returns a scope with
//     `getSnapshot()` / `subscribe(listener)` / `mutate(ops, revision)`, where a
//     snapshot is `{ status, value, base, user, writable, revision }` and one op
//     is `{ op: 'set', path, value }` or `{ op: 'unset', path }`.

window.__ModuleLoader__.load({
  id: 'dsh-wsl-tool',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /**
     * Panel identity. The layout pairs one `sidebar.panellist` entry with the
     * `main` entry registered under the same key, so these two must agree; the
     * rail entry's `label` is the visible text, the accessible name and the
     * collapsed tooltip.
     */
    const PANEL_ID = 'dsh-wsl'

    /**
     * Loader row id of this bundle's Host half, read from our own
     * `cordis.patch.yml`. `configForms.get` addresses a Host configuration entry
     * by that row id — not by the package name, because one package may be
     * composed as several rows under different ids.
     */
    const CONFIG_ROW_ID = 'tool-wsl'

    /**
     * What to say when the Host never lists this plugin's configuration entry.
     *
     * That entry exists in the settings service only when the plugin exports a schema, and
     * the schema import is a soft one: on a Host without `@deepseek-ai/schemastery` — which
     * this plugin declares as an optional peer, so a bare install may not carry it — there
     * is no form at all and the namespace never arrives. Waiting forever tells the reader
     * nothing; naming the cause and what still works does.
     */
    const SCOPE_MISSING_NOTE = '宿主未提供该插件的配置作用域：设置表单需要 `@deepseek-ai/schemastery`（DSH 通常自带）。'
      + '工具与「WSL 终端启动路径」不受影响。'

    /** How long "waiting for the scope" stays plausible before the note above replaces it. */
    const SCOPE_WAIT_MS = 8000

    /**
     * The Host routes this panel talks to, kept in step with `index.js`:
     *   - `info`: the plugin's own facts, for 「复制插件信息」 (read-only).
     *   - `terminal-cwd`: the sidebar terminal's startup directory, which lives in the
     *     profile's patch layer rather than in this plugin's configuration, so it is
     *     read and written here instead of through the settings scope.
     */
    /**
 * A terminal-subtask dock row, above the composer and beside the app's own dock entries.
 *
 * The row stays compact on purpose: how many subtasks this conversation has run, how many are
 * running, then one line per subtask — status, what the work was, what happened to its shell.
 * Clicking a line opens its detail: the terminal's full description, the result, and the
 * commands with their exit codes. Commands are what makes a row long, so they appear only when
 * asked for.
 *
 * Every failure is silent by design (no route, no session id, a rejected request): a dock row
 * that cannot read the log must not take the composer with it. A log that IS readable and
 * simply has nothing in it is a different state, and it says so in one faint line — a display
 * that only ever appears after the first subtask reads as missing.
 */
/** The page's `document`, resolved at call time: a test host (or a bare runner) may have none. */
function pageDocument() {
  return typeof document === 'object' && document !== null ? document : undefined
}

/**
 * A click action that also answers Enter and Space. The dock's rows are `div`s on purpose —
 * a real `<button>` would need the whole visual style reset — so the keyboard semantics are
 * supplied here instead of by the element.
 */
function activateOnClick(action) {
  return (event) => {
    if (event !== null && event !== undefined && event.type === 'keydown') {
      const key = event.key
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
      if (typeof event.preventDefault === 'function') event.preventDefault()
    }
    action()
  }
}

/** How long the dock waits between reads while the page is hidden (timers throttle anyway). */
const DOCK_HIDDEN_DELAY_MS = 30_000
/** A slow poll while there is nothing in flight, so a finished log is not re-read every 2 s. */
const DOCK_IDLE_DELAY_MS = 10_000

/**
 * A cheap signature of one subtask list. Poll answers replace the entries array wholesale, so
 * comparing object identity would always differ; comparing this value is what stops an
 * unchanged log from re-rendering every row (and every inline style) on every poll.
 */
function subtaskSignature(total, running, entries) {
  const parts = entries.map((entry) => {
    const commands = Array.isArray(entry?.commands) ? entry.commands.length : 0
    return [
      entry?.id,
      entry?.status,
      entry?.terminal,
      entry?.result ?? '',
      commands,
      entry?.userTerminal === true ? 1 : 0,
    ].join(':')
  })
  return `${total ?? ''}|${running ?? ''}|${parts.join(',')}`
}

function WslSubtaskDock(props) {
  const [state, setState] = React.useState({ status: 'loading' })
  const [open, setOpen] = React.useState(null)
  // Collapsed by default (owner request 2026-10-23): the row above the composer shows how many
  // subtasks this conversation ran, and one click expands the list. A subtitle per row is not
  // worth the vertical space in the composer area.
  const [expanded, setExpanded] = React.useState(false)
  const sessionId = props?.sessionId ?? props?.session?.id
  React.useEffect(() => {
    if (sessionId === undefined || sessionId === null) return undefined
    const fetcher = typeof fetch === 'function' ? fetch : undefined
    if (fetcher === undefined) return undefined
    const doc = pageDocument()
    let stopped = false
    let timer
    let lastSignature = ''
    const hiddenNow = () => doc !== undefined && doc.hidden === true
    const clearPending = () => {
      if (timer !== undefined && typeof clearTimeout === 'function') clearTimeout(timer)
      timer = undefined
    }
    const schedule = (base) => {
      clearPending()
      if (typeof setTimeout !== 'function') return
      timer = setTimeout(read, hiddenNow() ? Math.max(base, DOCK_HIDDEN_DELAY_MS) : base)
    }
    const read = () => {
      // The session is named so the Host can also list the terminals THIS user opened as
      // records beside the subtasks (they are not subtasks, but they belong in the same row).
      const route = `${SUBTASK_ROUTE}?session=${encodeURIComponent(String(sessionId))}`
      Promise.resolve(fetcher(route, { headers: { accept: 'application/json' } }))
        .then((response) => (response !== undefined && response !== null && response.ok === true
          ? response.json()
          : undefined))
        .then((payload) => {
          if (stopped) return
          const mine = payload?.sessions?.[sessionId]
          const entries = Array.isArray(mine?.entries) ? mine.entries : []
          if (mine === undefined || mine === null || entries.length === 0) {
            // Nothing to show: keep looking, but slowly. A row that only appeared after a
            // reload would be useless, and a fast poll with nothing to show is just noise.
            if (lastSignature !== 'empty') {
              lastSignature = 'empty'
              setState({ status: 'empty' })
            }
            schedule(DOCK_IDLE_DELAY_MS)
            return
          }
          // 2 s only while work is running; a finished log barely moves, so it is read slowly.
          schedule(mine.running > 0 ? 2_000 : DOCK_IDLE_DELAY_MS)
          const signature = subtaskSignature(mine.total, mine.running, entries)
          if (signature === lastSignature) return
          lastSignature = signature
          setState({ status: 'ready', total: mine.total, running: mine.running, entries })
        })
        .catch(() => {
          if (stopped) return
          // Not the same state as an empty log: nothing was read, so nothing can be said about
          // how many subtasks ran. Stay silent rather than claim there are none.
          if (lastSignature !== 'unavailable') {
            lastSignature = 'unavailable'
            setState({ status: 'unavailable' })
          }
          schedule(DOCK_IDLE_DELAY_MS)
        })
    }
    // Coming back to a visible page must not wait out the long hidden interval.
    const onVisibilityChange = () => {
      if (stopped || hiddenNow()) return
      clearPending()
      read()
    }
    if (doc !== undefined && typeof doc.addEventListener === 'function') {
      try {
        doc.addEventListener('visibilitychange', onVisibilityChange)
      } catch (error) {
        console.error('dsh-wsl-tool: watching page visibility failed', error)
      }
    }
    read()
    return () => {
      stopped = true
      clearPending()
      if (doc !== undefined && typeof doc.removeEventListener === 'function') {
        try {
          doc.removeEventListener('visibilitychange', onVisibilityChange)
        } catch (error) {
          console.error('dsh-wsl-tool: releasing the page visibility hook failed', error)
        }
      }
    }
  }, [sessionId])

  if (sessionId === undefined || sessionId === null) return null
  // One faint line, no container: an empty record is not a row, but the reader has to know the
  // display exists before the first subtask lands.
  if (state.status === 'empty') {
    return React.createElement(
      'div',
      {
        style: {
          margin: '0 auto 4px',
          color: LABEL_TERTIARY,
          opacity: 0.55,
          fontSize: '11px',
          lineHeight: 1.25,
          textAlign: 'center',
          alignSelf: 'center',
          width: 'fit-content',
          maxWidth: '100%',
        },
      },
      '暂无子任务',
    )
  }
  if (state.status !== 'ready' || state.entries.length === 0) return null

  /** The terminal as it really is, on one line: what it is, where it is, how big it is. */
  const terminalLine = (entry) => {
    const info = entry.terminalInfo
    if (info === null || info === undefined) {
      return entry.terminal === 'closed' ? '终端已关闭（信息随之消失）' : '终端信息不可用'
    }
    const shell = info.shell === null
      ? null
      : (info.args.length > 0 ? `${info.shell} ${info.args.join(' ')}` : info.shell)
    const size = info.cols === null || info.rows === null ? null : `${info.cols}x${info.rows}`
    const name = info.title === null || info.title === '' ? '' : `「${info.title}」`
    return [
      `终端 ${info.id}${name}`,
      shell,
      info.cwd,
      size,
      info.state,
      entry.terminalCreated ? '工具创建' : '用户打开',
      info.stale === true ? '（已关闭，这是最后一次看到的状态）' : null,
    ].filter((part) => part !== null && part !== undefined).join(' · ')
  }

  const monoStyle = {
    marginTop: '3px',
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: '11.5px',
    color: LABEL_SECONDARY,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  }

  const detail = (entry) => {
    const lines = entry.commands.map((command) => `$ ${command.command}`
      + (command.exitCode === null || command.exitCode === undefined ? '' : `   → ${command.exitCode}`))
    return React.createElement(
      'div',
      { style: { marginTop: '2px', paddingLeft: '10px' } },
      React.createElement('div', { style: { color: LABEL_TERTIARY, fontSize: '12px' } }, terminalLine(entry)),
      entry.result === null || entry.result === undefined
        ? null
        : React.createElement('div', { style: { color: LABEL_SECONDARY, fontSize: '12px', marginTop: '3px' } },
          `结果：${entry.result}`),
      lines.length === 0
        ? React.createElement('div', { style: { color: LABEL_TERTIARY, fontSize: '12px', marginTop: '3px' } },
          '（还没跑过命令）')
        : React.createElement('div', { style: monoStyle }, lines.join('\n')),
    )
  }

  const row = (entry) => {
    const running = entry.status !== 'done'
    // A record that stands for a terminal the user opened is not "running" work: it says the
    // terminal is in use, and only reads as ended once the terminal is gone (the tool never
    // closes it, so that is the user closing it). A real subtask keeps the old wording.
    const status = entry.userTerminal === true
      ? (running ? '使用中' : '已结束')
      : (running ? '运行中' : entry.terminal === 'closed' ? '已结束·关闭' : '已结束·保留')
    const expandedRow = open === entry.id
    const toggle = activateOnClick(() => setOpen(expandedRow ? null : entry.id))
    return React.createElement(
      'div',
      { key: entry.id, style: { marginTop: '2px' } },
      React.createElement(
        'div',
        {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': expandedRow ? 'true' : 'false',
          onClick: toggle,
          onKeyDown: toggle,
          style: { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '11px', cursor: 'pointer' },
        },
        React.createElement('span', {
          style: {
            color: LABEL_PRIMARY,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '46%',
          },
        }, `${running ? '●' : '✓'} ${entry.title}`),
        React.createElement('span', { style: { color: LABEL_TERTIARY, whiteSpace: 'nowrap' } }, status),
        // The count lives on the summary line only; repeating it here read as "运行 2 · 详情".
        React.createElement('span', { style: { color: LABEL_TERTIARY, marginLeft: 'auto', whiteSpace: 'nowrap' } },
          expandedRow ? '收起' : '详情'),
      ),
      expandedRow ? detail(entry) : null,
    )
  }

  // The one line the dock shows while collapsed: how many subtasks, how many still running,
  // and the control that opens the list.
  const summaryToggle = activateOnClick(() => setExpanded((value) => !value))
  const summaryLine = React.createElement(
    'div',
    {
      role: 'button',
      tabIndex: 0,
      'aria-expanded': expanded ? 'true' : 'false',
      onClick: summaryToggle,
      onKeyDown: summaryToggle,
      style: { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '11px', cursor: 'pointer' },
    },
    React.createElement('span', { style: { color: LABEL_PRIMARY, whiteSpace: 'nowrap' } },
      `${state.running > 0 ? '● ' : ''}共 ${state.total} 个子任务${state.running > 0 ? ` · 运行 ${state.running}` : ''}`),
    React.createElement('span', { style: { color: LABEL_TERTIARY, marginLeft: 'auto', whiteSpace: 'nowrap' } },
      expanded ? '收起' : '展开'),
  )

  return React.createElement(
    'div',
    {
      style: {
        margin: '0 auto 5px',
        padding: '3px 8px 4px',
        // Translucent so it reads as an overlay on the conversation, not as another card: the
        // composer below it is the only solid thing in this area.
        border: '1px solid rgba(128,128,140,.18)',
        borderRadius: '6px',
        background: 'rgba(128,128,140,.10)',
        color: LABEL_PRIMARY,
        fontSize: '11px',
        lineHeight: 1.25,
        // A pill that hugs its own text, centered like the composer card above which it sits.
        alignSelf: 'center',
        width: 'fit-content',
        maxWidth: '100%',
      },
    },
    summaryLine,
    expanded ? state.entries.map(row) : null,
  )
}

const INFO_ROUTE = '/dsh-wsl-tool/info'
/** The terminal subtasks this conversation has run, for the dock row above the composer. */
const SUBTASK_ROUTE = '/dsh-wsl-tool/subtasks'
    const TERMINAL_ROUTE = '/dsh-wsl-tool/terminal-cwd'
    /** WSL channel facts (port, host, shim presence) and its one install action. */
    const CHANNEL_STATE_ROUTE = '/dsh-wsl-tool/channel'
    const CHANNEL_INSTALL_ROUTE = '/dsh-wsl-tool/channel-install'
    /** The panel's create-a-session action for the channel picker. */
    const CHANNEL_NEW_ROUTE = '/dsh-wsl-tool/channel-new'
    /** Candidate directories for the two path settings, listed from the distro. */
    const DIRS_ROUTE = '/dsh-wsl-tool/dirs'

    /**
     * "3 小时前" for the picker's meta column. Returns '' for a missing timestamp, so a
     * row without one simply shows no time instead of "NaN 分钟前".
     */
    function relativeTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
      const delta = Date.now() - value
      if (delta < 60 * 1000) return '刚刚'
      const minutes = Math.round(delta / (60 * 1000))
      if (minutes < 60) return `${String(minutes)} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${String(hours)} 小时前`
      const days = Math.round(hours / 24)
      if (days < 30) return `${String(days)} 天前`
      return new Date(value).toLocaleDateString('zh-CN')
    }

    // Theme tokens, read as CSS custom properties so the panel follows the
    // active light/dark theme without importing any stylesheet. Each carries a
    // neutral fallback: an unknown token must not make text invisible.
    const LABEL_PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
    const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
    const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, inherit)'
    const BORDER_SOFT = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25))'
    const BORDER_BADGE = 'var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35))'
    const WARN_LABEL = 'var(--dsw-alias-state-warn-label, #b45309)'
    const LINK_LABEL = 'var(--dsw-alias-link, inherit)'
    const CODE_FILL = 'var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, 0.12))'
    const RADIUS = 'var(--dsw-radius-xs, 4px)'

    /**
     * The switches, grouped into the two sections the panel renders.
     *
     * `path`   - path inside this plugin's configuration object (settings ops are
     *            path-addressed, so a nested section is one array, not a string).
     * `label`  - visible row text; also the switch's accessible name.
     * `hint`   - the one-line explanation under the label.
     * `when`   - the composed default for the row, used ONLY when the resolved
     *            value does not carry the field at all (an older Host half, or a
     *            field the Host schema does not declare). Reading a missing field
     *            as `false` would silently mislabel a default-on feature.
     * `danger` - marks a switch whose OFF state widens what the model may run.
     * `caution` - marks a switch whose ON state does: it authorises this plugin
     *            to do something the user should decide on purpose (install into
     *            the distribution, run a call as root).
     */
    const SECTIONS = [
      {
        id: 'tools',
        title: '工具',
        rows: [
          {
            path: ['tools', 'wsl'],
            label: 'wsl 命令执行',
            hint: '在 WSL 中执行 Linux 命令，返回输出与退出码。每次调用使用全新的 shell，工作目录与环境变量不会保留。',
            when: true,
          },
          {
            path: ['tools', 'path'],
            label: 'wsl-path 路径转换',
            hint: '在 Windows 路径与 WSL 路径之间互转。',
            when: true,
          },
          {
            path: ['tools', 'env'],
            label: 'wsl-env 能力体检',
            hint: '查看发行版、内核、systemd、显卡、内存、磁盘与挂载盘等环境信息。',
            when: true,
          },
          {
            path: ['tools', 'doctor'],
            label: 'wsl-doctor 项目体检',
            hint: '检查项目所需工具在发行版中是否可用，并指出哪些命令实际来自 Windows。只读检查，不修改环境。',
            when: true,
          },
          {
            path: ['tools', 'bootstrap'],
            label: 'wsl-bootstrap 安装工具链',
            hint: '在发行版中补装缺失的工具链（Node、pnpm、Python、编译工具等）。默认只输出安装计划，模型再次确认后才执行；安装以 root 运行。',
            when: false,
            caution: true,
            cautionTitle: '打开需谨慎：允许模型在 WSL 中安装软件（以 root 运行，会改动发行版环境）。默认只输出安装计划，模型再次请求后才会真正安装。',
          },
        ],
      },
      {
        id: 'behavior',
        title: '行为',
        rows: [
          {
            path: ['backgroundJobs'],
            label: '后台任务',
            hint: '长任务可转入后台执行，模型稍后读取结果，无需持续等待。',
            when: true,
          },
          {
            path: ['translatePaths'],
            label: '自动转换路径',
            hint: '命令中的 Windows 路径自动转换为 WSL 可用的路径。',
            when: true,
          },
          {
            path: ['startInSessionWorkspace'],
            label: '默认跟随会话工作区',
            hint: '模型未指定目录时，从当前会话的工作区开始执行（默认开启）。关闭后使用「默认工作目录」；该目录留空时使用 Linux 家目录。',
            when: true,
          },
          {
            path: ['dangerGuard'],
            label: '危险命令守卫',
            hint: '删除、分区、关机等危险命令需由模型显式声明后才能执行；关闭后模型可直接执行此类命令。',
            when: true,
            danger: true,
          },
          {
            path: ['allowRoot'],
            label: '管理员模式（root）',
            hint: '允许模型以 root 身份执行命令（`wsl -u root`）。WSL 的 root 无需密码，因此这项开关就是授权本身；每次 root 执行都会在结果中标注。',
            when: false,
            caution: true,
            cautionTitle: '打开需谨慎：模型可以以 root 身份在 WSL 中执行命令，能够改动发行版内的任何内容。',
          },
        ],
      },
      {
        id: 'channel',
        title: 'WSL 终端中的 DSH 命令',
        rows: [
          {
            path: ['channelEnabled'],
            label: '启用 dsh 命令',
            hint: '在 WSL 终端中用 `dsh` 向 DSH 发送消息：内容进入上方选中的会话，回复以流式返回终端；对话仍显示在客户端中。',
            when: false,
            caution: true,
            cautionTitle: '开启后，本机的 WSL 终端可向所选会话发送消息。通道仅监听 WSL 可达的地址，每个请求需携带本次启动生成的令牌。',
          },
        ],
      },
    ]

    /** The submission guide shown beside the copy button.
     *
     * It lives in the panel because "where does this go" is the question a copied
     * block raises at exactly that moment; SUPPORT.md is the long form of the same
     * list, with the repository for each kind of problem.
     */
    const GUIDE = [
      '标题写明现象，例如「[Bug] 后台任务在带 systemd 的发行版中报无属主」；模板会自动加 `[Bug]` 前缀。',
      '正文包含三段：现象（附原文）、预期结果、复现步骤。',
      '「补充」栏粘贴上面复制的内容：版本号、发行版与开关状态均在其中。',
      '提问与想法请走 Discussions；DSH 本体、市场界面与收录目录的问题各有对应仓库（见 `SUPPORT.md`）。',
      '提交前删除不宜公开的路径、主机名与密钥：Issue 是公开的。',
    ]

    /** A setting nobody can read yet; shaped like a scope snapshot so the panel
     *  can treat it uniformly. `status: 'unavailable'` is the platform's own word
     *  for "this Host does not serve that configuration entry". */
    const UNAVAILABLE_SNAPSHOT = {
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      writable: false,
      revision: undefined,
    }

    /**
     * No scope yet — the Host has not listed this namespace, or its `describe()`
     * round trip is still in flight.
     *
     * This is deliberately NOT the unavailable snapshot: a panel that reads "this
     * DSH does not provide the plugin's settings scope" while it is merely still
     * waiting sends whoever is debugging it after the wrong thing (measured: it
     * said exactly that for a namespace the Host was already serving, because the
     * form had been taken before the round trip settled).
     */
    const PENDING_SNAPSHOT = {
      status: 'loading',
      value: undefined,
      base: undefined,
      user: undefined,
      writable: false,
      revision: undefined,
    }

    // ---------------------------------------------------------------- helpers

    /** Read one path out of a possibly absent object, never throwing. */
    function readPath(target, path) {
      let cursor = target
      for (const step of path) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = cursor[step]
      }
      // A `.volatile()` field can arrive as a cosmokit cell rather than its value;
      // the platform's own form model hands out plain values, but unwrapping here
      // costs nothing and keeps a switch from rendering a cell object as "on".
      return cursor !== null && typeof cursor === 'object' && typeof cursor.get === 'function'
        ? cursor.get()
        : cursor
    }

    /**
     * Whether the USER layer itself carries this path — i.e. whether the value is
     * an override rather than inherited from the composition or the schema
     * default. Presence is what marks an override, not a value comparison: an
     * override that happens to equal the default is still an override.
     */
    function hasPath(target, path) {
      let cursor = target
      for (const step of path) {
        if (cursor === null || typeof cursor !== 'object') return false
        if (!Object.prototype.hasOwnProperty.call(cursor, step)) return false
        cursor = cursor[step]
      }
      return true
    }

    /**
     * Read one JSON answer from a same-origin route, and turn a non-2xx into a readable error.
     *
     * Every route this panel calls answers JSON, but a wrong Host half, a proxy, or a route
     * that never mounted answers HTML — parsing that used to surface a raw SyntaxError to the
     * reader. One place decides what a route answer is, so the five callers cannot disagree.
     */
    function readJson(response) {
      if (response === undefined || response === null) return Promise.resolve(undefined)
      if (response.ok !== true) {
        const status = typeof response.status === 'number' ? ' ' + String(response.status) : ''
        return Promise.reject(new Error('插件接口返回错误' + status))
      }
      if (typeof response.json !== 'function') return Promise.resolve(undefined)
      return Promise.resolve(response.json())
    }

    /**
     * Request tickets for the panel's route reads. The Host routes are ordinary HTTP, so two
     * reads can settle out of order (a refresh pressed twice, the mount retry racing a click,
     * two directory listings in a row): only the newest answer may write state.
     */
    let channelRequestSeq = 0
    let browserRequestSeq = 0

    /**
     * Everything this panel knows about the Host configuration.
     *
     * Both the service and the row are optional, so every read is tolerant:
     * a missing `configForms`, a row this Host does not serve, and a scope whose
     * `getSnapshot` throws all end at `unavailable` instead of an exception in
     * the middle of a render.
     */
    function createConfigModel() {
      let served = false
      let scope
      let unsubscribe
      const listeners = new Set()

      const publish = () => {
        // Copy first: a listener may unsubscribe itself while being notified.
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.error('dsh-wsl-tool: a settings panel listener failed', error)
          }
        }
      }

      const read = () => {
        if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') {
          return PENDING_SNAPSHOT
        }
        try {
          const snapshot = scope.getSnapshot()
          return snapshot !== null && typeof snapshot === 'object' ? snapshot : UNAVAILABLE_SNAPSHOT
        } catch (error) {
          console.error('dsh-wsl-tool: reading the configuration scope failed', error)
          return UNAVAILABLE_SNAPSHOT
        }
      }

      return {
        /** Whether the `configForms` service was there at all. A service this DSH
         *  does not ship reads differently from a row it does not serve — and both
         *  read differently from a namespace that simply has not been listed yet. */
        hasService: () => served,
        /** Record that the service exists, before any scope is available. Without
         *  this, a namespace that has not been served yet reads as "this DSH has no
         *  configuration forms", which is a different (and wrong) diagnosis.
         *
         *  It publishes: the panel may have been rendered already (a service that
         *  arrives a moment after the seat), and `hasService()` is part of what it
         *  renders — a changed answer must reach it or the note stays wrong. */
        noteService: () => {
          served = true
          publish()
        },
        /** Bind the scope once the service appears. */
        attach: (next) => {
          if (next === undefined || next === null) return
          served = true
          scope = next
          if (typeof scope.subscribe === 'function') {
            try {
              unsubscribe = scope.subscribe(publish)
            } catch (error) {
              console.error('dsh-wsl-tool: subscribing to the configuration scope failed', error)
            }
          }
          publish()
        },
        /** Release the scope subscription; the caller's effect owns the call. */
        detach: () => {
          if (typeof unsubscribe === 'function') {
            try {
              unsubscribe()
            } catch (error) {
              console.error('dsh-wsl-tool: releasing the configuration scope failed', error)
            }
          }
          unsubscribe = undefined
        },
        read,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /**
         * Submit exactly one path-addressed write against the revision read just
         * now, and answer whether the Host accepted it.
         *
         * The revision matters: the settings service refuses a write that was
         * composed against a value somebody else has already replaced, rather than
         * silently overwriting it. Its own settings form treats any falsy answer as
         * a refusal, so this panel does the same — `false` means "not saved", and
         * the panel words it instead of pretending the switch moved.
         */
        write: async (ops) => {
          const snapshot = read()
          if (scope === undefined || typeof scope.mutate !== 'function') return false
          if (snapshot.writable !== true) return false
          // One op or an ordered batch: the service applies a batch in one
          // revision-fenced write, which is what the panel's single "restore every
          // default" control uses.
          const batch = Array.isArray(ops) ? ops : [ops]
          if (batch.length === 0) return true
          try {
            const landed = await scope.mutate(batch, snapshot.revision)
            return Boolean(landed)
          } catch (error) {
            console.error('dsh-wsl-tool: writing the configuration failed', error)
            return false
          }
        },
      }
    }

    /** Stand-in model for a seat that somehow renders without injected props, so
     *  a missing prop shows the "not served" note instead of throwing. */
    const DETACHED_MODEL = createConfigModel()

    // ----------------------------------------------------------------- styles

    const PANEL_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      height: '100%',
      maxWidth: '760px',
      overflowY: 'auto',
      padding: '24px',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
    }
    const HEADER_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px' }
    const TITLE_STYLE = { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: '26px' }
    const DESCRIPTION_STYLE = { margin: 0, color: LABEL_SECONDARY }
    const NOTE_STYLE = { margin: 0, color: LABEL_TERTIARY, fontSize: '12px', lineHeight: '18px' }
    const STACK_STYLE = { display: 'flex', flexDirection: 'column', gap: '24px' }
    const SECTION_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px' }
    const SECTION_TITLE_STYLE = { margin: 0, fontSize: '14px', fontWeight: 500, lineHeight: '20px' }
    const ROWS_STYLE = { display: 'flex', flexDirection: 'column' }
    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '14px 0',
      borderBottom: '0.5px solid ' + BORDER_SOFT,
    }
    const ROW_COPY_STYLE = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }
    const ROW_LABEL_STYLE = { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }
    const ROW_ACTIONS_STYLE = { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }
    /** The panel's single override bar; `rowGap` keeps it readable above the rows. */
    const OVERRIDE_BAR_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      justifyContent: 'flex-end',
      padding: '6px 0',
    }
    const HINT_STYLE = { margin: 0, color: LABEL_TERTIARY, fontSize: '12px', lineHeight: '18px', maxWidth: '66ch' }
    /** One path field: the input and its single 保存, side by side. */
    const FIELD_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'nowrap' }
    const INPUT_STYLE = {
      // A field wide enough for a path, not the whole panel: stretching across the column
      // squeezed the buttons beside it into two lines (measured 2026-10-22).
      flex: '0 1 300px',
      minWidth: '180px',
      maxWidth: '340px',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: RADIUS,
      border: '1px solid ' + BORDER_SOFT,
      background: 'transparent',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '12.5px',
    }
    /** The submission guide beside the copy button: an ordered list, not prose. */
    const GUIDE_STYLE = {
      margin: 0,
      paddingLeft: '18px',
      color: LABEL_SECONDARY,
      fontSize: '12px',
      lineHeight: '18px',
      maxWidth: '72ch',
    }
    /** Selected-value controls: the same chrome as an input, but a list behind it. */
    const SELECT_STYLE = {
      ...INPUT_STYLE,
      flex: '0 1 auto',
      minWidth: '220px',
      maxWidth: '360px',
      cursor: 'pointer',
    }
    /** One selectable row inside the session dropdown. */
    const ROW_OPTION_STYLE = {
      display: 'flex',
      alignItems: 'baseline',
      gap: '10px',
      width: '100%',
      boxSizing: 'border-box',
      textAlign: 'left',
      padding: '7px 10px',
      borderRadius: RADIUS,
      background: 'transparent',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '12.5px',
      lineHeight: '18px',
      cursor: 'pointer',
    }
    /** The directory browser's frame inside a path field. */
    const BROWSER_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '8px 10px',
      border: '1px solid ' + BORDER_SOFT,
      borderRadius: RADIUS,
    }
    const HELP_WRAP_STYLE = { position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: '4px', flexShrink: 0 }
    const HELP_BUTTON_STYLE = {
      width: '16px',
      height: '16px',
      borderRadius: '50%',
      border: '1px solid ' + BORDER_SOFT,
      background: 'transparent',
      color: LABEL_TERTIARY,
      fontSize: '10px',
      lineHeight: '14px',
      padding: 0,
      cursor: 'pointer',
      fontFamily: 'inherit',
    }
    const HELP_POPOVER_STYLE = {
      position: 'absolute',
      top: '22px',
      left: '0',
      zIndex: 40,
      width: '280px',
      padding: '8px 10px',
      background: 'var(--dsw-alias-bg-overlay, #1b1b1e)',
      color: LABEL_SECONDARY,
      border: '1px solid ' + BORDER_SOFT,
      borderRadius: RADIUS,
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
      fontSize: '12px',
      lineHeight: '18px',
      whiteSpace: 'normal',
      textAlign: 'left',
    }
    const GUIDE_ITEM_STYLE = { marginTop: '3px' }
    const BADGE_STYLE = {
      border: '0.5px solid ' + BORDER_BADGE,
      borderRadius: RADIUS,
      color: LABEL_SECONDARY,
      fontSize: '11px',
      lineHeight: '16px',
      padding: '1px 6px',
      whiteSpace: 'nowrap',
    }
    const DANGER_STYLE = {
      border: '0.5px solid currentColor',
      borderRadius: RADIUS,
      color: WARN_LABEL,
      fontSize: '11px',
      lineHeight: '16px',
      padding: '0 4px',
      whiteSpace: 'nowrap',
    }
    const RESET_STYLE = {
      background: 'none',
      border: 'none',
      color: LINK_LABEL,
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: '12px',
      fontWeight: 'inherit',
      padding: 0,
      textDecoration: 'underline',
      whiteSpace: 'nowrap',
      flexShrink: 0,
    }
    const DEFINITION_ROW_STYLE = { display: 'flex', alignItems: 'baseline', gap: '12px' }
    const DEFINITION_LABEL_STYLE = { color: LABEL_SECONDARY, minWidth: '13em' }
    const DEFINITION_VALUE_STYLE = { color: LABEL_PRIMARY }
    const PRE_STYLE = {
      margin: 0,
      padding: '12px',
      background: CODE_FILL,
      borderRadius: RADIUS,
      // Body text, not the inline-code tint: this is a whole block a reader has to
      // read character by character (a path with backslashes, an argv list), and the
      // inline-code token is dimmed against the very fill it sits on.
      color: LABEL_PRIMARY,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12.5px',
      lineHeight: '19px',
      overflowX: 'auto',
      whiteSpace: 'pre',
    }

    // ------------------------------------------------------------ components

    /**
     * The rail icon. A `sidebar.panellist` entry draws its own glyph: an 18×18
     * terminal prompt in `currentColor`, so the layout's selected/hover colours
     * come through untouched.
     */
    function WslIcon() {
      return React.createElement(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 20 20',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // The terminal frame, the prompt chevron, and the command line.
        React.createElement('path', {
          d: 'M3.5 4.5h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
        }),
        React.createElement('path', { d: 'M6.5 8.5 8.5 10.5 6.5 12.5' }),
        React.createElement('path', { d: 'M10.5 13h3' }),
      )
    }

    /** One read-only label/value line, used by the effective-defaults section. */
    function definitionRow(label, value) {
      return React.createElement(
        'div',
        { style: DEFINITION_ROW_STYLE },
        React.createElement('span', { style: DEFINITION_LABEL_STYLE }, label),
        React.createElement('span', { style: DEFINITION_VALUE_STYLE }, value),
      )
    }

    /** A section frame: a heading plus its body, which may be several nodes. */
    function section(key, title, ...children) {
      return React.createElement(
        'section',
        { key, style: SECTION_STYLE },
        React.createElement('h3', { style: SECTION_TITLE_STYLE }, title),
        ...children,
      )
    }

    /** A section frame whose explanation lives behind a 「?」 instead of in the body. */
    function titledSection(key, title, help, ...children) {
      return React.createElement(
        'section',
        { key, style: SECTION_STYLE },
        React.createElement(
          'h3',
          { style: SECTION_TITLE_STYLE },
          title,
          React.createElement(HelpTip, { text: help }),
        ),
        ...children,
      )
    }

    /**
     * A 「?」 that opens a small box with the explanation. Hints used to sit under every
     * row and turned the panel into a wall of text; keeping them one click away leaves the
     * controls readable while the words stay available.
     */
    function HelpTip(props) {
      const text = props !== null && props !== undefined ? props.text : undefined
      const [open, setOpen] = React.useState(false)
      // A popover that cannot be dismissed from the keyboard (or by clicking elsewhere) traps
      // the explanation on screen; both paths close it and both are removed with it.
      React.useEffect(() => {
        if (open !== true) return undefined
        const doc = pageDocument()
        if (doc === undefined || typeof doc.addEventListener !== 'function') return undefined
        const close = () => setOpen(false)
        const closeOnKey = (event) => {
          if (event !== null && event !== undefined && (event.key === 'Escape' || event.key === 'Esc')) close()
        }
        try {
          doc.addEventListener('pointerdown', close)
          doc.addEventListener('keydown', closeOnKey)
        } catch (error) {
          console.error('dsh-wsl-tool: watching for the help tip dismiss failed', error)
        }
        return () => {
          try {
            doc.removeEventListener('pointerdown', close)
            doc.removeEventListener('keydown', closeOnKey)
          } catch (error) {
            console.error('dsh-wsl-tool: releasing the help tip listeners failed', error)
          }
        }
      }, [open])
      if (typeof text !== 'string' || text === '') return null
      return React.createElement(
        'span',
        { style: HELP_WRAP_STYLE },
        React.createElement('button', {
          type: 'button',
          'aria-label': '说明',
          title: '说明',
          'aria-expanded': open ? 'true' : 'false',
          style: HELP_BUTTON_STYLE,
          onClick: (event) => {
            if (event !== null && event !== undefined) {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              if (typeof event.stopPropagation === 'function') event.stopPropagation()
            }
            setOpen(!open)
          },
          onKeyDown: (event) => {
            if (event !== null && event !== undefined && (event.key === 'Escape' || event.key === 'Esc')) {
              if (typeof event.stopPropagation === 'function') event.stopPropagation()
              setOpen(false)
            }
          },
        }, '?'),
        open
          ? React.createElement('div', {
            style: HELP_POPOVER_STYLE,
            onClick: (event) => {
              if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
              setOpen(false)
            },
          }, text)
          : null,
      )
    }

    /**
     * The panel behind the rail entry.
     *
     * It renders whatever the scope currently says — `ready`, still `loading`, or
     * `unavailable` — because a settings panel that throws or renders nothing on a
     * stripped composition is worse than one that explains itself. Reading goes
     * through the injected model so a service that appears later needs no remount.
     */
    function WslPanel(props) {
      const model = props !== null && props !== undefined && props.model !== undefined ? props.model : DETACHED_MODEL
      const [snapshot, setSnapshot] = React.useState(model.read())
      // `busy` is the path key of the write in flight; `refused` remembers that the
      // Host did not accept the last one, so the panel can say so.
      const [busy, setBusy] = React.useState(undefined)
      const [refused, setRefused] = React.useState(false)
      // Feedback copying: `ok` when the clipboard took it, `manual` when the browser
      // refused (no clipboard API, or no permission) so the text is shown to select.
      const [feedbackCopy, setFeedbackCopy] = React.useState(undefined)
      const [feedbackText, setFeedbackText] = React.useState('')
      const [selfInfo, setSelfInfo] = React.useState(undefined)
      // The sidebar terminal's startup directory: what the Host last reported, and the
      // outcome of the last write. It is NOT part of the settings scope (the terminal
      // belongs to another plugin), so it is read over its own route instead.
      const [terminal, setTerminal] = React.useState({
        status: 'loading',
        path: '',
        available: true,
        error: undefined,
      })
      const [terminalSave, setTerminalSave] = React.useState(undefined)
      // The field's draft is STATE, unlike the workdir field's closure below: this value
      // arrives ASYNCHRONOUSLY from the Host route, and an uncontrolled input would keep
      // the DOM text but lose it to the value of the re-render that the answer triggers.
      // `undefined` means "nothing typed yet", so the Host's value fills the box.
      const [terminalDraft, setTerminalDraft] = React.useState(undefined)
      // Candidate directories for the two path settings, listed from the distro so the
      // panel offers choices instead of demanding a hand-typed path.
      const [pathBrowser, setPathBrowser] = React.useState(undefined)
      const [browserDraft, setBrowserDraft] = React.useState('')
      const [browserLoading, setBrowserLoading] = React.useState(false)
      const [browserError, setBrowserError] = React.useState(undefined)
      // The same row also carries how much history its terminal keeps (`scrollback`), which
      // the app's terminal component reads through the Host's environment. Same route, same
      // rules: separate draft/save state, one control, one 保存, and the value arrives
      // asynchronously with the directory above.
      const [scrollback, setScrollback] = React.useState({
        status: 'loading',
        value: null,
        available: true,
        error: undefined,
      })
      const [scrollbackSave, setScrollbackSave] = React.useState(undefined)
      const [scrollbackDraft, setScrollbackDraft] = React.useState(undefined)
      // The workdir field's draft is state for the same reason, and for one more: the scope
      // snapshot is replaced by every switch toggle, so a closure-held draft would be lost
      // and the save would write the snapshot's value instead of the typed one.
      const [workdirDraft, setWorkdirDraft] = React.useState(undefined)
      // WSL 终端里的 dsh 命令：Host 报回的可选会话、通道状态、新建会话的草稿与安装结果。
      const [channelNewDraft, setChannelNewDraft] = React.useState('')
      const [channelInfo, setChannelInfo] = React.useState({
        status: 'loading',
        available: true,
        shim: false,
        port: null,
        host: null,
        error: undefined,
        sessions: [],
      })
      const [channelInstall, setChannelInstall] = React.useState(undefined)
      const [channelBusy, setChannelBusy] = React.useState(false)
      const [channelListBusy, setChannelListBusy] = React.useState(false)
      const [sessionMenuOpen, setSessionMenuOpen] = React.useState(false)
      /**
       * Sessions created from this panel. The Host's picker list is a cache it refreshes in
       * the background, so a read right after a creation can still omit the new session;
       * these rows are merged into the picker and count as known until the Host catches up.
       */
      const [createdSessions, setCreatedSessions] = React.useState([])
      // `true` once the wait for the configuration scope has lasted long enough that
      // "still loading" is no longer the honest answer (see SCOPE_MISSING_NOTE).
      const [scopeWaitExpired, setScopeWaitExpired] = React.useState(false)

      React.useEffect(
        () =>
          model.subscribe(() => {
            setSnapshot(model.read())
          }),
        [model],
      )

      // Bound the wait for the namespace: while it is still loading, arm one timer; the
      // moment the scope arrives (or the panel unmounts) the timer is cleared.
      React.useEffect(() => {
        if (snapshot.status === 'ready' || typeof setTimeout !== 'function') return undefined
        const timer = setTimeout(() => setScopeWaitExpired(true), SCOPE_WAIT_MS)
        return () => {
          if (typeof clearTimeout === 'function') clearTimeout(timer)
        }
      }, [snapshot.status])

      // Read the current startup directory once, on mount. A route this DSH does not
      // serve (an older Host half) must degrade to an empty field plus a note, never to
      // an exception in the middle of a render.
      React.useEffect(() => {
        const fetcher = typeof fetch === 'function' ? fetch : undefined
        if (fetcher === undefined) {
          // BOTH fields, always: a field left in 'loading' has its save button disabled
          // forever, which looks like a broken panel rather than a failed read.
          setTerminal({
            status: 'unavailable',
            path: '',
            available: true,
            error: '当前环境无法读取设置值',
          })
          setScrollback({
            status: 'unavailable',
            value: null,
            available: true,
            error: '当前环境无法读取设置值',
          })
          return undefined
        }
        let live = true
        // Bounded like the feedback read below: a route that never answers must not leave
        // the field disabled forever — it degrades to a note and an editable field.
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        const timer = typeof setTimeout === 'function'
          ? setTimeout(() => {
            if (controller !== undefined) controller.abort()
          }, 12000)
          : undefined
        Promise.resolve(fetcher(TERMINAL_ROUTE, {
          headers: { accept: 'application/json' },
          ...(controller !== undefined ? { signal: controller.signal } : {}),
        }))
          .then((response) => readJson(response))
          .then((payload) => {
            if (timer !== undefined) clearTimeout(timer)
            if (!live) return
            if (payload === undefined || payload === null || typeof payload !== 'object') {
              setTerminal({
                status: 'unavailable',
                path: '',
                available: true,
                error: '插件接口未返回有效结果',
              })
              setScrollback({
                status: 'unavailable',
                value: null,
                available: true,
                error: '插件接口未返回有效结果',
              })
              return
            }
            setTerminal({
              status: 'ready',
              path: typeof payload.path === 'string' ? payload.path : '',
              // Absent means "assume the row is there": an older Host half that does
              // not send the field must not make the panel claim the opt-in is missing.
              available: payload.available !== false,
              error: typeof payload.error === 'string' && payload.error !== '' ? payload.error : undefined,
            })
            setScrollback({
              status: 'ready',
              value: typeof payload.scrollback === 'number' ? payload.scrollback : null,
              available: payload.available !== false,
              error: typeof payload.error === 'string' && payload.error !== '' ? payload.error : undefined,
            })
          })
          .catch(() => {
            if (timer !== undefined) clearTimeout(timer)
            if (live) {
              setTerminal({
                status: 'unavailable',
                path: '',
                available: true,
                error: '插件接口不可达',
              })
              setScrollback({
                status: 'unavailable',
                value: null,
                available: true,
                error: '插件接口不可达',
              })
            }
          })
        return () => {
          live = false
          if (timer !== undefined) clearTimeout(timer)
          if (controller !== undefined) controller.abort()
        }
      }, [])

      // ------------------------------------------------------------ path browser
      //
      // Both path settings point at a directory inside the distro. Rather than a flat list
      // of guesses, each field opens this browser: parent + immediate subdirectories, one
      // click per level, plus a text box for typing a path directly.
      const loadBrowserDir = (target, path) => {
        const fetcher = typeof fetch === 'function' ? fetch : undefined
        if (fetcher === undefined) {
          setBrowserError('当前环境无法访问插件接口')
          return
        }
        // One ticket per answer: a slow listing must not overwrite a newer one (the reader
        // can press 上一级/转到 faster than a `wsl.exe` round trip).
        const ticket = (browserRequestSeq += 1)
        setPathBrowser({ target, path: typeof path === 'string' ? path : '', parent: null, entries: [] })
        setBrowserLoading(true)
        setBrowserError(undefined)
        const query = typeof path === 'string' && path !== '' ? `?path=${encodeURIComponent(path)}` : ''
        Promise.resolve(fetcher(`${DIRS_ROUTE}${query}`, { headers: { accept: 'application/json' } }))
          .then((response) => readJson(response))
          .then((payload) => {
            if (ticket !== browserRequestSeq) return
            if (payload === undefined || payload === null) {
              setBrowserError('插件接口未返回有效结果')
              return
            }
            if (typeof payload.error === 'string' && payload.error !== '') {
              setBrowserError(payload.error)
              return
            }
            setPathBrowser({
              target,
              path: typeof payload.path === 'string' ? payload.path : '',
              parent: typeof payload.parent === 'string' ? payload.parent : null,
              entries: Array.isArray(payload.entries) ? payload.entries : [],
            })
            setBrowserDraft(typeof payload.path === 'string' ? payload.path : '')
          })
          .catch((error) => {
            if (ticket !== browserRequestSeq) return
            setBrowserError(String(error?.message ?? error))
          })
          .finally(() => {
            if (ticket === browserRequestSeq) setBrowserLoading(false)
          })
      }
      const openPathBrowser = (target, startPath) => {
        const initial = typeof startPath === 'string' && startPath.trim() !== '' ? startPath.trim() : '~'
        setBrowserDraft(initial)
        loadBrowserDir(target, initial)
      }
      const pathBrowserBox = (target, apply) => {
        if (pathBrowser === undefined || pathBrowser.target !== target) return null
        return React.createElement(
          'div',
          { style: BROWSER_STYLE },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            React.createElement('span', {
              style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: LABEL_SECONDARY, fontSize: '12px' },
            }, pathBrowser.path || '（家目录）'),
            React.createElement('button', {
              type: 'button',
              style: RESET_STYLE,
              onClick: () => setPathBrowser(undefined),
            }, '关闭'),
          ),
          browserLoading
            ? React.createElement('p', { style: NOTE_STYLE }, '正在读取目录…')
            : browserError !== undefined
              ? React.createElement('p', { style: NOTE_STYLE }, '读取失败：' + browserError)
              : React.createElement(
                'div',
                { style: { maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column' } },
                React.createElement('button', {
                  type: 'button',
                  style: ROW_OPTION_STYLE,
                  disabled: pathBrowser.parent === null,
                  onClick: () => loadBrowserDir(target, pathBrowser.parent),
                }, '⬆ 上一级'),
                ...pathBrowser.entries.map((entry) => React.createElement('button', {
                  key: entry.path,
                  type: 'button',
                  style: ROW_OPTION_STYLE,
                  onClick: () => loadBrowserDir(target, entry.path),
                }, '📁 ' + entry.name)),
              ),
          !browserLoading && browserError === undefined
            ? React.createElement('button', {
              type: 'button',
              style: ROW_OPTION_STYLE,
              onClick: () => {
                apply(pathBrowser.path)
                setPathBrowser(undefined)
              },
            }, '✔ 使用此目录')
            : null,
          !browserLoading && browserError === undefined && pathBrowser.entries.length === 0
            ? React.createElement('p', { style: NOTE_STYLE }, '没有子目录')
            : null,
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('input', {
              type: 'text',
              value: browserDraft,
              style: INPUT_STYLE,
              placeholder: '~/ 或 /mnt/d/…（可直接输入）',
              onChange: (event) => setBrowserDraft(event?.target?.value ?? ''),
            }),
            React.createElement('button', {
              type: 'button',
              style: RESET_STYLE,
              onClick: () => loadBrowserDir(target, browserDraft.trim()),
            }, '转到'),
            React.createElement('button', {
              type: 'button',
              style: RESET_STYLE,
              onClick: () => {
                apply(browserDraft.trim())
                setPathBrowser(undefined)
              },
            }, '使用此路径'),
          ),
        )
      }
      /**
       * Fold one `/dsh-wsl-tool/channel` payload into state. The mount read, 刷新, the
       * install action and 新建会话 all go through this, so the picker, the notes and the
       * button labels can never disagree about the same snapshot.
       */
      const applyChannelPayload = (payload) => {
        if (payload === undefined || payload === null) return
        setChannelInfo({
          status: 'ready',
          available: payload.available !== false,
          shim: payload.shim !== null && payload.shim !== undefined && payload.shim.installed === true,
          port: typeof payload.port === 'number' ? payload.port : null,
          host: typeof payload.host === 'string' ? payload.host : null,
          error: typeof payload.error === 'string' && payload.error !== '' ? payload.error : undefined,
          sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
          sessionMeta: payload.sessionMeta !== null && typeof payload.sessionMeta === 'object' ? payload.sessionMeta : undefined,
        })
      }

      /** Read the channel state (mount, 刷新, after installs and after creating a session). */
      const loadChannel = () => {
        const fetcher = typeof fetch === 'function' ? fetch : undefined
        if (fetcher === undefined) return Promise.resolve(undefined)
        // Same ticket rule as the directory browser: the mount retry, 刷新, install and 新建
        // can overlap, and the newest answer is the only one that describes the Host.
        const ticket = (channelRequestSeq += 1)
        return Promise.resolve(fetcher(CHANNEL_STATE_ROUTE, { headers: { accept: 'application/json' } }))
          .then((response) => readJson(response))
          .then((payload) => {
            if (ticket === channelRequestSeq) applyChannelPayload(payload)
            return payload
          })
          .catch((error) => {
            if (ticket === channelRequestSeq) {
              setChannelInfo({
                status: 'unavailable',
                available: false,
                shim: false,
                port: null,
                host: null,
                error: String(error?.message ?? error),
                sessions: [],
              })
            }
            return undefined
          })
      }

      // Read the WSL channel's facts once (port, host, shim, and the sessions the picker
      // offers). A host whose channel server is still starting answers `available: false`;
      // one silent retry covers that without asking the user to press anything. A host that
      // is up but simply has no sessions is not retried - polling it would only spawn
      // another `wsl.exe` round trip for the same answer.
      React.useEffect(() => {
        let live = true
        let timer
        loadChannel().then((payload) => {
          if (!live) return
          if (payload === undefined || payload === null || payload.available !== false) return
          if (typeof setTimeout !== 'function') return
          timer = setTimeout(() => { if (live) loadChannel() }, 900)
        })
        return () => {
          live = false
          if (timer !== undefined && typeof clearTimeout === 'function') clearTimeout(timer)
        }
      }, [])

      /**
       * Send one write and reflect its outcome. The promise is returned so a
       * caller (or a test) can await the settled state; React ignores the return
       * value of an event handler, and `model.write` never rejects.
       */
      const submit = (op, key) => {
        setBusy(key)
        setRefused(false)
        return model.write(op).then((landed) => {
          setBusy(undefined)
          setRefused(!landed)
          setSnapshot(model.read())
          return landed
        })
      }

      /** One switch row: copy on the left, an override badge and the switch on the
       *  right. Clearing overrides is NOT offered per row — the panel has one
       *  control for that, so eleven rows do not repeat the same button. */
      const rowElement = (row) => {
        const key = row.path.join('.')
        const overridden = hasPath(snapshot.user, row.path)
        const disabled = snapshot.writable !== true || busy !== undefined
        const effective = readPath(snapshot.value, row.path)
        const checked = effective === undefined ? row.when : effective === true
        return React.createElement(
          'div',
          { key, style: ROW_STYLE },
          React.createElement(
            'div',
            { style: ROW_COPY_STYLE },
            React.createElement(
              'div',
              { style: ROW_LABEL_STYLE },
              row.label,
              row.danger === true ? React.createElement('span', { style: DANGER_STYLE }, '有风险') : null,
              row.caution === true ? React.createElement('span', { style: DANGER_STYLE }, '打开需谨慎') : null,
              React.createElement(HelpTip, { text: row.hint }),
            ),
          ),
          React.createElement(
            'div',
            { style: ROW_ACTIONS_STYLE },
            overridden ? React.createElement('span', { style: BADGE_STYLE }, '已覆盖') : null,
            React.createElement(primitives.Switch, {
              checked,
              label: row.label,
              disabled,
              ...(row.danger === true
                ? { title: '有风险：关掉后模型可以直接执行删除、分区、关机等命令' }
                : row.caution === true
                  ? { title: row.cautionTitle ?? '打开需谨慎：它授权插件以 root 在发行版内做固定的事（安装工具链，或按调用要求以 root 运行命令）' }
                  : {}),
              onChange: (next) => submit({ op: 'set', path: row.path, value: next === true }, key),
            }),
          ),
        )
      }

      /**
       * The sidebar terminal's startup directory.
       *
       * The 新建终端 shell belongs to another plugin, so this value cannot travel
       * through the settings scope the switches use: it lives in the profile's own
       * patch layer and is edited over the Host's route. One input and one 保存 — the
       * field is never repeated per row.
       */
      const terminalCwdSection = () => {
        const draft = terminalDraft === undefined
          ? (typeof terminal.path === 'string' ? terminal.path : '')
          : terminalDraft
        const busySave = terminalSave !== undefined && terminalSave.status === 'busy'
        // `error` here means the Host could not READ the patch file (a missing/wrong
        // `profileContext`, an unreadable file). That is NOT "this profile has no terminal
        // row": the write may still work, and the note below says so — so the save must stay
        // enabled. Only a readable file that simply has no terminal row withholds the write.
        const readError = typeof terminal.error === 'string' && terminal.error !== ''
        const missingRow = terminal.status === 'ready' && terminal.available === false && !readError
        // Saving is withheld while the current value is still being read (an empty field
        // there is "not loaded yet", not "the user cleared it") and when this profile has
        // no terminal row at all (the Host would only refuse it). The INPUT stays editable
        // in both cases: a field nobody can type into reads as a broken panel, and typing
        // is harmless while the write is withheld.
        const cannotSave = busySave || terminal.status === 'loading' || missingRow
        const save = () => {
          const value = draft.trim()
          const fetcher = typeof fetch === 'function' ? fetch : undefined
          if (fetcher === undefined) {
            setTerminalSave({ status: 'failed', error: '当前环境无法访问插件接口' })
            return Promise.resolve(false)
          }
          setTerminalSave({ status: 'busy' })
          // Returned so a test can await the settled state; a click handler ignores it.
          return Promise.resolve(fetcher(TERMINAL_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ path: value }),
          }))
            .then((response) => readJson(response))
            .then((payload) => {
              const ok = payload !== undefined && payload !== null && payload.ok === true
              const settled = payload !== undefined && payload !== null && typeof payload.path === 'string'
                ? payload.path
                : value
              if (ok) {
                setTerminal({ status: 'ready', path: settled, available: true, error: undefined })
                setTerminalSave({ status: 'ok', path: settled })
                // Back to the authoritative value, like the workdir field does: what is saved is
                // the trimmed text, so leaving the raw draft on screen would show whitespace the
                // field no longer represents — or, cleared, an empty box for a path that is set.
                setTerminalDraft(undefined)
              } else {
                const reason = payload !== undefined && payload !== null
                  && typeof payload.error === 'string' && payload.error !== ''
                  ? payload.error
                  : '宿主拒绝了本次保存'
                setTerminalSave({ status: 'failed', error: reason })
              }
              return ok
            })
            .catch((error) => {
              setTerminalSave({ status: 'failed', error: String(error?.message ?? error) || '请求插件接口失败' })
              return false
            })
        }
        const notes = []
        if (terminal.status === 'loading') {
          notes.push(React.createElement('p', { key: 'loading', style: NOTE_STYLE }, '正在读取当前启动路径…'))
        }
        if (busySave) {
          notes.push(React.createElement('p', { key: 'saving', style: NOTE_STYLE }, '正在保存…'))
        } else if (terminalSave !== undefined && terminalSave.status === 'ok') {
          notes.push(React.createElement('p', { key: 'saved', style: NOTE_STYLE },
            terminalSave.path === ''
              ? '已保存：不指定启动目录（终端从会话工作区启动）。重启 DSH 后生效。'
              : '已保存：' + terminalSave.path + '。重启 DSH 后生效。'))
        } else if (terminalSave !== undefined && terminalSave.status === 'failed') {
          notes.push(React.createElement('p', { key: 'save-failed', style: NOTE_STYLE },
            '保存失败：' + (typeof terminalSave.error === 'string' ? terminalSave.error : '原因未知')))
        }
        // "No terminal row" is only the diagnosis when the Host could actually READ the
        // file: a failure to find the patch layer at all reports `available: false` too,
        // and pointing at the opt-in recipe then sends the reader after the wrong thing
        // (measured: a host that could not name its patch file looked like a missing row).
        if (missingRow) {
          notes.push(React.createElement('p', { key: 'no-row', style: NOTE_STYLE },
            '当前配置未启用 WSL 终端。请先按 README 的「可选：在侧边栏启用 WSL 终端」完成启用，再设置启动目录。'))
        }
        if (readError) {
          notes.push(React.createElement('p', { key: 'read-failed', style: NOTE_STYLE },
            '读取失败：' + terminal.error + '（保存仍会尝试写入）'))
        }
        return titledSection(
          'terminal-cwd',
          'WSL 终端启动路径',
          '侧边栏「新建终端」中 WSL 终端的启动目录。可直接输入路径，或点击「浏览…」逐级选择子目录；留空表示不指定。修改后需重启 DSH 生效。',
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('input', {
              type: 'text',
              value: draft,
              disabled: busySave,
              style: INPUT_STYLE,
              placeholder: '~/ 或 /mnt/d/…（可直接输入）',
              onChange: (event) => {
                const next = event !== null && event !== undefined && event.target !== undefined
                  ? event.target.value
                  : ''
                setTerminalDraft(typeof next === 'string' ? next : '')
              },
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                disabled: busySave,
                onClick: () => openPathBrowser('terminal', draft),
              },
              '浏览…',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                disabled: cannotSave,
                onClick: save,
              },
              busySave ? '保存中…' : '保存',
            ),
          ),
          pathBrowserBox('terminal', (value) => setTerminalDraft(value)),
          ...notes,
        )
      }

      /**
       * How much history the sidebar terminal keeps.
       *
       * The app's terminal component builds its emulator with the `scrollback` the Host
       * reports (`@deepseek-ai/dsh-client-ui-sidebar-terminal`: `scrollback:
       * …environment?.scrollback ?? 0`), and that number is this row's own setting — so
       * raising it here is what stops long output from scrolling out of reach. Empty
       * clears the key, which hands the choice back to the platform default.
       */
      const terminalScrollbackSection = () => {
        const shown = scrollback.value === null ? '' : String(scrollback.value)
        const draft = scrollbackDraft === undefined ? shown : scrollbackDraft
        const busySave = scrollbackSave !== undefined && scrollbackSave.status === 'busy'
        // Same rule as the startup path: a read failure (`error` set) keeps the save enabled,
        // because the write may still succeed; only a readable file without the row withholds it.
        const scrollbackReadFailed = typeof scrollback.error === 'string' && scrollback.error !== ''
        const missingRow = scrollback.status === 'ready' && scrollback.available === false && !scrollbackReadFailed
        const cannotSave = busySave || scrollback.status === 'loading' || missingRow
        const save = () => {
          const fetcher = typeof fetch === 'function' ? fetch : undefined
          if (fetcher === undefined) {
            setScrollbackSave({ status: 'failed', error: '当前环境无法访问插件接口' })
            return
          }
          setScrollbackSave({ status: 'busy' })
          return Promise.resolve(fetcher(TERMINAL_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scrollback: draft.trim() }),
          }))
            .then((response) => readJson(response))
            .then((payload) => {
              const settled = payload !== undefined && payload !== null && typeof payload === 'object' ? payload : {}
              if (settled.ok === true) {
                const landed = typeof settled.scrollback === 'number' ? settled.scrollback : null
                setScrollback({ status: 'ready', value: landed, available: true, error: undefined })
                setScrollbackDraft(undefined)
                setScrollbackSave({ status: 'ok', value: landed })
                return true
              }
              const reason = typeof settled.error === 'string' && settled.error !== '' ? settled.error : '保存失败'
              setScrollbackSave({ status: 'failed', error: reason })
              return false
            })
            .catch((error) => {
              setScrollbackSave({ status: 'failed', error: String(error?.message ?? error) || '请求插件接口失败' })
              return false
            })
        }
        const notes = []
        if (scrollback.status === 'unavailable' || (scrollback.error !== undefined && scrollback.status === 'ready')) {
          notes.push(React.createElement('p', { key: 'read-note', style: NOTE_STYLE },
            '当前值读取失败：' + (scrollback.error ?? '不可用') + '（保存仍会尝试写入）'))
        }
        if (missingRow) {
          notes.push(React.createElement('p', { key: 'no-row', style: NOTE_STYLE },
            '当前配置未启用 WSL 终端。请先按 README 的「可选：在侧边栏启用 WSL 终端」完成启用，再设置历史行数。'))
        }
        if (busySave) {
          notes.push(React.createElement('p', { key: 'saving', style: NOTE_STYLE }, '正在保存…'))
        } else if (scrollbackSave !== undefined && scrollbackSave.status === 'ok') {
          notes.push(React.createElement('p', { key: 'saved', style: NOTE_STYLE },
            scrollbackSave.value === null
              ? '已保存：使用默认值。重启 DSH 后生效。'
              : `已保存：${scrollbackSave.value} 行。重启 DSH 后生效。`))
        } else if (scrollbackSave !== undefined && scrollbackSave.status === 'failed') {
          notes.push(React.createElement('p', { key: 'failed', style: NOTE_STYLE },
            '保存失败：' + (typeof scrollbackSave.error === 'string' ? scrollbackSave.error : '原因未知')))
        }
        return titledSection(
          'terminal-scrollback',
          '终端历史行数',
          '侧边栏终端保留的历史行数（数字，0 表示不保留）。留空使用平台默认值；修改后需重启 DSH 生效。',
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('input', {
              type: 'text',
              value: draft,
              placeholder: `留空 = 用默认值（1000）`,
              disabled: busySave,
              style: INPUT_STYLE,
              onChange: (event) => {
                const next = event !== null && event !== undefined && event.target !== undefined
                  ? event.target.value
                  : ''
                setScrollbackDraft(typeof next === 'string' ? next : '')
              },
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                disabled: cannotSave,
                onClick: save,
              },
              busySave ? '保存中…' : '保存',
            ),
          ),
          ...notes,
        )
      }

      /**
       * The model-facing default directory, written through the settings scope like a
       * switch. Empty means "no fixed directory", which hands the decision back to
       * 「默认跟随会话工作区」.
       *
       * The draft is STATE, not a closure variable: the scope snapshot can be replaced
       * between typing and clicking 保存 (any switch toggle, or a settling route read), and
       * a rebuilt closure would then save the snapshot's value instead of what is on screen
       * — a silent wrong write. `undefined` means "nothing typed yet", so the scope's value
       * fills the box.
       */
      const workdirSection = () => {
        const shown = readPath(snapshot.value, ['workdir'])
        const draft = workdirDraft === undefined
          ? (typeof shown === 'string' ? shown : '')
          : workdirDraft
        return titledSection(
          'workdir',
          '默认 Linux 工作目录',
          '模型未指定目录时使用的固定目录，优先于「默认跟随会话工作区」。可直接输入路径，或点击「浏览…」逐级选择；留空表示跟随会话工作区。',
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('input', {
              type: 'text',
              value: draft,
              style: INPUT_STYLE,
              placeholder: '~/ 或 /mnt/d/…（可直接输入）',
              onChange: (event) => {
                const next = event !== null && event !== undefined && event.target !== undefined
                  ? event.target.value
                  : ''
                setWorkdirDraft(typeof next === 'string' ? next : '')
              },
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                onClick: () => openPathBrowser('workdir', draft),
              },
              '浏览…',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                disabled: snapshot.writable !== true || busy !== undefined,
                onClick: () => submit([draft.trim() === ''
                  ? { op: 'unset', path: ['workdir'] }
                  : { op: 'set', path: ['workdir'], value: draft.trim() }], 'workdir')
                  .then((landed) => {
                    // Once it is written (or refused with a note), the box follows the scope
                    // again; keeping the draft forever would hide a change made elsewhere.
                    if (landed) setWorkdirDraft(undefined)
                    return landed
                  }),
              },
              '保存',
            ),
          ),
          pathBrowserBox('workdir', (value) => setWorkdirDraft(value)),
        )
      }

      /**
       * The WSL terminal command: what the channel is, and which conversation it lands in.
       * The session is a settings field — a picker over the client's own sessions plus a
       * create button, so nobody has to know an id — while installing the shim is a route
       * because it writes a file in another operating system.
       */
      const channelSection = () => {
        const stored = readPath(snapshot.value, ['channelSession'])
        const picked = typeof stored === 'string' ? stored : ''
        const hostSessions = Array.isArray(channelInfo.sessions) ? channelInfo.sessions : []
        // The Host's rows first; sessions this panel created but the Host has not listed yet
        // follow, so a just-created session is offered and recognised even when the Host's
        // cached list is still the pre-create one.
        const sessions = [
          ...hostSessions,
          ...createdSessions.filter((created) => created !== null && created !== undefined
            && !hostSessions.some((row) => row !== null && row !== undefined && row.id === created.id)),
        ]
        const known = picked === '' || sessions.some((row) => row !== null && row !== undefined && row.id === picked)
        const choose = (id) => submit([id === ''
          ? { op: 'unset', path: ['channelSession'] }
          : { op: 'set', path: ['channelSession'], value: id }], 'channelSession')
        const createAndChoose = () => {
          const fetcher = typeof fetch === 'function' ? fetch : undefined
          if (fetcher === undefined) return
          const wantedTitle = channelNewDraft.trim()
          setChannelListBusy(true)
          setChannelInstall(undefined)
          fetcher(CHANNEL_NEW_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: wantedTitle }),
          })
            .then((response) => readJson(response))
            .then((payload) => {
              if (payload === undefined || payload === null) return undefined
              if (payload.ok !== true) {
                setChannelInstall({ ok: false, detail: payload.detail ?? '新建会话失败' })
                return undefined
              }
              const created = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
              setChannelNewDraft('')
              if (created !== '') {
                // Remember it locally: the refresh below is a cached answer and may not carry
                // it yet, and calling the panel's own new session "unavailable" would be wrong.
                setCreatedSessions((previous) => (previous.some((row) => row !== null && row !== undefined && row.id === created)
                  ? previous
                  : [...previous, {
                    id: created,
                    title: wantedTitle === '' ? '未命名会话' : wantedTitle,
                    activityAt: Date.now(),
                    workspace: '',
                  }]))
              }
              return choose(created)
            })
            .catch((error) => setChannelInstall({ ok: false, detail: String(error?.message ?? error) }))
            .finally(() => {
              setChannelListBusy(false)
              loadChannel()
            })
        }
        const install = () => {
          const fetcher = typeof fetch === 'function' ? fetch : undefined
          if (fetcher === undefined) return
          setChannelBusy(true)
          setChannelInstall(undefined)
          fetcher(CHANNEL_INSTALL_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
            .then((response) => readJson(response))
            .then((payload) => {
              setChannelInstall(payload ?? { ok: false, detail: '插件接口未返回有效结果' })
            })
            .catch((error) => setChannelInstall({ ok: false, detail: String(error?.message ?? error) }))
            .finally(() => {
              setChannelBusy(false)
              loadChannel()
            })
        }
        const rows = sessions

        const currentRow = rows.find((row) => row !== null && row !== undefined && row.id === picked)
        const selectedLabel = currentRow !== undefined
          ? (currentRow.title || '未命名会话')
          : (picked === '' ? '默认（最近活跃会话）' : '（所选会话不可用）')
        const rowElement = (row) => React.createElement(
          'button',
          {
            key: row.id,
            type: 'button',
            style: { ...ROW_OPTION_STYLE, border: '1px solid ' + (row.id === picked ? BORDER_BADGE : BORDER_SOFT) },
            onClick: () => {
              setSessionMenuOpen(false)
              choose(row.id)
            },
          },
          React.createElement('span',
            { style: { color: row.id === picked ? LABEL_PRIMARY : LABEL_TERTIARY } },
            row.id === picked ? '●' : '○'),
          React.createElement('span',
            { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            row.title || '未命名会话'),
          React.createElement('span',
            { style: { color: LABEL_TERTIARY, flexShrink: 0 } },
            [relativeTime(row.activityAt ?? row.createdAt), row.workspace]
              .filter((part) => typeof part === 'string' && part !== '')
              .join(' · ')),
        )
        const note = channelInfo.status === 'ready'
          ? (channelInfo.available === false
            ? '宿主未启动通道服务：WSL 未运行，或 wsl.exe 不可用。'
            : `通道监听 ${channelInfo.host ?? '?'}:${String(channelInfo.port ?? '?')}；dsh 命令${channelInfo.shim ? '已安装' : '未安装'}。`)
          : channelInfo.status === 'loading'
            ? '正在读取通道状态…'
            : (channelInfo.error ?? '无法读取通道状态')
        return titledSection(
          'channel',
          'WSL 终端中的 DSH 命令',
          '「通道」把你在 WSL 终端里输入的内容原样转发给所选会话，再把该会话的回复流式转发回终端（终端只显示思考计时与回答，不显示思考内容）。会话正在执行任务时，这段输入会以 steer 方式送入当前回合，不会排队；留空落点时使用最近活跃的会话。安装后在 WSL 终端执行 dsh help 可查看全部命令。',
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('button', {
              type: 'button',
              style: { ...SELECT_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
              'aria-expanded': sessionMenuOpen ? 'true' : 'false',
              onClick: () => setSessionMenuOpen(!sessionMenuOpen),
            },
              React.createElement('span',
                { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                selectedLabel),
              React.createElement('span', { style: { color: LABEL_TERTIARY } }, sessionMenuOpen ? '▴' : '▾')),
            React.createElement('button', {
              type: 'button',
              style: RESET_STYLE,
              disabled: channelListBusy,
              onClick: () => {
                setChannelListBusy(true)
                loadChannel().finally(() => setChannelListBusy(false))
              },
            }, channelListBusy ? '刷新中…' : '刷新'),
          ),
          sessionMenuOpen
            ? (rows.length === 0
              ? React.createElement('p', { style: NOTE_STYLE },
                `暂无可选会话（共扫描 ${String(channelInfo.sessionMeta?.records ?? '?')} 个，其中工作区会话 ${String(channelInfo.sessionMeta?.members ?? '?')} 个）；可在下方新建。`)
              : React.createElement('div',
                { style: { ...STACK_STYLE, maxHeight: '220px', overflowY: 'auto' } },
                rows.map(rowElement)))
            : null,
          picked !== '' && known === false
            ? React.createElement('p', { style: NOTE_STYLE },
              '所选会话不可用（可能已删除），请重新选择或新建。')
            : null,
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('input', {
              type: 'text',
              value: channelNewDraft,
              placeholder: '新会话名，例如 wsl',
              style: INPUT_STYLE,
              onChange: (event) => {
                const next = event !== null && event !== undefined && event.target !== undefined
                  ? event.target.value
                  : ''
                setChannelNewDraft(typeof next === 'string' ? next : '')
              },
            }),
            React.createElement('button', {
              type: 'button',
              style: RESET_STYLE,
              disabled: channelListBusy,
              onClick: createAndChoose,
            }, '新建并选用'),
          ),
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('button', {
              type: 'button',
              style: RESET_STYLE,
              disabled: channelBusy,
              onClick: install,
            }, channelBusy ? '安装中…' : (channelInfo.shim ? '重新安装 dsh 命令' : '安装 dsh 命令')),
          ),
          React.createElement('p', { style: NOTE_STYLE }, note),
          channelInstall === undefined
            ? null
            : React.createElement('p', { style: NOTE_STYLE },
              channelInstall.ok === true
                ? `已安装到 ${channelInstall.target ?? '~/.local/bin/dsh'}`
                : `安装失败：${channelInstall.detail ?? '未知原因'}`),
        )
      }

      const children = []

      children.push(
        React.createElement(
          'header',
          { key: 'header', style: HEADER_STYLE },
          React.createElement('h2', { style: TITLE_STYLE }, 'WSL', React.createElement(HelpTip, {
            text: '开关改动即时生效；终端启动路径与历史行数需重启 DSH 后生效。你打开的终端，模型也可以在里面工作：命令会先显示在界面上，工作期间终端只读，点击「接管输入」即可恢复输入。',
          })),
          React.createElement('p', { style: DESCRIPTION_STYLE }, '让模型在 WSL 中执行 Linux 命令、转换路径、检查环境，并可在你打开的终端中工作'),
        ),
      )

      // The two directories this panel owns, one control each, at the top: the model's
      // working directory (this plugin's own setting, written through the settings
      // scope) and the sidebar terminal's startup directory (a profile-patch row owned
      // by another plugin, written over the Host's route). One stack because they are
      // the same question — "where does this start?" — asked of two different things.
      // The terminal field is rendered in every branch: it does not travel through the
      // settings service, so it must not disappear together with it.
      const directories = [terminalCwdSection(), terminalScrollbackSection()]
      if (snapshot.status === 'ready') directories.push(workdirSection(), channelSection())
      children.push(React.createElement('div', { key: 'directories', style: STACK_STYLE }, directories))

      // The switches — or the one reason they cannot be shown right now.
      if (model.hasService() !== true) {
        children.push(
          React.createElement(
            'p',
            { key: 'note-service', style: NOTE_STYLE },
            '当前 DSH 未提供配置表单服务，无法在此调整设置。',
          ),
        )
      } else if (snapshot.status === 'loading') {
        // A namespace that never arrives looks exactly like a slow one, so the wait is
        // bounded: past it, say what is actually missing instead of waiting forever. The
        // usual cause is a Host without the plugin's schema peer (no form is projected at
        // all) — and the tools plus the terminal field work regardless.
        children.push(React.createElement('p', { key: 'note-loading', style: NOTE_STYLE },
          scopeWaitExpired
            ? SCOPE_MISSING_NOTE
            : '正在等待 Host 提供该插件的配置作用域（' + CONFIG_ROW_ID + '）…'))
      } else if (snapshot.status !== 'ready') {
        children.push(
          React.createElement('p', { key: 'note-unavailable', style: NOTE_STYLE }, SCOPE_MISSING_NOTE),
        )
      } else {
        const overriddenPaths = SECTIONS
          .flatMap((group) => group.rows)
          .filter((row) => hasPath(snapshot.user, row.path))
          .map((row) => row.path)
        const blocks = SECTIONS.map((group) =>
          section(group.id, group.title, React.createElement('div', { style: ROWS_STYLE }, group.rows.map(rowElement))),
        )
        // ONE place to clear every override, instead of the same button repeated on
        // every row. "Put this panel back the way the composition had it" is one
        // intention, and the settings service takes it as one revision-fenced write.
        if (overriddenPaths.length > 0) {
          blocks.unshift(
            React.createElement(
              'div',
              { key: 'overrides', style: OVERRIDE_BAR_STYLE },
              React.createElement('span', { style: BADGE_STYLE }, '已覆盖 ' + overriddenPaths.length + ' 项'),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: RESET_STYLE,
                  disabled: snapshot.writable !== true || busy !== undefined,
                  // Returned as well as performed: React ignores a handler's return
                  // value, but awaiting it is how a test sees the write settle.
                  onClick: () => submit(overriddenPaths.map((path) => ({ op: 'unset', path })), 'all-overrides'),
                },
                '全部恢复默认',
              ),
            ),
          )
        }
        if (refused) {
          blocks.unshift(
            React.createElement('p', { key: 'note-refused', style: NOTE_STYLE }, '保存失败：配置未写入，请重试'),
          )
        }
        children.push(React.createElement('div', { key: 'switches', style: STACK_STYLE }, blocks))
      }

      // The effective values of the two knobs that have no switch, because they
      // are a distro name and a duration rather than a boolean.
      if (snapshot.status === 'ready') {
        const distro = readPath(snapshot.value, ['distro'])
        const timeoutMs = readPath(snapshot.value, ['timeoutMs'])
        children.push(
          section(
            'defaults',
            '当前默认值',
            React.createElement(
              'div',
              null,
              definitionRow(
                '发行版 distro',
                typeof distro === 'string' && distro.trim() !== '' ? distro : '系统默认发行版',
              ),
              definitionRow(
                '命令超时 timeoutMs',
                typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs + ' 毫秒' : '—',
              ),
            ),
            React.createElement(
              'p',
              { style: HINT_STYLE },
              '这两项来自插件配置：可在 profile 的 `cordis.patch.yml` 中设置，或用环境变量 `DSH_WSL_DISTRO` / `DSH_WSL_TIMEOUT_MS` 覆盖。',
            ),
          ),
        )
      }

      // ------------------------------------------------------- feedback (one entry)
      //
      // One place, two ways out: the issue chooser for anyone who can reach GitHub,
      // and this plugin's own facts as text for anyone who cannot (measured on this
      // machine: github.com is not always reachable). The guide sits beside the
      // button, because "where does this go" is the question the copied block raises.
      // Nothing is sent by this plugin: the bytes leave only when the user pastes them.
      const FEEDBACK_URL = 'https://github.com/XINY11451/dsh-wsl/issues/new/choose'

      const switchLines = () => SECTIONS.flatMap((group) =>
        group.rows.map((row) => {
          const effective = readPath(snapshot.value, row.path)
          const checked = effective === undefined ? row.when : effective === true
          return `- ${row.label}：${checked ? '开' : '关'}`
        }),
      )

      /**
       * The block the button copies: the plugin's own facts.
       *
       * `info` is what the Host half answered on `/dsh-wsl-tool/info`, read from this
       * package's manifest, so no version is ever copied by hand. When it is missing
       * — an older host, a route that never mounted, a blocked request — the block
       * says so instead of inventing a number, and still carries what this panel knows.
       */
      const infoText = (info) => {
        const hostConfig = info !== null && typeof info === 'object' ? info.config : undefined
        const lines = ['### 插件信息（插件自动读取，可直接粘贴）']
        if (info === undefined || info === null) {
          lines.push('- 版本：未能读取（见市场条目，或 `npm ls dsh-wsl-tool`）')
          lines.push('- DSH：未能读取（可在设置中查看）')
          lines.push('- WSL 发行版与内核：未能读取（可运行一次 `wsl-env` 工具）')
        } else {
          lines.push(`- 插件：${info.name} ${info.version ?? '（版本未知）'}`)
          if (typeof info.repository === 'string' && info.repository !== '') lines.push(`- 仓库：${info.repository}`)
          if (typeof info.node === 'string') lines.push(`- Node ${info.node}　平台 ${info.platform} ${info.arch}`)
          // Both of these are read by the host half; a value that could not be read
          // says so rather than being invented.
          const dsh = info.dsh
          lines.push(dsh !== null && dsh !== undefined && typeof dsh.version === 'string'
            ? `- DSH：${dsh.version}（${dsh.name}）`
            : '- DSH：未能读取（可在设置中查看）')
          const wsl = info.wsl
          if (wsl !== null && wsl !== undefined && typeof wsl === 'object') {
            const parts = []
            if (typeof wsl.defaultDistro === 'string' && wsl.defaultDistro !== '') {
              parts.push(`${wsl.defaultDistro}（默认发行版）`)
            }
            if (typeof wsl.kernel === 'string' && wsl.kernel !== '') parts.push(`内核 ${wsl.kernel}`)
            lines.push(`- WSL：${parts.length > 0 ? parts.join('；') : '未探测到发行版或内核'}`)
            if (Array.isArray(wsl.capabilities) && wsl.capabilities.length > 0) {
              lines.push(`- WSL 能力：${wsl.capabilities.join('　')}`)
            }
          } else {
            lines.push('- WSL：未能读取（可运行一次 `wsl-env` 工具）')
          }
        }
        lines.push('')
        lines.push('### 面板开关状态')
        lines.push(...switchLines())
        const distro = hostConfig?.distro ?? readPath(snapshot.value, ['distro'])
        const timeoutMs = hostConfig?.commandTimeoutMs ?? readPath(snapshot.value, ['timeoutMs'])
        lines.push(`- 发行版 distro：${typeof distro === 'string' && distro.trim() !== '' ? distro : '系统默认'}`)
        lines.push(`- 命令超时 timeoutMs：${typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? `${timeoutMs} 毫秒` : '—'}`)
        return lines.join('\n')
      }

      const writeFeedback = (text) => {
        const clipboard = typeof navigator === 'object' && navigator !== null ? navigator.clipboard : undefined
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          // No clipboard API (or no permission): show the text so it can be selected.
          setFeedbackText(text)
          setFeedbackCopy('manual')
          return
        }
        try {
          Promise.resolve(clipboard.writeText(text)).then(
            () => setFeedbackCopy('ok'),
            () => {
              setFeedbackText(text)
              setFeedbackCopy('manual')
            },
          )
        } catch {
          setFeedbackText(text)
          setFeedbackCopy('manual')
        }
      }

      const copyInfo = () => {
        // The Host half's answer is cached after the first success: the second click
        // copies without a round trip.
        if (selfInfo !== undefined) {
          writeFeedback(infoText(selfInfo))
          return undefined
        }
        const fetcher = typeof fetch === 'function' ? fetch : undefined
        if (fetcher === undefined) {
          writeFeedback(infoText(undefined))
          return undefined
        }
        // Bounded, but generously: the host half probes WSL (a few round trips) before
        // it answers, and aborting early would paste a block full of "unreadable".
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        const timer = typeof setTimeout === 'function'
          ? setTimeout(() => {
            if (controller !== undefined) controller.abort()
          }, 12000)
          : undefined
        setFeedbackCopy('busy')
        // Returned so a test can await the round trip; a click handler may ignore it.
        return Promise.resolve(fetcher(INFO_ROUTE, {
          headers: { accept: 'application/json' },
          ...(controller !== undefined ? { signal: controller.signal } : {}),
        }))
          .then((response) => (response !== undefined && response !== null && response.ok === true
            ? response.json()
            : undefined))
          .then((info) => {
            if (timer !== undefined) clearTimeout(timer)
            if (info !== undefined && info !== null && typeof info === 'object') setSelfInfo(info)
            writeFeedback(infoText(info ?? undefined))
          })
          .catch(() => {
            if (timer !== undefined) clearTimeout(timer)
            writeFeedback(infoText(undefined))
          })
      }

      children.push(
        section(
          'feedback',
          '反馈与支持',
          React.createElement(
            'div',
            { style: OVERRIDE_BAR_STYLE },
            React.createElement(
              'a',
              {
                href: FEEDBACK_URL,
                target: '_blank',
                rel: 'noreferrer noopener',
                style: { color: LINK_LABEL, fontSize: '12px' },
              },
              '在 GitHub 打开反馈页',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                disabled: feedbackCopy === 'busy',
                onClick: copyInfo,
              },
              feedbackCopy === 'busy'
                ? '正在读取…'
                : feedbackCopy === 'ok' ? '已复制 ✓' : '复制插件信息',
            ),
          ),
          React.createElement('p', { style: HINT_STYLE }, FEEDBACK_URL),
          React.createElement(
            'ol',
            { style: GUIDE_STYLE },
            ...GUIDE.map((line, index) =>
              React.createElement('li', { key: `guide-${index}`, style: GUIDE_ITEM_STYLE }, line)),
          ),
          feedbackCopy === 'manual' ? React.createElement('pre', { style: PRE_STYLE }, feedbackText) : null,
          feedbackCopy === 'manual'
            ? React.createElement('p', { style: HINT_STYLE },
              '（浏览器未允许自动复制：请全选上方内容后粘贴）')
            : null,
        ),
      )

      return React.createElement('div', { style: PANEL_STYLE }, children)
    }

    // ------------------------------------------------------ terminal bridge
    //
    // DSH 0.2.1 removed `terminalController.follow`/`write`: opening a terminal needs a
    // Remote invocation, and a Host plugin has none. The bridge turns that around. The Host
    // half parks what it wants done as small commands (attach / write / detach); this page —
    // which does own a Remote invocation — executes them against `webTerminals` and streams
    // the screen frames back as events. The user keeps a real sidebar terminal in view, can
    // watch the tool type, and can take the keyboard back at any time.
    //
    // Everything below is optional and defensive. No `webTerminals` service, no `fetch`, a
    // missing bridge route, a view that refuses to open: each ends in "do nothing, log once".
    // The Host has a private-PTY fallback, and it must never be worse off because this half
    // is old or the composition is thin.

    const BRIDGE_POLL_ROUTE = '/dsh-wsl-tool/term-bridge/poll'
    const BRIDGE_EVENTS_ROUTE = '/dsh-wsl-tool/term-bridge/events'
    /** One view per attachment: a new attachment must never join the previous view. */
    const BRIDGE_KEY_PREFIX = 'dsh-wsl-bridge:'
    /**
     * The content identity is stable per TERMINAL, not per attachment. The client terminal
     * service saves one recovery binding per (session, contentId) — in `localStorage` — and
     * only `close()` ever removes it, which this half must never call: a fresh attachment id
     * there would leave one permanent storage key behind for every tool call.
     */
    const BRIDGE_CONTENT_PREFIX = 'dsh-wsl-bridge:content:'
    /** A failed poll is retried after this delay; a 404 is final and stops the loop. */
    const BRIDGE_RETRY_MS = 2000
    /** Events are batched: at most one request per interval, or immediately past this many. */
    const BRIDGE_FLUSH_MS = 50
    const BRIDGE_FLUSH_COUNT = 32
    /** Fallback sampling period for a store that has no `subscribe`. */
    const BRIDGE_STATE_POLL_MS = 100
    /**
     * One command's client-side deadline. It must outlast the Host's own attach deadline
     * (15 s): a terminal that is legitimately slow to open must not be reported as "the
     * browser could not run this", while a command that can never settle must not park the
     * poll loop — and every command queued behind it — forever.
     */
    const BRIDGE_COMMAND_TIMEOUT_MS = 20_000
    /** One events POST's target size; the Host rejects a body over 4 MB outright. */
    const BRIDGE_EVENT_BATCH_BYTES = 1024 * 1024
    /** A keepalive fetch is capped at 64 KB (and shares a quota): one small last batch. */
    const BRIDGE_UNLOAD_BATCH_BYTES = 60 * 1024

    /** Upper-bound UTF-8 size of one event inside the events body (`length * 3` covers UTF-16). */
    function bridgeEventBytes(event) {
      let text
      try {
        text = JSON.stringify(event)
      } catch (error) {
        text = '{}'
      }
      return String(text).length * 3 + 32
    }

    /** Events that settle a Host waiter: they must never be dropped behind screen data. */
    function isBridgePriorityEvent(event) {
      if (event === null || typeof event !== 'object') return false
      return event.type === 'result' || event.type === 'error' || event.type === 'inventory'
    }

    /** Split one oversized output frame into pieces the Host can accept side by side. */
    function bridgeEventPieces(event, limit) {
      if (event === null || typeof event !== 'object') return [event]
      if (event.type !== 'output' || typeof event.data !== 'string') return [event]
      if (bridgeEventBytes(event) <= limit) return [event]
      const perPiece = Math.max(4 * 1024, Math.floor(limit / 3) - 64)
      const pieces = []
      for (let index = 0; index < event.data.length; index += perPiece) {
        pieces.push({ ...event, data: event.data.slice(index, index + perPiece) })
      }
      return pieces
    }

    /**
     * Plan the requests one queue drains in: priority events first (in their own batches, so a
     * long screen frame cannot push a `result` past the Host's wait), then screen frames in
     * their original order, each batch under `limit` estimated bytes.
     */
    function planBridgeBatches(list, limit) {
      const groups = [[], []]
      for (const event of list) {
        for (const piece of bridgeEventPieces(event, limit)) {
          groups[isBridgePriorityEvent(event) ? 0 : 1].push(piece)
        }
      }
      const batches = []
      for (const group of groups) {
        let current = []
        let size = 0
        for (const event of group) {
          const cost = bridgeEventBytes(event)
          if (current.length > 0 && size + cost > limit) {
            batches.push(current)
            current = []
            size = 0
          }
          current.push(event)
          size += cost
        }
        if (current.length > 0) batches.push(current)
      }
      return batches
    }

    /**
     * The one keepalive batch an unloading page may send: priority events first, then frames,
     * up to `limit`. What does not fit is dropped (and logged) rather than split, because the
     * browser caps keepalive bodies and this is the last chance to say anything at all.
     */
    function planBridgeUnloadBatch(list, limit) {
      const ordered = []
      for (const event of list) if (isBridgePriorityEvent(event)) ordered.push(event)
      for (const event of list) if (!isBridgePriorityEvent(event)) ordered.push(event)
      const events = []
      let dropped = 0
      let size = 0
      for (const event of ordered) {
        const cost = bridgeEventBytes(event)
        if (size + cost > limit) {
          dropped += 1
          continue
        }
        events.push(event)
        size += cost
      }
      return { events, dropped }
    }

    /** One client id per page load: the Host keys liveness and its command queue on it. */
    function newBridgeClientId() {
      let id = ''
      while (id.length < 24) {
        id += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
      }
      return id.slice(0, 24)
    }

    /**
     * Start the browser half of the terminal bridge, once.
     *
     * The whole startup is wrapped: a client half that throws in `apply` takes the panel and
     * the composer dock down with it, and the WSL tools work without any of this. The Host
     * service is reached through `ctx.inject` rather than this module's own `inject` array
     * for the same reason — no terminal service is not a reason to refuse to mount.
     */
    function startTerminalBridge(ctx) {
      const fetcher = typeof fetch === 'function' ? fetch : undefined
      if (fetcher === undefined) {
        console.error('dsh-wsl-tool: this page has no fetch; the terminal bridge stays off')
        return
      }
      if (typeof ctx.inject !== 'function') return
      /** The service may be injected more than once (reload); keep one worker. */
      let worker
      try {
        ctx.inject(['webTerminals'], (inner) => {
          try {
            if (worker !== undefined) return
            const webTerminals = inner === undefined || inner === null ? undefined : inner.webTerminals
            // No terminal service: the Host falls back to its own PTY and nothing polls.
            if (webTerminals === undefined || webTerminals === null) return
            const started = createTerminalBridge({ fetcher, webTerminals })
            worker = started
            started.start()
            if (typeof inner.effect === 'function') {
              inner.effect(() => () => {
                try {
                  started.stop()
                } catch (error) {
                  console.error('dsh-wsl-tool: stopping the terminal bridge failed', error)
                }
                if (worker === started) worker = undefined
              }, 'dsh-wsl-tool: terminal bridge')
            }
          } catch (error) {
            console.error('dsh-wsl-tool: starting the terminal bridge failed', error)
          }
        })
      } catch (error) {
        console.error('dsh-wsl-tool: asking for the terminal service failed', error)
      }
    }

    /**
     * The worker: one long-poll loop, one ordered event queue, one view per attachment.
     *
     * @param options.fetcher - the page's `fetch`.
     * @param options.webTerminals - the client terminal service (`ClientTerminals`).
     * @returns `{ start, stop }`; `stop` releases every view and aborts the loop.
     */
    function createTerminalBridge(options) {
      const fetcher = options.fetcher
      const webTerminals = options.webTerminals
      const clientId = newBridgeClientId()
      const bindings = new Map()
      let events = []
      let flushTimer
      let flushing = false
      let pollController
      let sleepTimer
      let started = false
      let stopped = false
      let pagehideHooked = false
      /** Bumped by every start(), so a loop from an earlier start exits on its next step. */
      let generation = 0
      /** Deadlines of the commands currently running, cleared by `stop()`. */
      const commandTimers = new Set()

      const report = (message, error) => {
        if (error === undefined) console.error('dsh-wsl-tool: ' + message)
        else console.error('dsh-wsl-tool: ' + message, error)
      }
      const asText = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
      const messageOf = (error) => (error !== null && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : String(error))

      // ---------------------------------------------------------------- events

      /** Whether the queue holds an event the Host is blocked on. */
      const hasPriorityEvent = () => events.some((event) => isBridgePriorityEvent(event))

      /** Send now (a microtask later), cancelling a pending batch timer. */
      function kickFlush() {
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer)
          flushTimer = undefined
        }
        void flushEvents()
      }

      function scheduleFlush() {
        if (stopped) return
        // A command result (or an error, or an inventory answer) must not wait out
        // BRIDGE_FLUSH_MS: the Host is blocked on it, and one tool run used to pay a batch
        // timer for every acknowledgement — measured 247.9 ms for a run that is 4.9 ms of work.
        if (events.length >= BRIDGE_FLUSH_COUNT || hasPriorityEvent()) {
          kickFlush()
          return
        }
        if (flushTimer !== undefined || flushing) return
        flushTimer = setTimeout(() => {
          flushTimer = undefined
          void flushEvents()
        }, BRIDGE_FLUSH_MS)
      }

      /**
       * Queue one event. `urgent` is for the first screen of an attachment: the Host's frame
       * loop cannot type anything until it has that snapshot, so it skips the batch timer too.
       */
      function pushEvent(event, urgent = false) {
        if (stopped) return
        events.push(event)
        if (urgent) kickFlush()
        else scheduleFlush()
      }

      function succeed(command) {
        pushEvent({ type: 'result', commandId: asText(command === undefined || command === null ? undefined : command.id), ok: true })
      }

      function fail(command, reason) {
        pushEvent({
          type: 'result',
          commandId: asText(command === undefined || command === null ? undefined : command.id),
          ok: false,
          error: reason,
        })
      }

      async function postEvents(batch, keepalive = false) {
        try {
          const response = await fetcher(BRIDGE_EVENTS_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId, events: batch }),
            ...(keepalive ? { keepalive: true } : {}),
          })
          if (response === null || response === undefined) return false
          return response.ok === true
        } catch (error) {
          return false
        }
      }

      /**
       * Send the queue in order, one request at a time.
       *
       * Order is the point: frames must reach the Host in the order the terminal produced
       * them, so a second batch never starts while the first is in flight. Each batch is
       * bounded (a >4 MB body is refused by the Host, and that used to drop the whole queue),
       * and after one retry the rest is dropped with a single log line — a bridge that cannot
       * reach its own page must not grow an unbounded queue or spend one retry per batch.
       */
      async function flushEvents() {
        if (stopped || flushing || events.length === 0) return
        flushing = true
        const queue = events
        events = []
        try {
          const batches = planBridgeBatches(queue, BRIDGE_EVENT_BATCH_BYTES)
          for (let index = 0; index < batches.length; index += 1) {
            const batch = batches[index]
            let delivered = await postEvents(batch)
            if (!delivered) delivered = await postEvents(batch)
            if (!delivered) {
              let dropped = 0
              for (const rest of batches.slice(index)) dropped += rest.length
              report('the terminal bridge dropped ' + String(dropped) + ' events')
              break
            }
          }
        } finally {
          flushing = false
          if (events.length > 0) scheduleFlush()
        }
      }

      // ----------------------------------------------------------------- views

      function readViewState(binding) {
        try {
          const view = binding.view
          const state = view === null || view === undefined ? undefined : view.state
          if (state === null || state === undefined || typeof state.getSnapshot !== 'function') return undefined
          const snapshot = state.getSnapshot()
          return snapshot !== null && typeof snapshot === 'object' ? snapshot : undefined
        } catch (error) {
          return undefined
        }
      }

      function frameEvent(binding, frame, state) {
        if (frame === null || frame === undefined || typeof frame !== 'object') return undefined
        if (frame.type === 'snapshot') {
          const info = frame.info !== undefined && frame.info !== null ? frame.info : state.info
          return {
            type: 'snapshot',
            attachmentId: binding.attachmentId,
            screen: typeof frame.screen === 'string' ? frame.screen : '',
            info: info === undefined ? null : info,
            writable: frame.writable === true,
          }
        }
        if (frame.type === 'output') {
          return {
            type: 'output',
            attachmentId: binding.attachmentId,
            data: typeof frame.data === 'string' ? frame.data : '',
          }
        }
        return undefined
      }

      /**
       * Turn the view's current store value into at most one frame event and one state event.
       *
       * A render revision is acknowledged IMMEDIATELY after its event is queued. The view
       * resolves its pending render only on `acknowledge`, so a missing ack would freeze the
       * terminal on the first frame; here the durability of the frame is the Host's problem
       * (its event batch has its own retry), not a reason to stall the view.
       */
      function observe(binding) {
        if (binding.disposed) return
        const state = readViewState(binding)
        if (state === undefined) return
        const phase = state.phase
        const failed = phase === 'failed' || phase === 'disconnected' || phase === 'closed'
        if (failed && binding.reportedPhase !== phase) {
          binding.reportedPhase = phase
          let message = phase === 'closed'
            ? 'the terminal was closed'
            : phase === 'disconnected'
              ? 'the terminal connection was lost'
              : 'the terminal could not be opened'
          if (typeof state.error === 'string' && state.error !== '') message += ': ' + state.error
          pushEvent({ type: 'error', attachmentId: binding.attachmentId, message })
        }
        const writable = state.writable === true
        const info = state.info
        const render = state.render
        if (render !== undefined && render !== null
          && typeof render.revision === 'number' && render.revision !== binding.lastRevision) {
          const revision = render.revision
          binding.lastRevision = revision
          const event = frameEvent(binding, render.frame, state)
          if (event !== undefined) {
            // The first screen of an attachment is what the Host's frame loop waits for
            // before it can type; deliver it without the batch timer.
            const firstScreen = event.type === 'snapshot' && binding.sawSnapshot !== true
            if (firstScreen) binding.sawSnapshot = true
            pushEvent(event, firstScreen)
          }
          try {
            if (typeof binding.view.acknowledge === 'function') binding.view.acknowledge(revision)
          } catch (error) {
            report('acknowledging terminal output failed', error)
          }
        }
        if (binding.lastWritable !== writable || binding.lastInfo !== info) {
          const reportable = binding.lastWritable !== undefined || info !== undefined
          binding.lastWritable = writable
          binding.lastInfo = info
          if (reportable) {
            pushEvent({
              type: 'state',
              attachmentId: binding.attachmentId,
              info: info === undefined ? null : info,
              writable,
            })
          }
        }
      }

      function watch(binding) {
        const view = binding.view
        const state = view === null || view === undefined ? undefined : view.state
        try {
          if (state !== null && state !== undefined && typeof state.subscribe === 'function') {
            const stop = state.subscribe(() => {
              try {
                observe(binding)
              } catch (error) {
                report('reading the terminal view failed', error)
              }
            })
            if (typeof stop === 'function') binding.unsubscribe = stop
            return
          }
        } catch (error) {
          report('subscribing to the terminal view failed', error)
        }
        // Older store without `subscribe`: sample it instead, at a period a terminal can bear.
        if (typeof setTimeout === 'function') {
          const tick = () => {
            binding.timer = undefined
            if (binding.disposed) return
            try {
              observe(binding)
            } catch (error) {
              report('reading the terminal view failed', error)
            }
            binding.timer = setTimeout(tick, BRIDGE_STATE_POLL_MS)
          }
          binding.timer = setTimeout(tick, BRIDGE_STATE_POLL_MS)
        }
      }

      function unwatch(binding) {
        if (typeof binding.unsubscribe === 'function') {
          try {
            binding.unsubscribe()
          } catch (error) {
            report('unsubscribing from the terminal view failed', error)
          }
          binding.unsubscribe = undefined
        }
        if (binding.timer !== undefined) {
          clearTimeout(binding.timer)
          binding.timer = undefined
        }
      }

      // -------------------------------------------------------------- commands

      /**
       * Give the terminal's keyboard back to the view the USER watches.
       *
       * `attach` makes the calling view the terminal's controller; disposing that view clears
       * the controller and the user's own sidebar tab stays read-only (its next keystrokes are
       * dropped, so even Ctrl+C does nothing until they click 接管输入). `ClientTerminals.views`
       * still holds the user's view for that terminal — reconnect it, which is exactly the
       * "reattach with a fresh screen and regain input control" path DSH itself uses. Anything
       * unexpected is ignored: the detach has already succeeded and must not be reported as a
       * failure.
       * @param {{ sessionId: string, terminalId: string, key: string }} binding - the released attachment.
       */
      function restoreUserKeyboard(binding) {
        try {
          const views = webTerminals === null || webTerminals === undefined ? undefined : webTerminals.views
          if (!(views instanceof Map)) return
          const perSession = views.get(String(binding.sessionId))
          if (!(perSession instanceof Map)) return
          for (const [key, view] of perSession) {
            if (String(key) === String(binding.key)) continue
            if (view === null || view === undefined) continue
            if (String(view.id ?? '') !== String(binding.terminalId)) continue
            try {
              if (typeof view.connect === 'function') view.connect()
            } catch (error) {
              report('reconnecting the user terminal failed', error)
            }
          }
        } catch (error) {
          report('restoring the terminal keyboard failed', error)
        }
      }

      async function attachView(command) {
        const attachmentId = asText(command.attachmentId)
        const sessionId = asText(command.sessionId)
        const terminalId = asText(command.terminalId)
        if (attachmentId === '' || sessionId === '' || terminalId === '') {
          fail(command, 'the attach command is missing its terminal')
          return
        }
        // The host may have opened this terminal a moment ago (the tool opens one when the
        // session has none), and `ClientTerminals` keeps the session's terminal LIST in a shared
        // cache: a terminal that appeared after that cache was filled is invisible to `view()`,
        // which then fails as `missingTerminal` even though the terminal exists. `recover` is the
        // public read that forces the cache to refresh ("list the terminals I could still open");
        // its value is not used here, only the side effect. One remote list per attach, and a
        // failure costs nothing — the view below reports the real problem.
        try {
          if (typeof webTerminals.recover === 'function') {
            await webTerminals.recover(sessionId, true)
          }
        } catch (error) {
          report('refreshing the browser terminal list failed', error)
        }
        // A fresh key per attachment keeps the view lifecycles apart; a stable content
        // identity per terminal keeps the service's saved bindings — one `localStorage` key per
        // (session, contentId), removed only by `close()` — from growing per tool call.
        //
        // KNOWN RESIDUAL (deliberately not fixed here): `ClientTerminals.views` is keyed by the
        // per-attachment key and only `close()` drops an entry, which this half must never call
        // (it would kill the user's terminal). So the page's service keeps one small, dead
        // `TerminalView` per attachment. Reusing one view per terminal would need a single
        // stable key plus `mount()`'s detach callback instead of `dispose()` — that is a
        // lifecycle change (a reused view joins a later attachment, and two concurrent
        // attachments would share one view) which the bridge contract deliberately forbids.
        // Upstream change to ask DSH for: `webTerminals.release(sessionId, key)` that disposes
        // AND removes the map entry; that is the only complete fix that keeps `close()` off
        // the user's terminal.
        const key = BRIDGE_KEY_PREFIX + attachmentId
        const contentId = BRIDGE_CONTENT_PREFIX + terminalId
        let view
        try {
          view = webTerminals.view(sessionId, key, contentId, terminalId)
        } catch (error) {
          fail(command, 'the browser terminal could not open: ' + messageOf(error))
          return
        }
        if (view === null || view === undefined) {
          fail(command, 'the browser terminal service returned no view')
          return
        }
        const binding = {
          attachmentId,
          view,
          sessionId,
          terminalId,
          key,
          disposed: false,
          /** Whether the Host has been sent this attachment's first screen. */
          sawSnapshot: false,
          reportedPhase: undefined,
          lastRevision: 0,
          lastWritable: undefined,
          lastInfo: undefined,
          unsubscribe: undefined,
          timer: undefined,
        }
        bindings.set(attachmentId, binding)
        try {
          watch(binding)
          view.mount()
        } catch (error) {
          bindings.delete(attachmentId)
          binding.disposed = true
          unwatch(binding)
          restoreUserKeyboard(binding)
          fail(command, 'mounting the browser terminal failed: ' + messageOf(error))
          return
        }
        // `view()` may already carry a snapshot; read it once so an early frame is not lost
        // between the subscription and the first store change.
        try {
          observe(binding)
        } catch (error) {
          report('reading the terminal view failed', error)
        }
        succeed(command)
      }

      function writeView(command) {
        const binding = bindings.get(asText(command.attachmentId))
        if (binding === undefined || binding.disposed) {
          fail(command, 'this terminal is not attached in this window')
          return
        }
        const state = readViewState(binding)
        if (state === undefined || state.writable !== true) {
          fail(command, 'the terminal is read-only (the user took keyboard control)')
          return
        }
        try {
          if (typeof binding.view.write !== 'function') {
            fail(command, 'the browser terminal cannot take input')
            return
          }
          binding.view.write(asText(command.data))
        } catch (error) {
          fail(command, 'writing to the terminal failed: ' + messageOf(error))
          return
        }
        succeed(command)
      }

      async function detachView(command) {
        const attachmentId = asText(command.attachmentId)
        const binding = bindings.get(attachmentId)
        if (binding === undefined) {
          // Already gone (page reloaded mid-command): the Host only asks for the release.
          succeed(command)
          return
        }
        binding.disposed = true
        bindings.delete(attachmentId)
        unwatch(binding)
        try {
          // `dispose`, never `close`: the terminal belongs to the user; the bridge only
          // borrowed its screen and keyboard.
          if (typeof binding.view.dispose === 'function') await binding.view.dispose()
        } catch (error) {
          report('releasing the browser terminal view failed', error)
        }
        // The borrowed keyboard goes back to the user's own view immediately; without this the
        // sidebar tab stays read-only after every read (Ctrl+C and typing would be swallowed
        // until 接管输入 is clicked — the exact complaint that led here).
        restoreUserKeyboard(binding)
        succeed(command)
      }

      /**
       * Report the terminals this page holds for a session.
       *
       * The page's per-session inventory is what the user actually sees: a terminal it created
       * stays in the map even if the host controller's ownership table lost track of it (measured
       * after a plugin recomposition: the sidebar terminal was alive and usable, while the host
       * listed nothing). Read-only: no view is mounted and no keyboard is borrowed.
       */
      async function reportInventory(command) {
        const sessionId = asText(command.sessionId)
        const commandId = asText(command.id)
        // An older page half (or a build without the client terminal service) cannot answer:
        // say so explicitly, so the host falls back to its controller list instead of treating
        // "I don't know" as "there are none".
        if (typeof webTerminals.inventory !== 'function') {
          pushEvent({ type: 'inventory', commandId, supported: false, terminals: [] })
          return
        }
        const collected = []
        try {
          const inventory = webTerminals.inventory(sessionId)
          if (inventory !== null && inventory !== undefined) {
            const items = inventory.items
            const read = () => (items instanceof Map ? [...items.values()] : (Array.isArray(items) ? items : []))
            if (read().length === 0 && typeof inventory.read === 'function') {
              try {
                // `read(refresh)`: the argument is the refresh flag, not an abort signal. A
                // cached-empty list must be refetched before "there are none" is reported.
                await inventory.read(true)
              } catch {
                // The host list may be stale or the session cold; the map is still what it is.
              }
            }
            collected.push(...read())
          }
        } catch (error) {
          report('reading the browser terminal inventory failed', error)
        }
        const terminals = []
        for (const info of collected) {
          if (info === null || typeof info !== 'object') continue
          const id = asText(info.id)
          if (id === '') continue
          terminals.push({
            id,
            title: typeof info.title === 'string' ? info.title : null,
            shell: info.shell !== null && typeof info.shell === 'object'
              ? { name: typeof info.shell.name === 'string' ? info.shell.name : null, path: typeof info.shell.path === 'string' ? info.shell.path : null, args: Array.isArray(info.shell.args) ? info.shell.args : [] }
              : null,
            cwd: typeof info.cwd === 'string' ? info.cwd : null,
            cols: typeof info.cols === 'number' ? info.cols : null,
            rows: typeof info.rows === 'number' ? info.rows : null,
            state: typeof info.state === 'string' ? info.state : null,
            exitCode: typeof info.exitCode === 'number' ? info.exitCode : null,
          })
        }
        pushEvent({ type: 'inventory', commandId: asText(command.id), terminals })
      }

      async function runCommand(command) {
        try {
          if (command === null || command === undefined || typeof command !== 'object') return
          const kind = command.kind
          if (kind === 'attach') {
            await attachView(command)
            return
          }
          if (kind === 'write') {
            writeView(command)
            return
          }
          if (kind === 'detach') {
            await detachView(command)
            return
          }
          if (kind === 'inventory') {
            await reportInventory(command)
            return
          }
          fail(command, 'unknown bridge command "' + asText(kind) + '"')
        } catch (error) {
          report('running a terminal bridge command failed', error)
          fail(command, 'the browser could not run this command')
        }
      }

      /**
       * Run one command with a deadline.
       *
       * A terminal service call can hang (a list read that never settles, a dispose on a
       * dying connection). The poll loop awaits commands one at a time and is also the
       * heartbeat the Host uses to decide the page is alive, so one hang would stop every
       * later command and make the Host declare this window gone. Failing the command after
       * `BRIDGE_COMMAND_TIMEOUT_MS` keeps the loop moving; a late settle is harmless because
       * the Host has already given up on that command id.
       */
      function runCommandWithDeadline(command) {
        if (typeof setTimeout !== 'function') return runCommand(command)
        return new Promise((resolve) => {
          let settled = false
          let timer
          const finish = () => {
            if (settled) return
            settled = true
            if (timer !== undefined) {
              clearTimeout(timer)
              commandTimers.delete(timer)
            }
            resolve()
          }
          timer = setTimeout(() => {
            commandTimers.delete(timer)
            if (stopped) {
              finish()
              return
            }
            fail(command, 'the browser could not run this command in time')
            finish()
          }, BRIDGE_COMMAND_TIMEOUT_MS)
          commandTimers.add(timer)
          Promise.resolve(runCommand(command)).then(finish, finish)
        })
      }

      // --------------------------------------------------------------- polling

      async function pollOnce() {
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        pollController = controller
        try {
          const response = await fetcher(BRIDGE_POLL_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId, attachments: [...bindings.keys()] }),
            signal: controller === undefined ? undefined : controller.signal,
          })
          if (response === null || response === undefined) return undefined
          // 404 is final: this Host has no bridge routes, so retrying is just a slow loop.
          if (response.status === 404) return 'stop'
          if (response.ok !== true) return undefined
          const payload = await response.json()
          return payload !== null && typeof payload === 'object' ? payload : undefined
        } catch (error) {
          return undefined
        } finally {
          if (pollController === controller) pollController = undefined
        }
      }

      function sleep(ms) {
        return new Promise((resolve) => {
          if (typeof setTimeout !== 'function') {
            resolve()
            return
          }
          sleepTimer = setTimeout(() => {
            sleepTimer = undefined
            resolve()
          }, ms)
        })
      }

      async function pollLoop(generationId) {
        while (!stopped && generationId === generation) {
          const answer = await pollOnce()
          if (stopped || generationId !== generation) return
          if (answer === 'stop') {
            // This Host has no bridge routes (an older build). Park the worker properly
            // instead of leaving `started` true with no loop behind it.
            stop()
            return
          }
          if (answer === undefined) {
            await sleep(BRIDGE_RETRY_MS)
            continue
          }
          const commands = Array.isArray(answer.commands) ? answer.commands : []
          for (const command of commands) {
            if (stopped || generationId !== generation) return
            await runCommandWithDeadline(command)
          }
        }
      }

      // -------------------------------------------------------------- lifetime

      function start() {
        if (started) return
        started = true
        stopped = false
        // A restart bumps the generation so a loop from a previous start can never keep
        // polling beside the new one (the old loop checks this before every step).
        generation += 1
        const generationId = generation
        if (typeof window === 'object' && window !== null && typeof window.addEventListener === 'function') {
          try {
            window.addEventListener('pagehide', stop)
            pagehideHooked = true
          } catch (error) {
            report('listening for page unload failed', error)
          }
        }
        void pollLoop(generationId)
      }

      function stop() {
        if (!started) return
        started = false
        stopped = true
        if (pollController !== undefined && typeof pollController.abort === 'function') {
          try {
            pollController.abort()
          } catch (error) {
            report('aborting the terminal bridge request failed', error)
          }
        }
        pollController = undefined
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer)
          flushTimer = undefined
        }
        if (sleepTimer !== undefined) {
          clearTimeout(sleepTimer)
          sleepTimer = undefined
        }
        // A command still running at stop time must not leave its deadline behind: the page
        // may live on (a plugin reload), and a timer that fires into a parked worker is noise.
        for (const timer of Array.from(commandTimers)) clearTimeout(timer)
        commandTimers.clear()
        if (pagehideHooked && typeof window === 'object' && window !== null
          && typeof window.removeEventListener === 'function') {
          try {
            window.removeEventListener('pagehide', stop)
          } catch (error) {
            report('removing the unload listener failed', error)
          }
          pagehideHooked = false
        }
        // Best effort on unload: keepalive keeps one small request alive past the page's
        // death. The browser caps keepalive bodies (64 KB, shared quota), so this is a single
        // batch — priority events first, then whatever frames fit — and the rest is dropped
        // with one log line instead of a burst of doomed requests.
        if (events.length > 0) {
          const queue = events
          events = []
          const batch = planBridgeUnloadBatch(queue, BRIDGE_UNLOAD_BATCH_BYTES)
          if (batch.events.length > 0) void postEvents(batch.events, true)
          if (batch.dropped > 0) report('the terminal bridge dropped ' + String(batch.dropped) + ' events on unload')
        }
        // Release every view this worker holds. The worker's own map is emptied here; the
        // client terminal service keeps its (now disposed) view entries — see the KNOWN
        // RESIDUAL note in `attachView`, which is why `contentId` is stable per terminal.
        for (const binding of Array.from(bindings.values())) {
          binding.disposed = true
          unwatch(binding)
          try {
            const result = typeof binding.view.dispose === 'function' ? binding.view.dispose() : undefined
            if (result !== null && result !== undefined && typeof result.catch === 'function') result.catch(() => {})
          } catch (error) {
            report('releasing a browser terminal view failed', error)
          }
          restoreUserKeyboard(binding)
        }
        bindings.clear()
      }

      return { start, stop }
    }

    // ------------------------------------------------------------------ apply

    /**
     * Mount the rail entry and the panel.
     *
     * This function must never throw: a client half that fails to apply takes its
     * whole bundle's surface down with it, and the WSL tools work fine without any
     * of this. So a missing `slots` service, a missing `configForms`, an unserved
     * configuration row and a scope that refuses to be read all degrade into a note
     * in the panel instead of an exception.
     */
    function apply(ctx) {
      const model = createConfigModel()

      // `configForms` is reached through `ctx.inject`, never through this module's
      // own `inject` array: the panel is a convenience, not a reason to refuse to
      // mount on a composition that does not ship the settings service.
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['configForms'], (inner) => {
            const configForms = inner.configForms
            if (configForms === undefined || configForms === null) return
            // The service is here; whether it lists our namespace is a separate
            // question that `whileServed` answers below.
            model.noteService()
            /**
             * Take the form once the Host actually lists the namespace.
             *
             * A form fetched before the `describe()` round trip settles is born
             * with its persistence already fixed to "not host" and never upgrades
             * — it stays `unavailable` forever. That is exactly how this panel
             * lost every switch while the tools kept working, so the namespace is
             * awaited through the platform's own gate instead of being requested
             * eagerly. The shipped settings pages use this same call.
             */
            const attachWhenServed = () => {
              if (typeof configForms.whileServed !== 'function') {
                // Older host face: no gate to wait on, so take whatever it gives
                // and let the model report `unavailable` honestly.
                attach(configForms.get(CONFIG_ROW_ID))
                return () => model.detach()
              }
              return configForms.whileServed([CONFIG_ROW_ID], () => {
                attach(configForms.get(CONFIG_ROW_ID))
                return () => model.detach()
              })
            }
            const attach = (scope) => {
              try {
                model.attach(scope)
              } catch (error) {
                console.error('dsh-wsl-tool: reading the "' + CONFIG_ROW_ID + '" configuration scope failed', error)
              }
            }
            let stop
            try {
              stop = attachWhenServed()
            } catch (error) {
              console.error('dsh-wsl-tool: this DSH serves no "' + CONFIG_ROW_ID + '" configuration row', error)
              return
            }
            // The subscription lives exactly as long as this fiber: `effect` runs
            // the returned disposer on unload or recomposition.
            if (typeof inner.effect === 'function') {
              inner.effect(() => stop, 'dsh-wsl-tool: configuration scope')
            }
          })
        }
      } catch (error) {
        console.error('dsh-wsl-tool: asking for the configuration service failed', error)
      }

      try {
        if (ctx.slots === undefined || ctx.slots === null) {
          console.error('dsh-wsl-tool: this DSH has no slots service; the WSL panel stays unmounted')
          return
        }
        // Both seats are registered from the innermost callback, exactly as the
        // shipped panels do: the rail entry and the panel it opens appear together
        // or not at all. The callback's return value is the disposer chain.
        ctx.slots.inject('main', () =>
          ctx.slots.inject('sidebar.panellist', () => {
            const stopMain = ctx.slots.register(
              { name: 'main', key: PANEL_ID, inject: () => ({ model }) },
              WslPanel,
            )
            const stopIcon = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: () => 'WSL' },
              WslIcon,
            )
            return () => {
              if (typeof stopIcon === 'function') stopIcon()
              if (typeof stopMain === 'function') stopMain()
            }
          }),
        )
      } catch (error) {
        console.error('dsh-wsl-tool: registering the WSL panel failed', error)
      }

      try {
        // The terminal-subtask row above the composer: the same seats mechanism as the panel,
        // in the dock the shipped Todo/Goal/Queue rows already occupy, ordered after them (30).
        // A Host without this slot simply shows nothing — this is a leaf of its own.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
          { name: 'conversation.input.dock', id: 'wsl-subtasks', order: 30 },
          WslSubtaskDock,
        ))
      } catch (error) {
        console.error('dsh-wsl-tool: registering the terminal-subtask dock failed', error)
      }

      try {
        // The browser half of the terminal bridge. Optional in every direction: a page
        // without the terminal service simply never polls, and the Host uses its own PTY.
        startTerminalBridge(ctx)
      } catch (error) {
        console.error('dsh-wsl-tool: the terminal bridge could not start', error)
      }
    }

    // `slots` is the one service this module needs before it can do anything.
    // `configForms` is optional and is asked for above, at runtime.
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
