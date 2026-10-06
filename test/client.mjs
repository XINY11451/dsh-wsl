// Client-half checks: load `lib/client.js` the way DSH does — through the module
// loader, with a mocked `require` — and drive the panel it registers.
//
// The client half is hand-written (no build step), so nothing else proves it
// still parses, still asks for the services it needs, or still writes the
// configuration paths the Host half reads. `test/smoke.mjs` covers the Host;
// this file covers the surface a user actually clicks.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = resolve(root, 'lib/client.js')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- load it the way the loader does ---------------------------------------

const source = readFileSync(clientPath, 'utf8')
const silent = { error() {}, warn() {}, log() {} }

console.log('\nclient bundle shape')
check('it is a plain loader script, not an ES module', !/^\s*(?:import|export)\s/m.test(source))
check('it never asks for a service by bare global', !/\bself\./.test(source))
check('it hands the loader this package id', /id:\s*'dsh-wsl-tool'/.test(source))

const loaded = []
// What the feedback entry copies, recorded from the clipboard stub the panel uses.
const copiedTexts = []
const context = createContext({
  window: { __ModuleLoader__: { load: (mod) => loaded.push(mod) } },
  console: silent,
  navigator: {
    clipboard: {
      writeText: (text) => {
        copiedTexts.push(text)
        return Promise.resolve()
      },
    },
  },
})
// Timers: the panel arms two (a bounded wait for the settings scope, and an abort for the
// feedback read). Recording them lets a check fire one on demand instead of sleeping.
let timerSeq = 0
const timers = new Map()
context.setTimeout = (fn, ms) => {
  timerSeq += 1
  timers.set(timerSeq, { fn, ms })
  return timerSeq
}
context.clearTimeout = (id) => {
  timers.delete(id)
}
const fireTimers = (predicate) => {
  for (const [id, timer] of Array.from(timers)) {
    if (predicate !== undefined && !predicate(timer)) continue
    timers.delete(id)
    timer.fn()
  }
}
runInContext(source, context, { filename: clientPath })
eq('the loader received exactly one module', loaded.length, 1)
eq('the module id is the package name', loaded[0]?.id, 'dsh-wsl-tool')

// --- the module factory, with stubs for react and the primitives ------------

