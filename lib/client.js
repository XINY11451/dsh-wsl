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
    const CODE_LABEL = 'var(--dsw-alias-markdown-inline-code, inherit)'
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
     * `danger` - marks a switch whose off state widens what the model may run.
     */
    const SECTIONS = [
      {
        id: 'tools',
        title: '工具',
        rows: [
          {
            path: ['tools', 'wsl'],
            label: 'wsl 命令执行',
            hint: '注册 `wsl` 工具：让模型在 WSL 发行版里执行 Linux 命令（一次一个全新 shell）',
            when: true,
          },
          {
            path: ['tools', 'path'],
            label: 'wsl-path 路径转换',
            hint: '注册 `wsl-path` 工具：在 Windows 路径与 `/mnt/...` 之间互转',
            when: true,
          },
          {
            path: ['tools', 'env'],
            label: 'wsl-env 能力体检',
            hint: '注册 `wsl-env` 工具：汇总发行版、内核、systemd、cgroup、GPU 直通、docker、挂载盘与两侧配置',
            when: true,
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
            hint: '允许长任务用 `runInBackground` 后台执行，再由内置 job 工具读回结果',
            when: true,
          },
          {
            path: ['translatePaths'],
            label: '自动转换路径',
            hint: '命令里的 Windows 路径自动转成 `/mnt/...`（每次调用仍可用 `translatePaths` 覆盖）',
            when: true,
          },
          {
            path: ['startInSessionWorkspace'],
            label: '默认跟随会话工作区',
            hint: '未传 `workdir` 时从会话所在目录开始（关掉则从 Linux 家目录 `~` 开始）',
            when: false,
          },
          {
            path: ['dangerGuard'],
            label: '危险命令守卫',
            hint: '删除、分区、关机等命令必须显式 `allowDangerous` 才放行。关掉后模型可直接执行这类命令，请谨慎',
            when: true,
            danger: true,
          },
        ],
      },
    ]

    /**
     * The sidebar-terminal snippet, verbatim.
     *
     * It is a String.raw template AND its lines start at column 0 on purpose: it
     * must come out byte-for-byte as the YAML a user pastes into a profile patch,
     * backslashes in the Windows path included. Re-indenting it or writing it with
     * ordinary escapes would quietly corrupt the path.
     */
    const TERMINAL_PATCH_YAML = String.raw`- id: terminal-controller
  config:
    shell:
      path: 'C:\Windows\System32\wsl.exe'
      name: WSL
      args: ['-e', 'bash', '-l']`

    /** The submission guide shown beside the copy button.
     *
     * It lives in the panel because "where does this go" is the question a copied
     * block raises at exactly that moment; SUPPORT.md is the long form of the same
     * list, with the repository for each kind of problem.
     */
    const GUIDE = [
      '标题写清现象，例如「[Bug] 后台任务在带 systemd 的发行版里报无属主」；模板会自动加 [Bug] 前缀。',
      '正文写三段：发生了什么（贴原文）、你期望什么、怎么复现。',
      '「补充」栏直接粘上面复制的内容 —— 版本号、发行版、开关状态都在里面，不用手抄。',
      '提问或想法走 Discussions；DSH 本体、市场界面、收录目录的问题各有各的仓库（见 SUPPORT.md）。',
      '提交前把不想公开的路径、主机名、密钥删掉：Issue 是公开的。',
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
         *  configuration forms", which is a different (and wrong) diagnosis. */
        noteService: () => {
          served = true
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
    /** The submission guide beside the copy button: an ordered list, not prose. */
    const GUIDE_STYLE = {
      margin: 0,
      paddingLeft: '18px',
      color: LABEL_SECONDARY,
      fontSize: '12px',
      lineHeight: '18px',
      maxWidth: '72ch',
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
    }
    const DEFINITION_ROW_STYLE = { display: 'flex', alignItems: 'baseline', gap: '12px' }
    const DEFINITION_LABEL_STYLE = { color: LABEL_SECONDARY, minWidth: '13em' }
    const DEFINITION_VALUE_STYLE = { color: LABEL_PRIMARY }
    const PRE_STYLE = {
      margin: 0,
      padding: '12px',
      background: CODE_FILL,
      borderRadius: RADIUS,
      color: CODE_LABEL,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      lineHeight: '18px',
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

      React.useEffect(
        () =>
          model.subscribe(() => {
            setSnapshot(model.read())
          }),
        [model],
      )

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
            ),
            React.createElement('p', { style: HINT_STYLE }, row.hint),
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
                : {}),
              onChange: (next) => submit({ op: 'set', path: row.path, value: next === true }, key),
            }),
          ),
        )
      }

      const children = []

      children.push(
        React.createElement(
          'header',
          { key: 'header', style: HEADER_STYLE },
          React.createElement('h2', { style: TITLE_STYLE }, 'WSL'),
          React.createElement('p', { style: DESCRIPTION_STYLE }, '通过 WSL 在 Windows 上执行 Linux 命令的开关与说明'),
          React.createElement('p', { style: NOTE_STYLE }, '工具开关在下次启动 DSH 后生效；其余开关即时生效。'),
        ),
      )

      // The switches — or the one reason they cannot be shown right now.
      if (model.hasService() !== true) {
        children.push(
          React.createElement(
            'p',
            { key: 'note-service', style: NOTE_STYLE },
            '此 DSH 未提供配置表单服务（configForms），无法在这里调整设置。',
          ),
        )
      } else if (snapshot.status === 'loading') {
        children.push(React.createElement('p', { key: 'note-loading', style: NOTE_STYLE },
          '正在等待 Host 提供该插件的配置作用域（' + CONFIG_ROW_ID + '）…'))
      } else if (snapshot.status !== 'ready') {
        children.push(
          React.createElement('p', { key: 'note-unavailable', style: NOTE_STYLE }, '此 DSH 未提供该插件的配置作用域'),
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
            React.createElement('p', { key: 'note-refused', style: NOTE_STYLE }, '保存被拒绝：配置没有被写入，请重试'),
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
              '这两个值来自插件配置，可以在 profile 的 cordis.patch.yml 里写，也可以用环境变量 DSH_WSL_DISTRO / DSH_WSL_TIMEOUT_MS 覆盖。',
            ),
          ),
        )
      }

      // Opt-in, read-only: the snippet goes ABOVE its explanation, which refers to
      // it as 「上面这段」.
      children.push(
        section(
          'terminal',
          '侧边栏 WSL 终端（可选）',
          React.createElement(
            'p',
            { style: HINT_STYLE },
            '插件还可以把桌面端的侧边栏终端指向 WSL；这是可选项，默认不开。',
          ),
          React.createElement('pre', { style: PRE_STYLE }, TERMINAL_PATCH_YAML),
          React.createElement(
            'p',
            { style: HINT_STYLE },
            '把上面这段加进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 后重启 DSH，新建终端里就会出现 WSL（详见插件 README）',
          ),
        ),
      )

      // ------------------------------------------------------- feedback (one entry)
      //
      // One place, two ways out: the issue chooser for anyone who can reach GitHub,
      // and this plugin's own facts as text for anyone who cannot (measured on this
      // machine: github.com is not always reachable). The guide sits beside the
      // button, because "where does this go" is the question the copied block raises.
      // Nothing is sent by this plugin: the bytes leave only when the user pastes them.
      const FEEDBACK_URL = 'https://github.com/XINY11451/dsh-wsl/issues/new/choose'
      // Kept in step with index.js: the Host half publishes this exact path.
      const INFO_ROUTE = '/dsh-wsl-tool/info'

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
        const lines = ['### 插件信息（由插件自己读出，可直接粘贴）']
        if (info === undefined || info === null) {
          lines.push('- 版本：未能读取（见市场条目，或 `npm ls dsh-wsl-tool`）')
        } else {
          lines.push(`- 插件：${info.name} ${info.version ?? '（版本未知）'}`)
          if (typeof info.repository === 'string' && info.repository !== '') lines.push(`- 仓库：${info.repository}`)
          if (typeof info.node === 'string') lines.push(`- Node ${info.node}　平台 ${info.platform} ${info.arch}`)
        }
        lines.push('- DSH：')
        lines.push('- WSL 发行版与内核（`wsl -l -v`，或跑一次 wsl-env 工具）：')
        lines.push('')
        lines.push('### 面板里的开关')
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
        // Bounded: a route that is not there must not leave the button silent.
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        const timer = typeof setTimeout === 'function'
          ? setTimeout(() => {
            if (controller !== undefined) controller.abort()
          }, 1500)
          : undefined
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
          '意见反馈 / 提升建议',
          React.createElement('p', { style: HINT_STYLE },
            '「复制插件信息」由插件自己读出下面的内容并复制到剪贴板：版本、仓库、Node、以及你面板里的开关状态。插件不会自己发送任何东西 —— 由你粘、你提交。'),
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
              '打开反馈页（GitHub）',
            ),
            React.createElement(
              'button',
              { type: 'button', style: RESET_STYLE, onClick: copyInfo },
              feedbackCopy === 'ok' ? '已复制 ✓' : '复制插件信息',
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
              '（浏览器不允许自动复制：全选上面这段，粘到你想粘的地方即可）')
            : null,
        ),
      )

      return React.createElement('div', { style: PANEL_STYLE }, children)
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
    }

    // `slots` is the one service this module needs before it can do anything.
    // `configForms` is optional and is asked for above, at runtime.
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
