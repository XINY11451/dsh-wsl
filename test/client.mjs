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
for (const mention of ['一次一个全新 shell', 'systemd', '内置 job 工具读回结果', 'translatePaths', 'workdir', '请谨慎']) {
  check(`it renders the explanation mentioning "${mention}"`, rendered.includes(mention))
}
check('the destructive-guard switch warns in its own tooltip',
  switches.some((node) => node.props?.label === '危险命令守卫' && /有风险/.test(String(node.props?.title))),
  JSON.stringify(switches.map((node) => node.props?.title)))
// The panel must not carry the terminal recipe at all: which shell the sidebar's
// 新建终端 opens is the platform's business, not something an installed plugin
// advertises. The recipe lives in extras/terminal-wsl.patch.yml and the README.
check('the sidebar-terminal patch snippet is not rendered',
  !rendered.includes('- id: terminal-controller') && !rendered.includes('wsl.exe\''))
check('the panel never mentions the sidebar terminal at all',
  !rendered.includes('侧边栏终端') && !rendered.includes('terminal-controller'),
  rendered.slice(0, 200))
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
console.log('\nfeedback entry')
eq('the panel offers exactly one feedback entry',
  found.filter((node) => node.props?.children === '意见反馈 / 提升建议').length, 1)
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
  ['a title convention', '标题写清现象'],
  ['the three body parts', '正文写三段'],
  ['where to paste the copied block', '「补充」栏直接粘上面复制的内容'],
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
  ['the self-info header', '### 插件信息（由插件自己读出，可直接粘贴）'],
  ['an honest note when the version is unreadable', '版本：未能读取'],
  ['the panel switch states', '### 面板里的开关'],
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

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const name of failures) console.log(` - ${name}`)
  process.exitCode = 1
}