const elements = []
function element(type, props, ...children) {
  const node = { type, props: { ...(props ?? {}) } }
  if (children.length > 0) node.props.children = children.length === 1 ? children[0] : children
  elements.push(node)
  return node
}
const react = {
  createElement: element,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  Fragment: 'Fragment',
}
// One stable component per primitive name, tagged so the walk below can find a
// switch by the component it renders: the client passes the component itself as an
// element's `type`, and a Proxy that minted a fresh function per access would make
// every element a different type.
const primitiveCache = new Map()
const primitives = new Proxy({}, {
  get: (_target, key) => {
    if (!primitiveCache.has(key)) {
      const component = (props) => element(String(key), props)
      component.primitiveName = String(key)
      primitiveCache.set(key, component)
    }
    return primitiveCache.get(key)
  },
})
const mod = loaded[0].factory((name) => {
  if (name === 'react') return react
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${name}`)
})

console.log('\nclient module contract')
eq('it exports apply', typeof mod.apply, 'function')
eq('it injects only slots', JSON.stringify(mod.inject), '["slots"]')

// --- mount against a recording context --------------------------------------

const registered = []
const ops = []
const snapshot = {
  status: 'ready',
  value: { tools: { wsl: true, path: true, env: true }, backgroundJobs: true, translatePaths: true },
  base: {},
  user: { tools: { wsl: false }, dangerGuard: false }, // two overrides, so the single reset writes a real batch
  writable: true,
  revision: 7,
}
const scope = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: (batch, revision) => {
    ops.push({ batch, revision })
    return Promise.resolve(true)
  },
}
// The ORDER of these two calls is the point: a form fetched before the Host lists
// its namespace is born `unavailable` and never upgrades, which is how this panel
// lost every switch in the field. So the fake records the order.
const configFormsCalls = []
const configForms = {
  get: (namespace) => {
    configFormsCalls.push(`get:${namespace}`)
    return scope
  },
  whileServed: (namespaces, register) => {
    configFormsCalls.push(`whileServed:${namespaces.join(',')}`)
    const off = register(new Set(namespaces))
    return () => {
      if (typeof off === 'function') off()
    }
  },
}
const ctx = {
  slots: {
    inject: (_seat, callback) => callback(),
    register: (seat, component) => {
      registered.push({ seat, component })
      return () => {}
    },
  },
  inject: (deps, callback) => {
    callback({ configForms, effect: () => () => {} })
  },
}
let threw = null
try {
  mod.apply(ctx)
} catch (error) {
  threw = error
}
check('apply mounts without throwing', threw === null, String(threw))
eq('it waits for the Host to serve the namespace', configFormsCalls[0], 'whileServed:tool-wsl')
eq('the form is taken only once the namespace is served', configFormsCalls[1], 'get:tool-wsl')

console.log('\nslot registration')
const main = registered.find((r) => r.seat.name === 'main')
const rail = registered.find((r) => r.seat.name === 'sidebar.panellist')
check('it registers a main panel', main !== undefined)
check('it registers a sidebar entry', rail !== undefined)
eq('both seats share one key', main?.seat.key, rail?.seat.id)
eq('the rail entry is labelled', rail?.seat.label?.(), 'WSL')
check('the rail entry has a paint order', Number.isFinite(rail?.seat.order), String(rail?.seat.order))

// --- render the panel and drive its controls --------------------------------

console.log('\npanel rendering')
elements.length = 0
const injected = typeof main?.seat.inject === 'function' ? main.seat.inject() : {}
check('the seat injects the configuration model', typeof injected.model === 'object')
let tree = null
try {
  tree = main.component({ ...injected })
} catch (error) {
  check('the panel renders', false, String(error))
}
const walk = (node, visit) => {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node.type !== undefined) visit(node)
  walk(node.props?.children, visit)
}
const found = []
if (tree !== null) walk(tree, (node) => found.push(node))

/** Every node in a subtree, the root included. */
const collect = (node) => {
  const nodes = []
  walk(node, (child) => nodes.push(child))
  return nodes
}
/** A titled section, addressed by its heading rather than by document order: two
 *  sections now carry an input and a 保存, so order is no longer a safe selector. */
const sectionIn = (nodes, title) => nodes.find((node) => node.type === 'section'
  && Array.isArray(node.props?.children)
  && node.props.children[0] !== undefined
  && node.props.children[0].type === 'h3'
  && node.props.children[0].props?.children === title)
const switches = found.filter((node) => node.type?.primitiveName === 'Switch')
check('it renders one switch per switchable feature', switches.length === 7,
  `found ${switches.length}; rendered: ${found.map((node) => String(node.type?.primitiveName ?? node.type)).join(',')}`)
const labels = switches.map((node) => node.props?.label).filter((v) => typeof v === 'string')
for (const expected of [
  'wsl 命令执行', 'wsl-path 路径转换', 'wsl-env 能力体检', '后台任务',
  '自动转换路径', '默认跟随会话工作区', '危险命令守卫',
]) {
  check(`it labels the ${expected} row`, labels.includes(expected), labels.join(' | '))
}
// The explanation and the risky marker are siblings inside a row, not props of the
// switch itself, so look for the text the panel actually renders.
const texts = []
const collectText = (node) => {
  if (typeof node === 'string') {
    texts.push(node)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collectText(child)
    return
  }
  collectText(node.props?.children)
}
collectText(tree)
const rendered = texts.join('\n')
for (const mention of ['每次调用使用全新 shell', 'systemd', '内置 job 工具读取结果', 'translatePaths', 'workdir', '请谨慎']) {
  check(`it renders the explanation mentioning "${mention}"`, rendered.includes(mention))
}
check('the destructive-guard switch warns in its own tooltip',
  switches.some((node) => node.props?.label === '危险命令守卫' && /有风险/.test(String(node.props?.title))),
  JSON.stringify(switches.map((node) => node.props?.title)))
// The panel now OFFERS the sidebar terminal's startup directory (one field, one 保存),
// but it still must not print the patch RECIPE: pointing a terminal at WSL is the
// user's own opt-in to make in their patch layer, and this panel prints no YAML. The
// recipe lives in extras/terminal-wsl.patch.yml and the README.
check('the sidebar-terminal patch snippet is not rendered',
  !rendered.includes('- id: terminal-controller') && !rendered.includes('args:') && !rendered.includes('wsl.exe'))
check('the panel never names the other plugin\'s row id',
  !rendered.includes('terminal-controller'), rendered.slice(0, 200))
check('the feedback entry carries no explanation paragraph',
  !rendered.includes('由插件自己读出下面的内容'), rendered.slice(0, 200))

console.log('\nconfiguration writes')
const wslSwitch = switches.find((node) => node.props?.label === 'wsl 命令执行')
let writeThrew = null
try {
  await wslSwitch.props.onChange(false)
} catch (error) {
  writeThrew = error
}
check('toggling a switch does not throw', writeThrew === null, String(writeThrew))
const setOp = ops.find((entry) => entry.batch?.[0]?.op === 'set')
eq('a toggle writes the row path', JSON.stringify(setOp?.batch?.[0]?.path), '["tools","wsl"]')
eq('a toggle writes the requested value', setOp?.batch?.[0]?.value, false)
eq('the write is fenced by the snapshot revision', setOp?.revision, 7)
// Clearing overrides lives in ONE place, not on every row: the panel renders a
// single control that unsets every overridden path in one revision-fenced write.
const resetControls = found.filter((node) => node.props?.children === '全部恢复默认')
eq('the panel offers exactly one reset control', resetControls.length, 1)
eq('the reset wording is not repeated on the rows', (rendered.match(/恢复默认/g) ?? []).length, 1)
let resetSettled = null
try {
  resetSettled = await resetControls[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
} catch (error) {
  check('the reset control settles', false, String(error))
}
const unsetBatches = ops.filter((entry) => entry.batch?.some((op) => op.op === 'unset'))
eq('the reset sends one batch, not one write per row', unsetBatches.length, 1)
const unsetPaths = (unsetBatches[0]?.batch ?? [])
  .filter((op) => op.op === 'unset')
  .map((op) => op.path.join('.'))
  .sort()
eq('the batch covers every overridden path', unsetPaths.join(','), 'dangerGuard,tools.wsl')
eq('the reset is fenced by the snapshot revision', unsetBatches[0]?.revision, 7)
check('the reset reports success', resetSettled === true, String(resetSettled))

// The feedback entry: one place, a link to GitHub's issue chooser, and a locally
// assembled block for everyone who cannot reach GitHub — the plugin itself sends
// nothing, so the copied text is the whole contract.
// The workdir input: one place to set the fixed Linux directory, written through the
// same scope as the switches. Empty must clear the path rather than writing an empty
// string, which is what hands the decision back to the follow-session switch.
console.log('\nworkdir input')
const workdirSection = sectionIn(found, '默认 Linux 工作目录')
check('the panel offers a workdir section', workdirSection !== undefined)
const workdirInput = collect(workdirSection).find((node) => node.type === 'input')
check('the panel offers a workdir input', workdirInput !== undefined)
const saveWorkdir = collect(workdirSection).find((node) => node.props?.children === '保存')
check('it offers a save control', saveWorkdir !== undefined)
workdirInput.props.onChange({ target: { value: '/mnt/d/proj' } })
await saveWorkdir.props.onClick()
check('saving writes the configured directory',
  ops.some((entry) => entry.batch?.some((op) => op.op === 'set' && op.path.join('.') === 'workdir' && op.value === '/mnt/d/proj')),
  JSON.stringify(ops.slice(-2)))
workdirInput.props.onChange({ target: { value: '   ' } })
await saveWorkdir.props.onClick()
check('clearing it unsets the path instead of writing blanks',
  ops.some((entry) => entry.batch?.some((op) => op.op === 'unset' && op.path.join('.') === 'workdir')),
  JSON.stringify(ops.slice(-2)))

// The sidebar terminal's startup directory: the same shape as the workdir field —
// one input, one 保存 — but it is NOT written through the settings scope, because the
// terminal row belongs to another plugin and only the profile patch can override it.
// The static checks here cover what is rendered; the async flow (reading the current
// value, saving, failing) is driven through a stateful mount further down.
console.log('\nterminal startup path field')
const terminalSection = sectionIn(found, 'WSL 终端启动路径')
check('the panel offers a terminal startup-path section', terminalSection !== undefined)
const terminalNodes = collect(terminalSection)
const terminalInput = terminalNodes.find((node) => node.type === 'input')
const saveTerminal = terminalNodes.find((node) => typeof node.props?.children === 'string'
  && node.props.children.startsWith('保存'))
check('it has an input', terminalInput !== undefined)
check('it has a save control', saveTerminal !== undefined)
eq('the field is one input, not one per row', terminalNodes.filter((node) => node.type === 'input').length, 1)
eq('the save control is not repeated', terminalNodes.filter((node) => typeof node.props?.children === 'string'
  && node.props.children.startsWith('保存')).length, 1)
check('the input names the empty case as "no flag at all"',
  String(terminalInput?.props?.placeholder).includes('跟随会话工作区'), String(terminalInput?.props?.placeholder))
// An empty field means "not read yet" before the Host answers, and saving then would
// clear a `--cd` the user never asked to remove — so the SAVE waits. The input itself must
// stay editable: a field nobody can type into reads as a broken panel (measured live).
check('the field stays editable while the current value is read',
  terminalInput?.props?.disabled !== true, String(terminalInput?.props?.disabled))
eq('but saving waits for that read', saveTerminal?.props?.disabled, true)
check('and it says so', rendered.includes('正在读取当前启动路径…'), rendered.slice(-200))
// Both directory fields sit together at the top, before the switches — one control each
// is the point, so their order is part of the contract, not incidental.
check('the two directory fields are adjacent, above the switches',
  found.indexOf(terminalSection) < found.indexOf(workdirSection)
  && found.indexOf(workdirSection) < found.indexOf(sectionIn(found, '工具')),
  `${found.indexOf(terminalSection)} / ${found.indexOf(workdirSection)} / ${found.indexOf(sectionIn(found, '工具'))}`)

console.log('\nfeedback entry')
eq('the panel offers exactly one feedback entry',
  found.filter((node) => node.props?.children === '反馈与支持').length, 1)
const feedbackLinks = found.filter((node) => node.type === 'a' && typeof node.props?.href === 'string')
eq('it links to the issue chooser', feedbackLinks.map((node) => node.props.href).join(','),
  'https://github.com/XINY11451/dsh-wsl/issues/new/choose')
eq('the link opens outside the app', feedbackLinks[0]?.props.target, '_blank')
const copyButton = found.find((node) => node.props?.children === '复制插件信息')
check('it offers a copy control', copyButton !== undefined)
// The submission guide sits beside the button, inside the panel, because that is
// where the question "where does this go" is asked.
const guideItems = found.filter((node) => node.type === 'li' && typeof node.props?.children === 'string')
for (const [name, needle] of [
  ['a title convention', '标题写明现象'],
  ['the three body parts', '正文包含三段'],
  ['where to paste the copied block', '「补充」栏粘贴上面复制的内容'],
  ['the routing to other repositories', 'SUPPORT.md'],
  ['the public-issue warning', 'Issue 是公开的'],
]) {
  check(`the guide mentions ${name}`, guideItems.some((node) => node.props.children.includes(needle)))
}
let copyThrew = null
try {
  await copyButton.props.onClick()
} catch (error) {
  copyThrew = error
}
check('copying does not throw', copyThrew === null, String(copyThrew))
eq('the clipboard received exactly one block', copiedTexts.length, 1)
const feedbackBlock = copiedTexts[0] ?? ''
for (const [name, needle] of [
  ['the self-info header', '### 插件信息（插件自动读取，可直接粘贴）'],
  ['an honest note when the version is unreadable', '版本：未能读取'],
  ['the panel switch states', '### 面板开关状态'],
  ['the guard row as rendered', '- 危险命令守卫：开'],
  ['the workdir row as rendered', '- 默认跟随会话工作区：开'],
  ['a line for the DSH version', '- DSH：'],
]) {
  check(`the copied block contains ${name}`, feedbackBlock.includes(needle), feedbackBlock.slice(0, 120))
}
// No clipboard API: the same control must degrade, not throw.
context.navigator = undefined
let manualThrew = null
try {
  await copyButton.props.onClick()
} catch (error) {
  manualThrew = error
}
check('a browser without a clipboard API still does not throw', manualThrew === null, String(manualThrew))
eq('nothing else was copied in that case', copiedTexts.length, 1)
// With the Host half answering, the block carries the plugin's own facts — this is
// what "the plugin reads its own information" means in practice.
context.navigator = {
  clipboard: {
    writeText: (text) => {
      copiedTexts.push(text)
      return Promise.resolve()
    },
  },
}
const askedUrls = []
context.fetch = (url) => {
  askedUrls.push(String(url))
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      name: 'dsh-wsl-tool',
      version: '9.9.9',
      repository: 'https://github.com/XINY11451/dsh-wsl.git',
      node: 'v24.0.0',
      platform: 'win32',
      arch: 'x64',
      dsh: { name: '@deepseek-ai/dsh-desktop', version: '0.2.0-rc.2' },
      wsl: {
        defaultDistro: 'Ubuntu-22.04',
        kernel: 'Linux 6.6.87.2-microsoft-standard-WSL2 x86_64',
        capabilities: ['systemd ✓', 'docker ✗'],
      },
      config: { tools: { wsl: true }, distro: 'Ubuntu-22.04', commandTimeoutMs: 600000 },
    }),
  })
}
try {
  await copyButton.props.onClick()
} catch (error) {
  check('the copy control survives the Host answer', false, String(error))
}
eq('it asks the Host half on the documented route', askedUrls.join(','), '/dsh-wsl-tool/info')
eq('the clipboard received the second block', copiedTexts.length, 2)
const hostBlock = copiedTexts[1] ?? ''
for (const [name, needle] of [
  ['the version read from the manifest', 'dsh-wsl-tool 9.9.9'],
  ['the repository', 'https://github.com/XINY11451/dsh-wsl.git'],
  ['the runtime', 'Node v24.0.0'],
  ['the DSH build the plugin runs inside', '- DSH：0.2.0-rc.2（@deepseek-ai/dsh-desktop）'],
  ['the default distribution', 'Ubuntu-22.04（默认发行版）'],
  ['the kernel', '内核 Linux 6.6.87.2-microsoft-standard-WSL2 x86_64'],
  ['the capability flags', 'WSL 能力：systemd ✓　docker ✗'],
  ['the effective distro', 'Ubuntu-22.04'],
  ['the effective timeout', '- 命令超时 timeoutMs：600000 毫秒'],
]) {
  check(`the Host answer puts ${name} in the block`, hostBlock.includes(needle), hostBlock.slice(0, 200))
}
check('a readable block never claims anything is unreadable',
  !hostBlock.includes('未能读取'), hostBlock.slice(0, 200))

console.log('\ndegradation')
for (const [name, broken] of [
  ['a context with no slots service', {}],
  ['a context with no configForms', { slots: ctx.slots, inject: undefined }],
  ['a context whose configuration row is not served', {
    slots: ctx.slots,
    inject: (_deps, callback) => callback({
      configForms: { get: () => { throw new Error('no such row') } },
      effect: () => () => {},
    }),
  }],
  ['a configForms face without whileServed', {
    slots: ctx.slots,
    inject: (_deps, callback) => callback({
      configForms: { get: () => scope },
      effect: () => () => {},
    }),
  }],
  ['a namespace that never becomes served', {
    slots: ctx.slots,
    inject: (_deps, callback) => callback({
      configForms: { get: () => scope, whileServed: () => () => {} },
      effect: () => () => {},
    }),
  }],
]) {
  let error = null
  try {
    mod.apply(broken)
  } catch (caught) {
    error = caught
  }
  check(`apply survives ${name}`, error === null, String(error))
}

// A namespace the Host has not listed YET must read as "waiting", never as "this
// DSH does not provide it": the shipped panel said the latter while the Host was
// already serving the namespace, which sent the first diagnosis the wrong way.
console.log('\npending reads as waiting, not as absent')
const pendingRegistered = []
const pendingCtx = {
  slots: {
    inject: (_seat, callback) => callback(),
    register: (seat, component) => {
      pendingRegistered.push({ seat, component })
      return () => {}
    },
  },
  inject: (_deps, callback) => callback({
    configForms: { get: () => scope, whileServed: () => () => {} },
    effect: () => () => {},
  }),
}
mod.apply(pendingCtx)
const pendingMain = pendingRegistered.find((r) => r.seat.name === 'main')
const pendingProps = typeof pendingMain?.seat.inject === 'function' ? pendingMain.seat.inject() : {}
let pendingTree = null
try {
  pendingTree = pendingMain.component({ ...pendingProps })
} catch (error) {
  check('the pending panel renders', false, String(error))
}
const pendingTexts = []
const collectPending = (node) => {
  if (typeof node === 'string') {
    pendingTexts.push(node)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collectPending(child)
    return
  }
  collectPending(node.props?.children)
}
collectPending(pendingTree)
const pendingText = pendingTexts.join('\n')
check('a not-yet-served namespace says it is waiting', /正在等待 Host/.test(pendingText), pendingText.slice(0, 120))
check('it does not claim the DSH has no such scope', !/未提供该插件的配置作用域/.test(pendingText))
check('the waiting note names the row being waited for', pendingText.includes('tool-wsl'))

// --- the terminal startup path, driven through a stateful mount -------------
//
// The recording stubs above cannot re-render, and the interesting behaviour here
// happens AFTER an async answer: the current value is filled in, a save reports its
// outcome, a failed save has to say so. This tiny mount keeps the panel's own state and
// renders again on every setState — just enough to read what the panel shows once a
// round trip has settled. Only the two state hooks are swapped, and only while mounted.
function mountStateful(component, props) {
  const cells = []
  const scheduled = []
  const deps = []
  const cleanups = []
  let cursor = 0
  let tree = null
  let live = true
  const previous = { useState: react.useState, useEffect: react.useEffect }
  const render = () => {
    cursor = 0
    tree = component(props)
    return tree
  }
  react.useState = (initial) => {
    const slot = cursor
    cursor += 1
    if (!(slot in cells)) cells[slot] = typeof initial === 'function' ? initial() : initial
    return [cells[slot], (next) => {
      if (!live) return
      cells[slot] = typeof next === 'function' ? next(cells[slot]) : next
      render()
    }]
  }
  react.useEffect = (fn, list) => {
    const slot = cursor
    cursor += 1
    const before = deps[slot]
    const again = list === undefined || !Array.isArray(before)
      || before.length !== list.length
      || list.some((value, index) => !Object.is(value, before[index]))
    if (again) {
      deps[slot] = list
      scheduled.push({ slot, fn })
    }
  }
  // Run pending effects and let their promises settle, repeatedly: an effect that sets
  // state renders again, and that render may schedule another effect.
  const flush = async () => {
    for (let round = 0; round < 20 && scheduled.length > 0; round += 1) {
      while (scheduled.length > 0) {
        const job = scheduled.shift()
        const cleanup = job.fn()
        if (typeof cleanup === 'function') cleanups[job.slot] = cleanup
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  render()
  return {
    tree: () => tree,
    flush,
    unmount: () => {
      live = false
      for (const cleanup of cleanups) {
        try {
          if (typeof cleanup === 'function') cleanup()
        } catch {}
      }
      react.useState = previous.useState
      react.useEffect = previous.useEffect
    },
  }
}

/** The text a subtree renders, joined — the panel's own "what does it say". */
const textOf = (node) => {
  const out = []
  const gather = (current) => {
    if (typeof current === 'string') {
      out.push(current)
      return
    }
    if (current === null || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) gather(child)
      return
    }
    gather(current.props?.children)
  }
  gather(node)
  return out.join('\n')
}

/** The terminal startup field of whatever tree is current: its input and its 保存. */
const fieldIn = (root) => {
  const area = sectionIn(collect(root), 'WSL 终端启动路径')
  const inner = area === undefined ? [] : collect(area)
  return {
    input: inner.find((node) => node.type === 'input'),
    save: inner.find((node) => typeof node.props?.children === 'string'
      && node.props.children.startsWith('保存')),
  }
}

console.log('\nterminal startup path: the async flow')
const requested = []
let getAnswer = { path: '/mnt/d/current', available: true, error: null }
let postAnswer = { ok: true, path: '/mnt/d/next', error: null }
context.fetch = (url, options) => {
  const method = options !== undefined && options.method !== undefined ? options.method : 'GET'
  requested.push({ url: String(url), method, body: options?.body, headers: options?.headers })
  const answer = method === 'POST' ? postAnswer : getAnswer
  if (answer === 'reject') return Promise.reject(new Error('offline'))
  return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
}
const panelProps = typeof main?.seat.inject === 'function' ? main.seat.inject() : {}
const terminalCalls = () => requested.filter((entry) => entry.url === '/dsh-wsl-tool/terminal-cwd')
// Every settings-scope write so far; a terminal save must not add to this list.
const settingsWritesBefore = ops.length

// (1) Mount: the current value comes from the Host and opens in the field.
const mounted = mountStateful(main.component, { ...panelProps })
check('the stateful panel renders', mounted.tree() !== null)
await mounted.flush()
eq('it asks the Host once for the current startup path', terminalCalls().length, 1)
eq('and it asks with GET', terminalCalls()[0]?.method, 'GET')
const filled = fieldIn(mounted.tree())
eq('the field shows the current value', filled.input?.props?.value, '/mnt/d/current')

// (2) A save POSTs the typed directory, and the panel says a restart is needed.
filled.input.props.onChange({ target: { value: '/mnt/d/next' } })
const edited = fieldIn(mounted.tree())
eq('the field is controlled: typing shows the typed value', edited.input?.props?.value, '/mnt/d/next')
postAnswer = { ok: true, path: '/mnt/d/next', error: null }
const savedTerminal = await edited.save.props.onClick()
check('the save settles as successful', savedTerminal === true, String(savedTerminal))
const posted = terminalCalls().filter((entry) => entry.method === 'POST').pop()
eq('the save POSTs to the Host route', posted?.url, '/dsh-wsl-tool/terminal-cwd')
eq('the save sends the typed directory', JSON.parse(posted?.body).path, '/mnt/d/next')
// The Host route refuses anything but JSON (that is its cross-site gate), so the panel
// sending this exact content type is part of the contract, not an incidental header.
check('the save asks for JSON', /application\/json/.test(String(posted?.headers?.['content-type'])),
  JSON.stringify(posted?.headers))
const savedText = textOf(mounted.tree())
check('the panel says the change needs a restart', savedText.includes('重启 DSH 后生效'), savedText.slice(-200))
// The value lives in the profile patch, so the settings scope must NOT have been written
// to: a save that went through `configForms` would write a config field that no Host half
// reads, and the panel would look like it worked while nothing changed.
eq('the terminal save writes the patch, not the settings scope', ops.length, settingsWritesBefore)

// (3) A refused save shows the Host's reason instead of pretending it worked.
const retry = fieldIn(mounted.tree())
retry.input.props.onChange({ target: { value: '/mnt/d/nowhere' } })
postAnswer = { ok: false, path: '', error: '这个 profile 的 patch 里没有指向 WSL 的侧边栏终端，没有可改的行' }
const refusedTerminal = await fieldIn(mounted.tree()).save.props.onClick()
check('a refused save settles as failed', refusedTerminal === false, String(refusedTerminal))
const refusedText = textOf(mounted.tree())
check('the panel shows why the save failed',
  refusedText.includes('保存失败') && refusedText.includes('没有可改的行'), refusedText.slice(-240))
mounted.unmount()

// (4) A profile without the terminal row: the panel points at the opt-in instead of
// offering a save that the Host would refuse for a reason the user cannot act on.
getAnswer = { path: '', available: false, error: null }
const missingRow = mountStateful(main.component, { ...panelProps })
await missingRow.flush()
check('a profile without the terminal row points at the opt-in',
  textOf(missingRow.tree()).includes('还没有 WSL 终端那一项'), textOf(missingRow.tree()).slice(-240))
eq('and saving is withheld until that opt-in exists', fieldIn(missingRow.tree()).save?.props?.disabled, true)
check('while the field itself stays editable',
  fieldIn(missingRow.tree()).input?.props?.disabled !== true,
  String(fieldIn(missingRow.tree()).input?.props?.disabled))
missingRow.unmount()

// (4b) The Host answered `available: false` WITH a reason — the exact payload a host that
// cannot name its patch file produces. That is a read failure, not a missing opt-in, and
// the panel must not send the reader after the recipe; the field stays typeable either way.
getAnswer = { path: '', available: false, error: '宿主既没有 profileContext.patchPath 也没有 DSH_PROFILE_DIR，读不到 profile 的 patch 文件' }
const unresolved = mountStateful(main.component, { ...panelProps })
await unresolved.flush()
const unresolvedText = textOf(unresolved.tree())
check('a host that cannot name the patch file reports that reason',
  unresolvedText.includes('读取失败') && unresolvedText.includes('profileContext'),
  unresolvedText.slice(-260))
check('and it is not dressed up as a missing opt-in',
  !unresolvedText.includes('还没有 WSL 终端那一项'), unresolvedText.slice(-260))
check('the field is still typeable in that state',
  fieldIn(unresolved.tree()).input?.props?.disabled !== true,
  String(fieldIn(unresolved.tree()).input?.props?.disabled))
unresolved.unmount()

// (7) A Host that never lists the namespace at all — the state a fresh profile lands in
// when `@deepseek-ai/schemastery` is absent, which is an OPTIONAL peer and so may not be
// installed. The wait is bounded, and past it the panel names the cause instead of
// spinning: the tools and this terminal field do not depend on that schema.
const unservedRegistered = []
mod.apply({
  slots: {
    inject: (_seat, callback) => callback(),
    register: (seat, component) => {
      unservedRegistered.push({ seat, component })
      return () => {}
    },
  },
  inject: (_deps, callback) => callback({
    configForms: { get: () => scope, whileServed: () => () => {} },
    effect: () => () => {},
  }),
})
const unservedMain = unservedRegistered.find((row) => row.seat.name === 'main')
const unserved = mountStateful(unservedMain.component, { ...(unservedMain.seat.inject()) })
await unserved.flush()
check('an entry the Host never serves first reports that it is waiting',
  textOf(unserved.tree()).includes('正在等待 Host'), textOf(unserved.tree()).slice(-200))
fireTimers((timer) => timer.ms >= 5000)
const expiredText = textOf(unserved.tree())
check('past the bounded wait it names the missing schema peer',
  expiredText.includes('schemastery') && expiredText.includes('未提供该插件的配置作用域'), expiredText.slice(-260))
check('and says what still works', expiredText.includes('不受影响'), expiredText.slice(-260))
check('the terminal field is still rendered in that state', fieldIn(unserved.tree()).input !== undefined)
unserved.unmount()

// (5) The route cannot be reached at all: degrade to a note, never throw.
getAnswer = 'reject'
const offline = mountStateful(main.component, { ...panelProps })
await offline.flush()
check('an unreachable route degrades to a note',
  textOf(offline.tree()).includes('读取失败'), textOf(offline.tree()).slice(-240))
check('the field is still offered when the read failed', fieldIn(offline.tree()).input !== undefined)
offline.unmount()

// (6) A browser with no fetch at all: the same degradation, and no exception.
const realFetch = context.fetch
context.fetch = undefined
const noFetch = mountStateful(main.component, { ...panelProps })
await noFetch.flush()
check('a browser without fetch still renders the field',
  textOf(noFetch.tree()).includes('没有 fetch'), textOf(noFetch.tree()).slice(-200))
check('and that panel offers a save control too', fieldIn(noFetch.tree()).save !== undefined)
noFetch.unmount()
context.fetch = realFetch

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const name of failures) console.log(` - ${name}`)
  process.exitCode = 1
}
