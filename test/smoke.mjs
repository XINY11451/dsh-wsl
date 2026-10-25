// Regression suite for dsh-wsl.
//
//   node test/smoke.mjs            # with the shim below standing in for ctx.subprocess
//   node test/smoke.mjs --real     # the same checks against the REAL DSH provider
//
// The plugin is exercised through its real entry points (`apply` -> the three
// tool objects), against the real WSL installation. The default backend is a
// shim that reimplements the DSH seam faithfully enough to matter: bounded
// in-memory TAIL windows, a full-stream spill file, abort -> SIGTERM -> grace ->
// SIGKILL, and an `exit`/`close` split so a survivor on the other side of
// wsl.exe cannot hold `done` open forever. `--real` swaps that shim for
// `LocalSubprocessRuntime`, which is the point: the seam facts must not drift
// behind a hand-written imitation.

import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import {
  appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply, buildConfig } from '../index.js'
import { resolveConfig } from '../lib/config.js'
import { pickSchemaBuilder } from '../lib/schema.js'
import { buildCdCommand, quotePath, shellQuote, windowsPathToWsl } from '../lib/paths.js'
import { FS_EXIT, grepFallbackPattern, grepScript, parseGrepZ, parseRgJson, previewLine, readScript, writeScript } from '../lib/fs-ops.js'
import { computeHunks, HUNK_CONTEXT } from '../lib/hunks.js'
import { destructiveReason } from '../lib/guard.js'
import { channelSessionOf, createChannel, firstUserLine, SAY_PREFIX, sessionRecordOf, titlesOf, validSessionId, walletText } from '../lib/channel.js'
import { cleanStderr, formatResult, normalizeExitCode, streamFacts } from '../lib/result.js'
import { assertLauncherReachable, collectForwardEnv, resolveDistro, sessionCwdOf } from '../lib/runner.js'
import { capabilityLines, launcherSummary, parseFacts, workspaceLine } from '../lib/diagnostics.js'
import { parseDefaultDistro } from '../lib/tools/wsl-env.js'
import {
  parseFlowSequence, readTerminalCwd, readTerminalScrollback, reviewTerminalWrite, splitPatchLines,
  validateTerminalCwd, validateTerminalScrollback, verifyTerminalRewrite, verifyTerminalScrollbackRewrite,
  writeTerminalCwd, writeTerminalScrollback,
} from '../lib/terminal-cwd.js'
import {
  commandState, composeDoctorReport, needsFromFacts, parseProbe, suggestionRecipes, versionToken,
} from '../lib/doctor.js'
import {
  BOOTSTRAP_TIMEOUT_MS, NODE_LTS_SCRIPT, parsePresence, planFor, presenceProbe, RECIPE_IDS, renderOutcome, renderPlan, resolveRecipes, tailOf,
} from '../lib/bootstrap.js'
import { createWslDoctorTool } from '../lib/tools/wsl-doctor.js'
import { createWslBootstrapTool } from '../lib/tools/wsl-bootstrap.js'
import { createWslPathTool } from '../lib/tools/wsl-path.js'
import { createWslTool } from '../lib/tools/wsl.js'
import {
  appendCapture, autoTerminalIds, clipTail, describeSessionCwd, END_PREFIX, extractHelperResult, HELPER_NAME,
  helperCall, helperDefinition, inputLine, looksReady, OPENED_TERMINAL_NOTE, pickTerminal, renderTerminals, spillLine,
  START_PREFIX, stripAnsi,
} from '../lib/terminal.js'
import { createSubtaskLog, projectSubtask } from '../lib/subtasks.js'
import { createWslTermTool, readinessText } from '../lib/tools/wsl-term.js'
import { createLazyTerminalTransport, createPtyTransport, createTerminalTransport } from '../lib/pty-transport.js'
import { createBridgeTransport } from '../lib/term-bridge.js'

// One resolved configuration stands in for the mount the host would create.
const CONFIG = resolveConfig({})
const MAX_OUT = CONFIG.maxOutputBytes
const render = (value) => formatResult(value, MAX_OUT)

// Runs one command outside the plugin's own seams, for the handful of facts the suite has
// to learn about the machine it is running on (the default distribution, its home).
function machineFact(program, args) {
  return new Promise((done) => {
    const child = spawn(program, args, { env: { ...process.env, WSL_UTF8: '1' } })
    const out = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.on('close', () => done(Buffer.concat(out).toString('utf8').trim()))
    child.on('error', () => done(''))
  })
}

// --- tiny test harness -----------------------------------------------------

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

async function rejects(name, fn, pattern) {
  try {
    await fn()
    check(name, false, 'expected a rejection, got a value')
  } catch (error) {
    check(name, pattern.test(String(error?.message ?? error)), `message was ${JSON.stringify(String(error?.message ?? error))}`)
  }
}

// --- subprocess seam shim --------------------------------------------------

function makeShim(spillDir) {
  const calls = []
  return {
    calls,
    spawn(spec) {
      calls.push(spec)
      const [program, ...rest] = spec.argv
      const stdinSpec = spec.stdio.stdin
      const wantsStdin = typeof stdinSpec === 'object' && stdinSpec !== null && typeof stdinSpec.data === 'string'
      const child = spawn(program, rest, {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
      if (wantsStdin) child.stdin.end(stdinSpec.data)

      const makeCollector = (maxBytes, maxSpillBytes, label) => {
        let buffered = [] // all bytes, until the first overflow
        let tail = [] // bytes inside the in-memory window once spilling
        let total = 0
        let spillFdPath = null
        let spillBytes = 0
        let spilling = false
        let spillDisabled = false

        const openSpill = () => {
          spillFdPath = join(spillDir, `${label}-${Math.random().toString(16).slice(2)}.bin`)
          const prior = Buffer.concat(buffered)
          writeFileSync(spillFdPath, prior)
          spillBytes = prior.length
          spilling = true
        }

        const push = (chunk) => {
          total += chunk.length
          if (!spilling && !spillDisabled) {
            buffered.push(chunk)
            if (total <= maxBytes) {
              // Still under the cap: the whole stream IS the retained tail.
              tail = buffered
              return
            }
            // First overflow. Every byte is still in memory, so the spill can
            // be opened with the complete head before the window is trimmed.
            if (maxSpillBytes !== undefined && total <= maxSpillBytes) openSpill()
            else spillDisabled = true
            tail = [Buffer.concat(buffered)]
            buffered = []
            trimTail()
            return
          }
          if (spilling) {
            if (maxSpillBytes !== undefined && spillBytes + chunk.length > maxSpillBytes) {
              // The spill can no longer hold the complete stream: drop it.
              spilling = false
              spillDisabled = true
              try { rmSync(spillFdPath) } catch {}
              spillFdPath = null
            } else {
              appendFileSync(spillFdPath, chunk)
              spillBytes += chunk.length
            }
          }
          tail.push(chunk)
          trimTail()
        }

        const trimTail = () => {
          let kept = tail.reduce((sum, c) => sum + c.length, 0)
          while (kept > maxBytes && tail.length > 1) kept -= tail.shift().length
        }

        const readFrom = (fromByte) => {
          const tailBuffer = Buffer.concat(tail)
          const tailStart = total - tailBuffer.length
          const spillPath = spilling && spillFdPath !== null && statSafe(spillFdPath) === spillBytes ? spillFdPath : undefined
          if (fromByte < tailStart) {
            return { text: tailBuffer.toString('utf8'), nextOffset: total, lossy: true, ...(spillPath ? { spillPath } : {}) }
          }
          return {
            text: tailBuffer.subarray(fromByte - tailStart).toString('utf8'),
            nextOffset: total,
            lossy: false,
            ...(spillPath ? { spillPath } : {}),
          }
        }

        return { push, readFrom }
      }

      const stdout = makeCollector(spec.stdio.stdout.maxBytes, spec.stdio.stdout.spill?.maxBytes, 'stdout')
      const stderr = makeCollector(spec.stdio.stderr.maxBytes, spec.stdio.stderr.spill?.maxBytes, 'stderr')
      child.stdout.on('data', (chunk) => stdout.push(chunk))
      child.stderr.on('data', (chunk) => stderr.push(chunk))

      let settled = false
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      const settle = (exitCode, signal) => {
        if (settled) return
        settled = true
        resolveDone({ exitCode: exitCode ?? null, signal: signal ?? null })
      }

      child.on('exit', (code, signal) => {
        // Mirrors the seam: a survivor holding a descriptor cannot postpone the
        // outcome past the grace period.
        setTimeout(() => settle(code, signal), spec.graceMs).unref?.()
      })
      child.on('close', (code, signal) => settle(code, signal))
      child.on('error', (error) => {
        settle(null, null)
        void error
      })

      // The seam's own termination ladder (the real provider stages TERM then
      // KILL; background jobs call this through JobHooks.cancel).
      const terminate = () => {
        try { child.kill('SIGTERM') } catch {}
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, spec.graceMs).unref?.()
      }

      if (spec.signal) {
        spec.signal.addEventListener('abort', terminate, { once: true })
      }

      return { done, terminate, collected: { stdout, stderr } }
    },
  }
}

// node:fs helpers kept out of the collector closure for readability.
function statSafe(path) {
  try { return statSync(path).size } catch { return -1 }
}

/**
 * A profile patch shaped like the real one: unrelated entries, then the
 * `terminal-controller` override the optional recipe installs.
 *
 * `argsLine` is the one line the terminal-startup feature rewrites, so the tests can
 * vary its shape (padded, tight, a trailing comment, a block list) without touching
 * anything else.
 */
function samplePatch(argsLine = "      args: [ '-d', 'Ubuntu-22.04', '-e', 'bash', '-l' ]") {
  return [
    '# Your patch layer for this dsh profile, applied after every bundle layer.',
    '- id: ui-settings',
    '  config:',
    '    enabled: true',
    '- id: terminal-controller',
    '  config:',
    '    shell:',
    "      path: 'C:\\Windows\\System32\\wsl.exe'",
    '      name: WSL',
    argsLine,
    '',
  ].join('\n')
}

/** The `args:` line of a patch text, for line-level assertions. */
function argsLineOf(text) {
  return splitPatchLines(text).lines.find((line) => /^\s*args:/.test(line)) ?? ''
}

/** How many lines differ between two texts (the feature must change exactly one). */
function changedLines(before, after) {
  const a = splitPatchLines(before).lines
  const b = splitPatchLines(after).lines
  if (a.length !== b.length) return -1
  let changed = 0
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) changed += 1
  return changed
}

/**
 * Drive one registered route with a fake request/response, the way node:http would: one
 * body chunk and the end, and the codes/headers/body the handler answered.
 */
function callRoute(route, method, body, headers) {
  const request = {
    method,
    headers: headers ?? (method === 'POST' ? { 'content-type': 'application/json' } : {}),
    on(event, callback) {
      if (event === 'data' && body !== undefined) callback(Buffer.from(body, 'utf8'))
      if (event === 'end') callback()
      return this
    },
  }
  const response = {
    writeHead(code, responseHeaders) { this.code = code; this.headers = responseHeaders },
    end(text) { this.body = text },
  }
  return Promise.resolve(route.handler(request, response)).then(() => response)
}

/** The real provider, behind the same `{ calls, spawn }` shape as the shim. */
async function makeRealBackend(modulesRoot) {
  const load = (relative) => import(pathToFileURL(`${modulesRoot}/${relative}`).href)
  const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
  const { default: LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local/lib/index.js')
  const runtime = new LocalSubprocessRuntime(new Context())
  const calls = []
  return {
    calls,
    spawn(spec) {
      calls.push(spec)
      return runtime.spawn(spec)
    },
  }
}

/** A stand-in for the host's `ctx.jobs` registry (`start(spec)` -> JobHooks). */
function makeJobs() {
  const records = new Map()
  let counter = 0
  return {
    starts: 0,
    start(spec) {
      this.starts += 1
      const id = `${spec.kind}-${++counter}`
      const hooks = spec.run()
      const record = { id, spec, hooks, outcome: null }
      records.set(id, record)
      return id
    },
    record(id) { return records.get(id) },
    /** Await the producer's `done`, like the runtime's own bookkeeping. */
    async settled(id) {
      const record = records.get(id)
      record.outcome = await record.hooks.done
      return record
    },
  }
}

/**
 * A stand-in for lib/runner.js, for the two tools whose whole job is deciding
 * what to send: the doctor and the installer.
 *
 * It matters that this is a stub and not the real runner. The doctor's verdict
 * depends on the machine (`node` is missing here, present elsewhere), so a test
 * that asserted real probe output would encode the author's distribution. And
 * the installer's executed path installs software — a test must never be able
 * to reach it.
 */
function makeStubRunner(answer = {}) {
  const calls = []
  const reply = (over = {}) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutMs: null,
    asRoot: false,
    stdout: '',
    stderr: '',
    truncated: false,
    stdoutTotalBytes: 0,
    stdoutDroppedBytes: 0,
    stderrTotalBytes: 0,
    stderrDroppedBytes: 0,
    stdoutSpillPath: null,
    stderrSpillPath: null,
    jobId: null,
    ...over,
  })
  return {
    calls,
    resolveDistro: (arg) => (arg === undefined || arg === null || arg === '' ? null : arg),
    async spawnWsl(argv, timeoutMs) {
      calls.push({ kind: 'spawn', argv, timeoutMs })
      return reply({ stdout: answer.spawn?.(argv) ?? '' })
    },
    async runWsl(command, opts = {}) {
      calls.push({ kind: 'run', command, opts })
      return reply({ asRoot: opts.asRoot === true, ...(answer.run?.(command, opts) ?? {}) })
    },
  }
}

/**
 * A fake `spawnTerminal` provider for the private-PTY transport.
 *
 * The handle answers `terminate` (so an owner cleanup can be observed), records every
 * `write`, and can reject it the way a real PTY does once the shell has exited.
 * @param {{ writeRejects?: boolean }} [options] - make `write` reject.
 * @returns `{ provider, calls }`.
 */
function makePtyProvider(options = {}) {
  const calls = { spawned: [], writes: [], terminated: 0 }
  const provider = {
    resolveExecutable: async () => 'wsl.exe',
    async spawnTerminal(spec) {
      calls.spawned.push(spec)
      let finishOutput
      const outputDone = new Promise((resolve) => { finishOutput = resolve })
      let exit
      const done = new Promise((resolve) => { exit = resolve })
      return {
        output: {
          [Symbol.asyncIterator]() {
            return { next: () => outputDone.then(() => ({ done: true })) }
          },
        },
        done,
        async write(data) {
          calls.writes.push(String(data))
          if (options.writeRejects === true) throw new Error('the shell has exited')
        },
        async terminate() {
          calls.terminated += 1
          finishOutput()
          exit({ exitCode: 0 })
        },
        async resize() {},
        async inspectActivity() { return { state: 'idle', revision: 0 } },
      }
    },
  }
  return { provider, calls }
}

/**
 * A `terminalController` stand-in.
 *
 * The real service yields a screen snapshot first and only then accepts input, so
 * the stub does the same: `write` pushes the frames the shell would print, and the
 * test builds them from the markers it finds in the written payload — which also
 * checks that the tool's wrapper is parseable.
 */
function makeTerminalStub({
  terminals = [], screen = '$ ', onWrite, writeError = null, createError = null,
  noSnapshot = false, stallOnReturn = false, stallOnCreate = false, stallOnWrite = false,
  stallOnClose = false,
} = {}) {
  const calls = { list: [], create: [], follow: [], write: [], close: [], detached: 0 }
  // Mutable, so a test can make ONE later call stop answering (the close that follows a finished
  // subtask, say) without hanging the calls before it.
  const stall = { create: stallOnCreate, write: stallOnWrite, close: stallOnClose }
  const infos = [...terminals]
  const queue = []
  const waiters = []
  const push = (frame) => {
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else queue.push(frame)
  }
  const next = (signal) => new Promise((resolve) => {
    if (queue.length > 0) return resolve(queue.shift())
    const onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    waiters.push((frame) => {
      signal.removeEventListener('abort', onAbort)
      resolve(frame)
    })
  })
  return {
    calls,
    infos,
    stall,
    /** Push a frame as if it arrived from the host, for tests that need one later. */
    pushFrame: push,
    list(sessionId) {
      calls.list.push(sessionId)
      return infos
    },
    async create(agent, request, signal) {
      calls.create.push({ agentId: agent.id, id: request.id, cols: request.cols, rows: request.rows, signal })
      if (stall.create) await new Promise(() => {})
      if (typeof createError === 'function') {
        const error = createError(request)
        if (error !== null) throw error
      }
      const info = {
        id: request.id, title: 'bash', shell: { name: 'bash', path: '/bin/bash', args: ['-i'] },
        cwd: '/home/xiny', cols: request.cols, rows: request.rows, state: 'running', exitCode: null,
      }
      infos.push(info)
      return info
    },
    follow(agent, id, attachmentId, signal) {
      calls.follow.push({ agentId: agent.id, id, attachmentId })
      const self = infos.find((info) => info.id === id)
      return (async function* followFrames() {
        try {
          if (signal.aborted) return
          if (!noSnapshot) yield { type: 'snapshot', sequence: 1, screen, info: self }
          while (true) {
            const frame = await next(signal)
            if (frame === null || signal.aborted) return
            yield frame
          }
        } finally {
          calls.detached += 1
          // A transport that ignores the abort: the tool must not wait for it forever.
          if (stallOnReturn) await new Promise(() => {})
        }
      })()
    },
    async write(agent, id, attachmentId, data) {
      if (writeError !== null) throw writeError
      calls.write.push({ id, attachmentId, data, at: Date.now() })
      if (stall.write) await new Promise(() => {})
      if (typeof onWrite === 'function') for (const frame of onWrite(data) ?? []) push(frame)
    },
    async close(agent, id) {
      calls.close.push(id)
      if (stall.close) await new Promise(() => {})
      const index = infos.findIndex((info) => info.id === id)
      if (index >= 0) infos.splice(index, 1)
    },
  }
}

/** The probe output a distribution with python but no node produces. */
const DOCTOR_PROBE_TEXT = [
  'file.package.json=1',
  'file.pnpm-lock.yaml=1',
  'pkg.manager=pnpm@9.12.0',
  'cmd.node=missing',
  'cmd.npm=interop:/mnt/c/Program Files/nodejs/npm',
  'cmd.pnpm=missing',
  'cmd.python3=/usr/bin/python3',
  'cmd.git=/usr/bin/git',
  'ver.python3=Python 3.10.12',
  'ver.git=git version 2.34.1',
  'user.uid=1000',
  'user.name=xiny',
  'sudo.passwordless=0',
].join('\n')

function makeCtx(shim, { jobs, shellEnv, settings, profileContext, terminalController, spillStore } = {}) {
  const tools = {}
  const handlers = new Map()
  const routes = []
  const effects = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    // `register` returns the disposer that removes exactly this tool, which is what
    // lets a tool switch take effect live. Modelling that here is not decoration:
    // without it a test cannot tell "the switch registered the tool" from "the
    // switch retired it".
    tools: {
      register(tool) {
        tools[tool.name] = tool
        return () => {
          if (tools[tool.name] === tool) delete tools[tool.name]
        }
      },
    },
    subprocess: shim,
    // Optional services: the plugin must work when these return undefined.
    get: (name) => (name === 'jobs' ? jobs
      : name === 'shellEnv' ? shellEnv
        : name === 'profileContext' ? profileContext
          : name === 'terminalController' ? terminalController
            : name === 'spillStore' ? spillStore
              : undefined),
    // Event handlers, so a test can fire a live settings update. Kept off the tool
    // map's enumerable keys: those are asserted on with Object.keys.
    on: (event, callback) => { handlers.set(event, callback) },
    // The self-info route is optional as well: record whatever the plugin registers.
    inject: (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('webServer')) {
        callback({
          webServer,
          effect: (fn) => {
            effects.push(fn)
            return () => {}
          },
        })
      }
    },
  }
  // `settings` is the plugin's own configuration as the composition resolves it
  // against the Config schema — what the sidebar panel writes. It is passed BY
  // REFERENCE because a volatile edit mutates it in place.
  apply(ctx, settings)
  Object.defineProperty(tools, 'handlers', { value: handlers, enumerable: false })
  Object.defineProperty(tools, 'routes', { value: routes, enumerable: false })
  return tools
}

// --- pure helpers ----------------------------------------------------------

async function unitTests() {
  console.log('\npath translation')
  const t = windowsPathToWsl
  eq('simple drive path', t('C:\\Users\\me\\a.txt'), '/mnt/c/Users/me/a.txt')
  eq('backslashes with a space', t('C:\\Program Files\\Git\\cmd'), '/mnt/c/Program Files/Git/cmd')
  eq('trailing segment after a space', t('C:\\Program Files'), '/mnt/c/Program Files')
  eq('space in a middle segment', t('C:\\Users\\35280\\My Documents'), '/mnt/c/Users/35280/My Documents')
  eq('forward slashes with a space', t('C:/Program Files/Git'), '/mnt/c/Program Files/Git')
  eq('lowercase drive, backslash', t('d:\\stuff'), '/mnt/d/stuff')
  eq('duplicated separator collapses', t('C:\\\\foo'), '/mnt/c/foo')
  eq('two paths in one command', t('ls C:\\a && ls D:\\b'), 'ls /mnt/c/a && ls /mnt/d/b')
  eq('stops before a shell operator', t('ls C:\\a && echo hi'), 'ls /mnt/c/a && echo hi')
  eq('two drive paths, space separated', t('cp C:\\a.txt D:\\b.txt'), 'cp /mnt/c/a.txt /mnt/d/b.txt')
  eq('three drive paths', t('diff C:\\a\\b.txt D:\\c\\d.txt E:\\e.txt'), 'diff /mnt/c/a/b.txt /mnt/d/c/d.txt /mnt/e/e.txt')
  eq('parenthesised path segment', t('ls "C:\\Program Files (x86)\\Steam"'), 'ls "/mnt/c/Program Files (x86)/Steam"')
  eq('trailing spaced segment without a backslash', t('cd C:\\Users\\me\\My Docs'), 'cd /mnt/c/Users/me/My Docs')
  eq('URL is untouched', t('curl https://example.com/x'), 'curl https://example.com/x')
  eq('drive-like text inside a substitution is untouched', t('sed "s/C:\\x/y/"'), 'sed "s/C:\\x/y/"')
  eq('drive-like segment inside a URL is untouched', t('echo "see http://x/C:/y"'), 'echo "see http://x/C:/y"')
  eq('lowercase letter-slash is untouched', t("echo 'a:/b'"), "echo 'a:/b'")
  eq('quoted windows path', t('cat "C:\\Program Files\\a b.txt"'), 'cat "/mnt/c/Program Files/a b.txt"')
  eq('UNC wsl.localhost', t('ls \\\\wsl.localhost\\Ubuntu-22.04\\home\\xiny'), 'ls /home/xiny')
  eq('UNC wsl$', t('ls \\\\wsl$\\Ubuntu-22.04\\home'), 'ls /home')
  eq('bare UNC distro root', t('ls \\\\wsl.localhost\\Ubuntu-22.04'), 'ls /')
  // With the distribution known, a UNC path naming ANOTHER one is not this distribution's
  // directory: translating it would silently repoint the command at the wrong files.
  eq('a UNC path of the same distribution is translated with its name',
    t('ls \\\\wsl.localhost\\Ubuntu-22.04\\home\\x', { distro: 'Ubuntu-22.04' }), 'ls /home/x')
  eq('a UNC path of another distribution is left alone',
    t('ls \\\\wsl.localhost\\Debian\\home\\x', { distro: 'Ubuntu-22.04' }),
    'ls \\\\wsl.localhost\\Debian\\home\\x')
  eq('the UNC match is case-insensitive like Windows',
    t('ls \\\\WSL$\\ubuntu-22.04\\home', { distro: 'Ubuntu-22.04' }), 'ls /home')
  eq('plain linux path untouched', t('/mnt/c/Users'), '/mnt/c/Users')

  console.log('\nworkdir quoting')
  const cd = buildCdCommand
  eq('bare tilde stays expandable', cd('~'), 'cd ~')
  eq('tilde with a space is split', cd('~/my dir'), "cd ~/'my dir'")
  eq('tilde with a plain subdir', cd('~/src'), "cd ~/'src'")
  eq('named tilde', cd('~user/x'), "cd ~user/'x'")
  eq('absolute path is quoted whole', cd('/mnt/c/Program Files'), "cd '/mnt/c/Program Files'")
  eq('single quote is escaped', cd("/tmp/it's here"), "cd '/tmp/it'\\''s here'")
  eq('tilde-only path stays bare', quotePath('~'), '~')
  eq('relative path is quoted', quotePath('relative dir'), "'relative dir'")
  eq('a single quote is escaped', shellQuote("it's"), "'it'\\''s'")

  // The sidebar terminal's startup directory lives in the profile patch, not in this
  // plugin's configuration, so the rules for touching that file are their own unit:
  // one line in, one line out, nothing else moved.
  console.log('\nterminal startup directory: patch text')
  const before = samplePatch()
  const initial = readTerminalCwd(before)
  eq('an unset terminal starts empty', initial.path, '')
  eq('the terminal row is reported as present', initial.row, true)
  eq('reading a fine patch reports no error', initial.error, null)

  const set = writeTerminalCwd(before, '/mnt/d/project')
  eq('a directory is written', set.ok, true)
  eq('the written value is the trimmed path', set.path, '/mnt/d/project')
  eq('exactly one line changes', changedLines(before, set.text), 1)
  eq('the line count is unchanged', splitPatchLines(set.text).lines.length, splitPatchLines(before).lines.length)
  eq('and it is the args line, with the flag before -e', argsLineOf(set.text),
    "      args: [ '-d', 'Ubuntu-22.04', '--cd', '/mnt/d/project', '-e', 'bash', '-l' ]")
  eq('reading it back gives the same directory', readTerminalCwd(set.text).path, '/mnt/d/project')

  const moved = writeTerminalCwd(set.text, '/mnt/c/other')
  eq('changing the directory keeps exactly one --cd', (moved.text.match(/--cd/g) ?? []).length, 1)
  eq('the second write wins', readTerminalCwd(moved.text).path, '/mnt/c/other')
  check('the replaced directory is gone', !moved.text.includes('/mnt/d/project'), moved.text)

  const equalsPatch = samplePatch("      args: [ '--cd=/mnt/old', '-e', 'bash' ]")
  eq('the --cd=value form is read', readTerminalCwd(equalsPatch).path, '/mnt/old')
  const equals = writeTerminalCwd(equalsPatch, '/mnt/new')
  eq('the --cd=value form is replaced, not duplicated', (equals.text.match(/--cd/g) ?? []).length, 1)
  eq('it is written back as a flag with a separate value', readTerminalCwd(equals.text).path, '/mnt/new')

  const cleared = writeTerminalCwd(set.text, '   ')
  eq('an empty field removes the flag', (cleared.text.match(/--cd/g) ?? []).length, 0)
  eq('clearing restores the original args line', argsLineOf(cleared.text), argsLineOf(before))
  eq('clearing reports an empty path', cleared.path, '')

  eq('tight bracket spacing is preserved',
    argsLineOf(writeTerminalCwd(samplePatch("      args: ['-e', 'bash', '-l']"), '/mnt/d/x').text),
    "      args: ['--cd', '/mnt/d/x', '-e', 'bash', '-l']")
  check('padded bracket spacing is preserved', argsLineOf(set.text).startsWith('      args: [ '), argsLineOf(set.text))
  check('a trailing comment survives the rewrite',
    argsLineOf(writeTerminalCwd(samplePatch("      args: [ '-e', 'bash' ]  # keep -l"), '/x').text).endsWith('# keep -l'))
  eq('a path with a space stays one scalar',
    readTerminalCwd(writeTerminalCwd(before, '/mnt/c/Program Files').text).path, '/mnt/c/Program Files')
  eq('a token with an apostrophe round-trips', parseFlowSequence("[ 'it''s', '-e' ]").tokens[0], "it's")

  // YAML double-quoted scalars are the idiomatic way to write a Windows path (each
  // backslash doubled). Reading one as if the escapes were literal would DOUBLE the
  // backslashes on the way back out, silently changing a value the user already had.
  const doubleQuotedPatch = samplePatch('      args: [ "--cd", "C:\\\\Users\\\\me\\\\My Documents", "-e", "bash" ]')
  eq('a double-quoted path is decoded', readTerminalCwd(doubleQuotedPatch).path, 'C:\\Users\\me\\My Documents')
  const doubleQuotedParsed = parseFlowSequence('[ "--cd", "C:\\\\Users\\\\me" ]')
  eq('and the token itself carries one backslash', doubleQuotedParsed.tokens[1], 'C:\\Users\\me')
  const rewritten = writeTerminalCwd(doubleQuotedPatch, 'D:\\work')
  eq('a double-quoted patch can be rewritten', rewritten.ok, true)
  eq('the new value is what lands', readTerminalCwd(rewritten.text).path, 'D:\\work')
  // A double-quoted token this plugin does NOT own must come back with the same VALUE,
  // even though it is re-rendered as a single-quoted scalar.
  const otherToken = writeTerminalCwd(samplePatch('      args: [ "-d", "C:\\\\Ubuntu", "-e", "bash" ]'), '/mnt/d/x')
  check('an unrelated double-quoted token keeps its single backslash',
    argsLineOf(otherToken.text) === "      args: [ '-d', 'C:\\Ubuntu', '--cd', '/mnt/d/x', '-e', 'bash' ]",
    argsLineOf(otherToken.text))
  // An escape this reader does NOT decode must refuse the line rather than rewrite it as
  // something that means something else.
  eq('an undecodable double-quote escape refuses the line', parseFlowSequence('[ "-e", "a\\tb" ]'), null)
  const escapedRefusal = writeTerminalCwd(samplePatch('      args: [ "-e", "a\\tb" ]'), '/mnt/d/x')
  check('and the write is refused with the text untouched',
    escapedRefusal.ok === false && escapedRefusal.text === samplePatch('      args: [ "-e", "a\\tb" ]'),
    String(escapedRefusal.error))

  const rejectedNewline = writeTerminalCwd(before, '/mnt/a\n/mnt/b')
  check('a line break is refused', rejectedNewline.ok === false && /换行/.test(rejectedNewline.error), String(rejectedNewline.error))
  check('a refused write hands back the text untouched', rejectedNewline.text === before)
  const rejectedQuote = writeTerminalCwd(before, "/mnt/it's")
  check('a quote is refused', rejectedQuote.ok === false && /引号/.test(rejectedQuote.error), String(rejectedQuote.error))
  check('that refusal also leaves the text untouched', rejectedQuote.text === before)
  eq('validate refuses a non-string', validateTerminalCwd(null).ok, false)
  eq('validate trims a path', validateTerminalCwd('  /mnt/d/x  ').value, '/mnt/d/x')
  eq('validate reads whitespace as "no flag"', validateTerminalCwd('   ').value, '')

  const noRow = samplePatch().replace(/- id: terminal-controller\n/, '')
  const noRowWrite = writeTerminalCwd(noRow, '/x')
  check('a patch without the terminal row is refused',
    noRowWrite.ok === false && /terminal-controller/.test(noRowWrite.error), String(noRowWrite.error))
  const noRowRead = readTerminalCwd(noRow)
  check('reading it reports "no row" rather than an error',
    noRowRead.row === false && noRowRead.error === null, JSON.stringify(noRowRead))
  const blockArgsText = samplePatch('      args:\n        - -e\n        - bash')
  const blockArgs = writeTerminalCwd(blockArgsText, '/x')
  check('a block-style args list is refused rather than rewritten', blockArgs.ok === false, String(blockArgs.ok))
  check('the refused block-style text is unchanged', blockArgs.text === blockArgsText)
  const twoArgs = writeTerminalCwd(samplePatch("      args: [ '-e' ]\n      args: [ '-l' ]"), '/x')
  check('two args lines in one entry are refused as ambiguous',
    twoArgs.ok === false && /不止一处/.test(twoArgs.error), String(twoArgs.error))

  // The args this feature owns live INSIDE the row's `shell:` mapping, so the search is
  // anchored there: a flow-style shell (nothing to rewrite line-wise), a shell with no
  // args line, and an `args:` that is a SIBLING of shell are all handled without guessing.
  const flowShell = [
    '- id: terminal-controller',
    '  config:',
    "    shell: {path: 'C:\\Windows\\System32\\wsl.exe', name: WSL, args: ['-e', 'bash']}",
    '',
  ].join('\n')
  const flowRead = readTerminalCwd(flowShell)
  check('a flow-style shell is reported rather than guessed at',
    flowRead.row === true && typeof flowRead.error === 'string', JSON.stringify(flowRead))
  const flowWrite = writeTerminalCwd(flowShell, '/x')
  check('and writing to it is refused with the text untouched',
    flowWrite.ok === false && flowWrite.text === flowShell, String(flowWrite.error))
  const noArgsShell = [
    '- id: terminal-controller',
    '  config:',
    '    shell:',
    "      path: 'C:\\Windows\\System32\\wsl.exe'",
    '      name: WSL',
    '',
  ].join('\n')
  check('a shell with no args line is refused', writeTerminalCwd(noArgsShell, '/x').ok === false)
  const siblingArgs = [
    '- id: terminal-controller',
    '  config:',
    '    shell:',
    "      path: 'C:\\Windows\\System32\\wsl.exe'",
    '      name: WSL',
    "      args: [ '-e', 'bash' ]",
    '    args: [ "a sibling of shell, not ours" ]',
    '',
  ].join('\n')
  const siblingWrite = writeTerminalCwd(siblingArgs, '/mnt/d/x')
  eq('the shell mapping is what gets rewritten', siblingWrite.ok, true)
  eq('and exactly one line changes', changedLines(siblingArgs, siblingWrite.text), 1)
  check('an args line that is a sibling of shell is ignored',
    siblingWrite.text.includes('    args: [ "a sibling of shell, not ours" ]'), siblingWrite.text)

  const crlf = samplePatch().split('\n').join('\r\n')
  const crlfSet = writeTerminalCwd(crlf, '/mnt/d/x')
  check('a CRLF patch is rewritten as CRLF', crlfSet.text.includes('\r\n')
    && !crlfSet.text.split('\r\n').some((line) => line.includes('\n')), JSON.stringify(crlfSet.text.slice(-80)))
  eq('the CRLF rewrite verifies', verifyTerminalRewrite(crlf, crlfSet.text, '/mnt/d/x'), null)

  // A patch can be MIXED, and the author's own profile is: 5 CRLF lines among 37 LF
  // ones, written by different tools over time. A splitter that assumes one file-wide
  // ending reads that 42-line file as six lines, finds no terminal row at all, and then
  // refuses every write with "no such row" — measured, before the terminator was kept
  // per line. Both halves of that are pinned here.
  console.log('\nterminal startup directory: mixed line endings')
  const mixed = samplePatch().replace('\n', '\r\n')
  const mixedRead = readTerminalCwd(mixed)
  eq('a mixed-ending patch still finds the row', mixedRead.row, true)
  eq('and reads its value', mixedRead.path, '')
  eq('lines are counted per line, not per ending',
    splitPatchLines(mixed).lines.length, splitPatchLines(samplePatch()).lines.length)
  const mixedSet = writeTerminalCwd(mixed, '/mnt/d/x')
  eq('the mixed rewrite verifies', verifyTerminalRewrite(mixed, mixedSet.text, '/mnt/d/x'), null)
  eq('only the args line changes', changedLines(mixed, mixedSet.text), 1)
  eq('the CRLF line keeps its ending', splitPatchLines(mixedSet.text).eols[0], '\r\n')
  eq('every other byte is preserved',
    mixedSet.text.split(argsLineOf(mixedSet.text)).join(argsLineOf(mixed)), mixed)

  console.log('\nterminal startup directory: write verification')
  eq('a good rewrite verifies', verifyTerminalRewrite(before, set.text, '/mnt/d/project'), null)
  check('a BOM is caught', /BOM/.test(String(verifyTerminalRewrite(before, `\uFEFF${set.text}`, '/mnt/d/project'))))
  // Removing a newline merges two lines. The write must still be refused; the reason is
  // now the terminator shape rather than the line count, because a one-line insertion or
  // deletion is a legitimate shape for a key that is added or cleared.
  check('a lost line is caught',
    /换行符|行数|改动/.test(String(verifyTerminalRewrite(before, set.text.replace('\n', ''), '/mnt/d/project'))))
  check('a second changed line is caught',
    /应当只改/.test(String(verifyTerminalRewrite(before, set.text.replace('name: WSL', 'name: WSL2'), '/mnt/d/project'))))
  check('a value that does not read back is caught',
    /读回/.test(String(verifyTerminalRewrite(before, set.text, '/mnt/d/other'))))

  // What to do with what landed: accept our own write, undo our own bad write, and NEVER
  // overwrite a version somebody else wrote after us.
  console.log('\nterminal startup directory: post-write review')
  eq('a correct write is accepted', reviewTerminalWrite(before, set.text, set.text, '/mnt/d/project').verdict, 'ok')
  const conflicted = reviewTerminalWrite(before, `${set.text}# someone else\n`, set.text, '/mnt/d/project')
  eq('a file somebody else changed is a conflict', conflicted.verdict, 'conflict')
  check('and the conflict refuses to restore over them',
    /未自动还原/.test(String(conflicted.error)), String(conflicted.error))
  eq('a file that cannot be read back is undone',
    reviewTerminalWrite(before, null, set.text, '/mnt/d/project').verdict, 'undo')
  const landedWrong = set.text.replace('name: WSL', 'name: WSL2')
  eq('our own text that landed wrong is undone',
    reviewTerminalWrite(before, landedWrong, landedWrong, '/mnt/d/project').verdict, 'undo')

  // The terminal row does not have to sit at column zero: an override nested under an
  // `insert:` list is the same override, and its block still has to end before the next
  // sibling — otherwise a LATER row's args line would look like a second candidate.
  console.log('\nterminal startup directory: an indented row')
  const nested = [
    '- insert:',
    '    - id: terminal-controller',
    '      config:',
    '        shell:',
    "          path: 'C:\\Windows\\System32\\wsl.exe'",
    '          name: WSL',
    "          args: [ '-e', 'bash', '-l' ]",
    '    - id: another-row',
    '      config:',
    '        args: [ "not", "ours" ]',
    '',
  ].join('\n')
  const nestedRead = readTerminalCwd(nested)
  eq('a nested terminal row is found', nestedRead.row, true)
  eq('and reads as unset', nestedRead.path, '')
  const nestedSet = writeTerminalCwd(nested, '/mnt/d/x')
  eq('a nested row can be written', nestedSet.ok, true)
  eq('only its args line changes', changedLines(nested, nestedSet.text), 1)
  check('the rewritten line keeps the row indentation',
    argsLineOf(nestedSet.text).startsWith('          args: [ '), argsLineOf(nestedSet.text))
  check('--cd still lands before -e',
    argsLineOf(nestedSet.text).indexOf("'--cd'") < argsLineOf(nestedSet.text).indexOf("'-e'"),
    argsLineOf(nestedSet.text))
  check('the next sibling entry is untouched',
    nestedSet.text.includes('        args: [ "not", "ours" ]'), nestedSet.text)

  // A deeper list inside the row must NOT cut the block short before its `args:` line.
  const deeperList = [
    '  - id: terminal-controller',
    '    config:',
    '      shell:',
    '        path: wsl.exe',
    '        name: WSL',
    '        shellAliases:',
    '          - bash',
    "        args: [ '-e', 'bash' ]",
    '',
  ].join('\n')
  eq('a deeper list inside the row does not hide its args line',
    writeTerminalCwd(deeperList, '/mnt/d/x').ok, true)

  // The schema builder has to be PICKED, not destructured: the real namespace of
  // `@deepseek-ai/schemastery` is `{ default: Schema }`, so `{ Schema }` is
  // undefined, `Config` silently becomes undefined, the platform has no schema to
  // project, and the sidebar panel renders without a single switch while the tools
  // keep working. Measured in the field; these pin the picking.
  console.log('\nschema builder interop')
  const fakeSchema = { object: () => ({}) }
  eq('the builder is found on the default export', pickSchemaBuilder({ default: fakeSchema }), fakeSchema)
  eq('the builder is found as a named export', pickSchemaBuilder({ Schema: fakeSchema }), fakeSchema)
  eq('the builder is found on a Schema property of the default', pickSchemaBuilder({ default: { Schema: fakeSchema } }), fakeSchema)
  eq('a namespace without a builder is refused', pickSchemaBuilder({ default: {} }), null)
  eq('a namespace carrying the wrong shape is refused', pickSchemaBuilder({ default: { object: 'not a function' } }), null)
  eq('junk is refused instead of throwing', pickSchemaBuilder(null), null)
  const profileModules = process.env.DSH_WSL_SCHEMA_ROOT ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
  const realSchemaEntry = join(profileModules, '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
  if (existsSync(realSchemaEntry)) {
    const real = await import(pathToFileURL(realSchemaEntry).href)
    eq('the real package really hides the builder under default', real.Schema, undefined)
    const builder = pickSchemaBuilder(real)
    const built = builder.object({
      tools: builder.object({ wsl: builder.boolean().default(true) }),
      timeoutMs: builder.number().default(0),
    })
    eq('the real builder builds a schema that fills in defaults',
      JSON.stringify(built({})), '{"tools":{"wsl":true},"timeoutMs":0}')
    // The plugin's own Config must declare the auto-install switch, default ON and volatile
    // (every switch is volatile or the settings form never appears). A volatile field comes back
    // as a cosmokit cell, not a plain value, so read it the way the host does.
    const pluginSchema = buildConfig(builder)
    if (pluginSchema !== undefined) {
      const resolvedSchema = pluginSchema({})
      const switchValue = resolvedSchema?.autoInstallShim
      const switchOn = switchValue !== null && typeof switchValue === 'object'
        && typeof switchValue.get === 'function' ? switchValue.get() : switchValue
      eq('the config schema defaults auto-installing the dsh shim on', switchOn, true)
      check('and that switch is volatile like the rest of the panel',
        switchValue !== null && typeof switchValue === 'object' && typeof switchValue.get === 'function',
        typeof switchValue)
    } else {
      console.log('  skip  the repo Config schema could not be built with the real builder')
    }
  } else {
    console.log(`  skip  real schemastery not reachable at ${realSchemaEntry}`)
  }

  // The settings projection keeps ONLY volatile fields, so a schema without them
  // contributes no form at all: the entry never reaches `ctx.settings.describe()`,
  // its namespace is never served, and the sidebar panel waits forever for a scope
  // that will not come (measured). This is the check that catches it, run against
  // the INSTALLED copy, where the dependency actually resolves.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const repoVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  const installedDir = join(profileModules, 'dsh-wsl')
  const installedEntry = join(installedDir, 'index.js')
  if (!existsSync(installedEntry)) {
    console.log(`  skip  installed copy not found at ${installedEntry}`)
  } else {
    const installedVersion = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version
    if (installedVersion !== repoVersion) {
      console.log(`  skip  installed copy is ${installedVersion}, this checkout is ${repoVersion} - run \`npm run sync\``)
    } else {
      const installed = await import(pathToFileURL(installedEntry).href)
      const schema = installed.Config
      // A schemastery schema is callable, so it is a function, not a plain object.
      check(
        'the installed plugin declares a schema',
        schema !== undefined && (typeof schema === 'object' || typeof schema === 'function'),
        typeof schema,
      )
      const leaves = []
      const walkSchema = (node, path) => {
        if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return
        if (node.type === 'object' && node.dict !== undefined) {
          for (const [key, child] of Object.entries(node.dict)) walkSchema(child, [...path, key])
          return
        }
        leaves.push({ path: path.join('.'), volatile: node.meta?.volatile === true })
      }
      if (schema !== undefined && schema !== null) walkSchema(schema, [])
      check('the installed schema carries the switches', leaves.length >= 7, String(leaves.length))
      const notVolatile = leaves.filter((leaf) => !leaf.volatile).map((leaf) => leaf.path)
      check(
        'every switch is volatile (a plain schema contributes no form at all)',
        notVolatile.length === 0,
        notVolatile.join(', '),
      )

      // A volatile field is a cosmokit CELL at runtime, not the value: the resolved
      // config a host hands `apply` looks like `{ dangerGuard: Cell(false) }`, and
      // reading it without `.get()` silently keeps the default, so a switch would
      // light up and do nothing. `lib/config.js` unwraps it; this pins that.
      const resolved = installed.Config({ dangerGuard: false, translatePaths: false, tools: { wsl: false } })
      check(
        'a resolved volatile field really is a cell',
        resolved !== null && typeof resolved === 'object'
          && typeof resolved.dangerGuard?.get === 'function',
        typeof resolved?.dangerGuard,
      )
      const liveConfig = resolveConfig({}, resolved)
      eq('the plugin reads a real resolved volatile switch', liveConfig.dangerGuard, false)
      eq('the plugin reads a real nested volatile switch', liveConfig.tools.wsl, false)
      eq('the plugin reads the third real volatile switch', liveConfig.translatePaths, false)
      const channelResolved = installed.Config({ channelEnabled: true, channelSession: 'session-x' })
      const channelConfig = resolveConfig({}, channelResolved)
      eq('the channel switch reaches the resolved config', channelConfig.channelEnabled, true)
      eq('the channel session id reaches the resolved config', channelConfig.channelSession, 'session-x')
    }
  }

  console.log('\ndestructive guard')
  const bad = destructiveReason
  // A redirect at command position 0 has no preceding character: requiring one let
  // `> /dev/sda` through while ` > /dev/sda` was caught.
  for (const command of ['> /dev/sda', '>/dev/sda', ' > /dev/sda', 'echo x > /dev/sda', 'cat a >> /dev/nvme0n1']) {
    check(`a redirect onto a block device is caught: ${command}`,
      bad(command) !== null, String(bad(command)))
  }
  check('and a normal redirect is not', bad('echo x > /tmp/log') === null, String(bad('echo x > /tmp/log')))
  for (const command of [
    'rm -rf /tmp/x',
    'rm -fr /tmp/x',
    'rm -r -f /tmp/x',
    'rm -f -r /tmp/x',
    'rm -R --force /tmp/x',
    'rm --recursive --force /tmp/x',
    'rm -r somedir',
    'rm --recursive somedir',
    'rm -R somedir',
    'sudo rm -r -f /tmp/x',
    'rm /tmp/x -rf',
    'bash -c "rm -rf /"',
    'xargs rm -rf',
    'find . -exec rm -rf {} +',
    'rm$IFS-rf /tmp/x',
    'rm${IFS}-rf /tmp/x',
    '\\rm -rf /tmp/x',
    '$(which rm) -rf /tmp/x',
    // Each invocation is judged on its own segment: -f on the first and -r on
    // the second must not combine into a pass, and -r alone must not pass.
    'rm a -f; rm b -r',
    'rm /tmp/x -f; rm /tmp/y -r',
    'rm a --force; rm b -r',
    'rm a -f; rm b --recursive',
    'rm a -f && rm b -r',
    'rm a -f | rm b -r',
    'sudo reboot',
    'systemctl reboot',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1',
    'wipefs -a /dev/sdb',
    'shutdown -h now',
    'echo x > /dev/sda',
    ':(){ :|:& };:',
    // Wrappers put the real command after their own option VALUES. `commandWord` skipped the
    // wrapper and its flags but stopped on the value (`root`, `19`, `5`), so the tool that
    // followed was never judged at all — every one of these was ALLOWED before the fix.
    'sudo -u root mkfs.ext4 /dev/sdb1',
    'sudo -u root shutdown -h now',
    'sudo --user root poweroff',
    'nice -n 19 reboot',
    'timeout 5 reboot',
    'xargs -I{} poweroff',
    'xargs -0 rm -rf /tmp/x',
    'sh -c "reboot"',
    'bash -c "mkfs.ext4 /dev/sdb1"',
    // `-i` is a flag, not a value option: skipping its "value" would hide the command after it.
    'sudo -i reboot',
    // Destructive forms the tables did not list at all.
    'find / -delete',
    'find . -name "*.o" -delete',
    'truncate -s0 /dev/sda',
    'mke2fs /dev/sda',
    'git clean -fdx',
    'git clean -fd',
    'git clean --force',
    'echo x > /dev/mapper/vg-lv',
    'echo x >> /dev/dm-0',
  ]) {
    check(`refuses ${JSON.stringify(command)}`, bad(command) !== null, `reason: ${bad(command)}`)
  }
  for (const command of [
    'echo hello',
    'rm file.txt',
    'rm -f file.txt',
    'rm --force file.txt',
    'rm a -f; rm -f b',
    'dd if=/dev/zero of=/tmp/file bs=1M count=1',
    'ls /dev/sda',
    'mkfsdir=/tmp/x',
    'echo rebooted',
    'grep -r foo .',
    'rmdir -rf somedir',
    'alarm -rf x',
    'echo rm',
    "grep 'a\\rm' file",
    'echo "remove the file"',
    // Command-position matching: a keyword as an ARGUMENT is not an invocation.
    'man fdisk',
    'apt-cache show fdisk',
    'grep -rn reboot /var/log/syslog',
    'journalctl -u systemd-logind | grep -i shutdown',
    'echo "the mkfs tool formats disks"',
    'echo reboot',
    'echo "reboot" > /tmp/note.txt',
    'systemctl status ssh',
    'fdisk-preview --help',
    // Quoted text that MENTIONS a destructive command is not one. Blanking literal quoted spans
    // is what stops these from costing the caller an `allowDangerous` — all five were refused.
    'grep -rn "rm -rf" docs/',
    'git commit -m "fix rm -r"',
    'echo "rm -rf node_modules"',
    'npm rm -r foo',
    'ls rm -r',
    // A `git clean` that only reports, and a truncate that is not aimed at a device.
    'git clean -n',
    'git clean --dry-run',
    'truncate -s0 /tmp/big.log',
    'find . -name "*.tmp"',
    // The duration is an operand, not the command.
    'timeout 5 echo reboot',
    'man mkfs.ext4',
  ]) {
    check(`allows ${JSON.stringify(command)}`, bad(command) === null, `reason: ${bad(command)}`)
  }

  console.log('\nstderr cleaning and exit codes')
  const clean = cleanStderr
  const noisy = [
    'wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。',
    'your 131072x1 screen size is bogus. expect trouble',
    'real output',
  ].join('\n')
  eq('noise lines are dropped', clean(noisy), 'real output')
  eq('exit code sentinel normalizes', normalizeExitCode(0xFFFFFFFF), -1)
  eq('normal exit code is preserved', normalizeExitCode(7), 7)

  console.log('\nvalidation and configuration')
  check('distro rejects shell syntax', (() => {
    try { resolveDistro('a; rm -rf /', CONFIG); return false } catch { return true }
  })())
  eq('no configured distro means the system default', resolveDistro(undefined, CONFIG), null)
  eq('an argument wins over configuration', resolveDistro('Debian', CONFIG), 'Debian')

  const defaults = resolveConfig({})
  eq('command timeout default', defaults.commandTimeoutMs, 600_000)
  eq('output window default', defaults.maxOutputBytes, 65_536)
  eq('environment overrides the deadline', resolveConfig({ DSH_WSL_TIMEOUT_MS: '5000' }).commandTimeoutMs, 5_000)
  eq('environment overrides the window', resolveConfig({ DSH_WSL_MAX_OUTPUT_BYTES: '4096' }).maxOutputBytes, 4_096)
  eq('DSH_WSL_DISTRO pins a distro', resolveConfig({ DSH_WSL_DISTRO: ' Debian ' }).distro, 'Debian')
  eq('a blank DSH_WSL_DISTRO means the system default', resolveConfig({ DSH_WSL_DISTRO: '   ' }).distro, null)
  // Was "the default workdir is the Linux home": follow-session is ON by default now,
  // so the untouched default is the session's own directory (null reads as the process
  // cwd), and `~` is what the layer below says when the switch is off. The old
  // expectation still holds for that layer, which is asserted further down.
  eq('the default workdir follows the session', resolveConfig({}).defaultWorkdir, null)
  eq('the default workdir is the Linux home when follow-session is off',
    resolveConfig({}, { startInSessionWorkspace: false }).defaultWorkdir, '~')
  // The plugin's own configuration (written by the sidebar panel) is the most
  // specific layer, but a switch left at its default must let the environment
  // through: a user who never opened the panel still gets DSH_WSL_WORKDIR.
  eq('a panel switch beats the environment for the workdir',
    resolveConfig({ DSH_WSL_WORKDIR: 'home' }, { startInSessionWorkspace: true }).defaultWorkdir, null)
  eq('an untouched switch leaves DSH_WSL_WORKDIR in charge',
    resolveConfig({ DSH_WSL_WORKDIR: 'session' }, { startInSessionWorkspace: false }).defaultWorkdir, null)
  eq('a panel distro beats DSH_WSL_DISTRO',
    resolveConfig({ DSH_WSL_DISTRO: 'Debian' }, { distro: 'Ubuntu-22.04' }).distro, 'Ubuntu-22.04')
  eq('a blank panel distro falls back to the environment',
    resolveConfig({ DSH_WSL_DISTRO: 'Debian' }, { distro: '  ' }).distro, 'Debian')
  eq('a panel timeout beats DSH_WSL_TIMEOUT_MS',
    resolveConfig({ DSH_WSL_TIMEOUT_MS: '5000' }, { timeoutMs: 60_000 }).commandTimeoutMs, 60_000)
  eq('a zero panel timeout means "not configured"',
    resolveConfig({ DSH_WSL_TIMEOUT_MS: '5000' }, { timeoutMs: 0 }).commandTimeoutMs, 5_000)
  eq('switches default to on', resolveConfig({}, {}).dangerGuard, true)
eq('the channel is off by default', resolveConfig({}, {}).channelEnabled, false)
eq('the channel session defaults to unset', resolveConfig({}, {}).channelSession, '')
  eq('a non-boolean switch falls back instead of failing the mount',
    resolveConfig({}, { backgroundJobs: 'no' }).backgroundJobs, true)
  // The installer must NOT be mounted without a decision: it adds software. Its default
  // is asserted here rather than left to the schema's word. `wsl-term` has no switch at
  // all — opening a terminal in the sidebar is the consent it needs — so it is not in
  // this object and cannot be switched off.
  eq('the tool switches default to the read-only and file tools on; the diagnostics and installer are opt-in',
    Object.values(resolveConfig({}, {}).tools).join(','), 'true,true,true,false,false,true,true,true,true')
  check('and the terminal tool has no switch of its own',
    resolveConfig({}, {}).tools.term === undefined
    && resolveConfig({}, { tools: { term: false } }).tools.term === undefined)
  eq('and root execution is off by default', resolveConfig({}, {}).allowRoot, false)
  eq('a partial tools object leaves the other switches alone',
    resolveConfig({}, { tools: { env: false } }).tools.env, false)
  // The environment layer is only reachable with follow-session switched off: it is ON
  // by default now, and these two magic words describe the layer beneath it.
  eq('workdir "home" spells the tilde',
    resolveConfig({ DSH_WSL_WORKDIR: 'home' }, { startInSessionWorkspace: false }).defaultWorkdir, '~')
  eq('workdir "session" means the process cwd',
    resolveConfig({ DSH_WSL_WORKDIR: 'session' }, { startInSessionWorkspace: false }).defaultWorkdir, null)
  eq('any other workdir is an explicit default path',
    resolveConfig({ DSH_WSL_WORKDIR: 'D:\\proj' }, { startInSessionWorkspace: false }).defaultWorkdir, 'D:\\proj')
  // The contract that replaced it: follow-session is the default, an explicitly
  // configured Linux directory outranks it, and the switch still works both ways.
  eq('follow-session is on by default', resolveConfig({}, {}).defaultWorkdir, null)
  eq('the follow-session switch reports its default',
    resolveConfig({}, {}).startInSessionWorkspace, true)
  eq('a configured Linux directory wins over follow-session',
    resolveConfig({}, { workdir: '/mnt/d/proj' }).defaultWorkdir, '/mnt/d/proj')
  eq('turning follow-session off with nothing configured falls back to home',
    resolveConfig({}, { startInSessionWorkspace: false }).defaultWorkdir, '~')
  eq('an empty configured directory still follows the session',
    resolveConfig({}, { workdir: '   ' }).defaultWorkdir, null)

  // A per-call deadline is capped like the platform shell tools cap theirs.
  eq('the timeout ceiling has a default', resolveConfig({}).maxCommandTimeoutMs, 86_400_000)
  eq('DSH_WSL_MAX_TIMEOUT_MS overrides the ceiling', resolveConfig({ DSH_WSL_MAX_TIMEOUT_MS: '60000' }).maxCommandTimeoutMs, 60_000)
  eq('a silly ceiling falls back', resolveConfig({ DSH_WSL_MAX_TIMEOUT_MS: '0' }).maxCommandTimeoutMs, 86_400_000)
  eq('the default deadline obeys the ceiling',
    resolveConfig({ DSH_WSL_TIMEOUT_MS: '90000000', DSH_WSL_MAX_TIMEOUT_MS: '60000' }).commandTimeoutMs, 60_000)

  // Host shell facts reach the Linux side, because WSL drops Windows env vars.
  // They are PER-EXECUTION — the session id cannot be a host constant, since one
  // host serves many sessions — so the source is the host's own shell-env
  // registry, which is also what the platform's shell tools read.
  const execution = { agent: { session: { header: { id: 'session-abc', cwd: 'D:\\work' } } } }
  eq('the session workspace comes from the execution', sessionCwdOf(execution), 'D:\\work')
  eq('a caller without a session yields nothing', sessionCwdOf(undefined), undefined)
  eq('a malformed session yields nothing', sessionCwdOf({ agent: { session: {} } }), undefined)
  eq('an empty session cwd yields nothing', sessionCwdOf({ agent: { session: { header: { cwd: '' } } } }), undefined)

  const shellEnvCtx = {
    get: (name) => (name === 'shellEnv'
      ? {
        collect: (exec) => ({
          DSH_SESSION_ID: exec?.agent?.session?.header?.id,
          DSH_SHELL: '1',
          DSH_HOME: 'C:\\Users\\me\\.dsh',
          DSH_WEB_URL: 'http://127.0.0.1:3080',
        }),
      }
      : undefined),
  }
  const forwarded = collectForwardEnv(shellEnvCtx, execution)
  eq('the session id is taken from the execution', forwarded.DSH_SESSION_ID, 'session-abc')
  eq('DSH_SHELL is forwarded', forwarded.DSH_SHELL, '1')
  eq('DSH_HOME is forwarded as its /mnt view', forwarded.DSH_HOME, '/mnt/c/Users/me/.dsh')
  check('DSH_WEB_URL is NOT forwarded (unreachable from WSL in NAT mode)',
    !('DSH_WEB_URL' in forwarded), JSON.stringify(forwarded))
  // The fallback must stay narrow: whatever the ambient environment happens to
  // hold, only allowlisted keys may be forwarded, and DSH_WEB_URL never is.
  const noRegistry = collectForwardEnv({ get: () => undefined }, {})
  check('the process.env fallback forwards only allowlisted keys',
    Object.keys(noRegistry).every((key) => ['DSH_SESSION_ID', 'DSH_SHELL', 'DSH_HOME'].includes(key)),
    JSON.stringify(noRegistry))
  check('DSH_WEB_URL is never forwarded, registry or not', !('DSH_WEB_URL' in noRegistry), JSON.stringify(noRegistry))
  check('a throwing registry is contained rather than fatal', (() => {
    try {
      collectForwardEnv({ get: () => ({ collect() { throw new Error('boom') } }) }, execution)
      return true
    } catch {
      return false
    }
  })())
  // A typo must not take the tools down, and must not yield an absurd value.
  eq('unparsable timeout falls back', resolveConfig({ DSH_WSL_TIMEOUT_MS: 'soon' }).commandTimeoutMs, 600_000)
  eq('zero timeout falls back', resolveConfig({ DSH_WSL_TIMEOUT_MS: '0' }).commandTimeoutMs, 600_000)
  eq('oversized window falls back', resolveConfig({ DSH_WSL_MAX_OUTPUT_BYTES: '999999999999' }).maxOutputBytes, 65_536)
  check('the spill ceiling never trails the window',
    resolveConfig({ DSH_WSL_MAX_OUTPUT_BYTES: '4194304' }).maxSpillBytes >= 4_194_304)

  console.log('\nlauncher errors')
  const launcherFailure = (stderr, exitCode = -1) => ({ exitCode, stdout: '', stderr })
  check('a healthy run raises nothing', (() => {
    try { assertLauncherReachable('Ubuntu', { exitCode: 0, stdout: '', stderr: '' }); return true } catch { return false }
  })())
  check('a missing distro is reported by name', (() => {
    try {
      assertLauncherReachable('Debian', launcherFailure('错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'))
      return false
    } catch (error) {
      return /Debian/.test(error.message) && /not registered/.test(error.message)
    }
  })())
  check('any other launcher failure is surfaced, not swallowed', (() => {
    try {
      assertLauncherReachable('Ubuntu', launcherFailure('错误代码: Wsl/Service/WSL_E_WSL2_REQUIRED'))
      return false
    } catch (error) {
      return /WSL_E_WSL2_REQUIRED/.test(error.message)
    }
  })())
  check('an ordinary command failure is left alone', (() => {
    try { assertLauncherReachable('Ubuntu', launcherFailure('ls: cannot access x', 2)); return true } catch { return false }
  })())
  eq('the default distro is read from the -l -v marker',
    parseDefaultDistro('  NAME   STATE   VERSION\n* Ubuntu-22.04  Running  2\n'), 'Ubuntu-22.04')
  eq('a default name containing one space is kept whole (columns are 2+ spaces)',
    parseDefaultDistro('  NAME   STATE   VERSION\n* Ubuntu 22.04    Running    2\n'), 'Ubuntu 22.04')
  eq('a tab-separated default row is read too',
    parseDefaultDistro('*\tUbuntu-22.04\tRunning\t2'), 'Ubuntu-22.04')
  eq('a list without a marker yields null', parseDefaultDistro('  NAME  STATE  VERSION'), null)

  console.log('\ncapability diagnostics')
  const facts = parseFacts('os=Ubuntu 22.04.5 LTS\nwsl=2\nnot a fact line\ninit=systemd\n\nbad key=x\n')
  eq('facts are parsed by the first =', facts.os, 'Ubuntu 22.04.5 LTS')
  eq('a later duplicate wins', parseFacts('a=1\na=2').a, '2')
  eq('lines without = are ignored', Object.keys(facts).includes('not a fact line'), false)
  eq('a key with a space is not a fact', 'bad key' in facts, false)

  const rich = capabilityLines({
    os: 'Ubuntu 22.04.5 LTS', wsl: '2', init: 'systemd', cgroup: 'cgroup2fs',
    gpu: 'dxg', nvidia: 'GPU 0: RTX 5070', docker: '27.0.3', drives: 'c,d,',
    wslconf: '[boot] systemd=true;', winconf: '',
  })
  check('WSL2 is reported', rich[0].includes('WSL2') && rich[0].includes('Ubuntu 22.04.5 LTS'), rich[0])
  check('cgroup v2 is named', rich[0].includes('cgroup v2'), rich[0])
  check('systemd is reported', rich.some((l) => l.includes('systemd: yes')), rich.join(' | '))
  check('a running docker daemon is reported', rich.some((l) => l.includes('docker: daemon 27.0.3')), rich.join(' | '))
  check('GPU passthrough is reported', rich.some((l) => l.includes('/dev/dxg present') && l.includes('RTX 5070')), rich.join(' | '))
  check('the GPU UUID is dropped as noise',
    !capabilityLines({ nvidia: 'GPU 0: RTX 5070 (UUID: GPU-abc)' }).some((l) => l.includes('UUID')), 'no UUID')
  check('drives are listed as /mnt paths', rich.some((l) => l === 'drives: /mnt/c /mnt/d'), rich.join(' | '))
  check('the config line carries /etc/wsl.conf', rich.some((l) => l.includes('/etc/wsl.conf: [boot] systemd=true;')), rich.join(' | '))
  // An EMPTY probe value means "read it, nothing there"; a MISSING key means the
  // probe never reported, and only the first deserves a verdict.
  check('an unset .wslconfig is stated, not omitted', rich.some((l) => l.includes('.wslconfig: not set')), rich.join(' | '))
  check('a config fact the probe never reported is omitted',
    !capabilityLines({ wslconf: '[boot] systemd=true;' }).some((l) => l.includes('.wslconfig')), 'omitted')

  const withWinconf = capabilityLines({ winconf: '[wsl2] networkingMode=mirrored;' })
  check('a configured .wslconfig is shown', withWinconf.some((l) => l.includes('networkingMode=mirrored')), withWinconf.join(' | '))

  const bare = capabilityLines({})
  eq('an unreadable probe contributes nothing rather than guessing', bare.length, 0)
  const wsl1 = capabilityLines({ wsl: '1', init: 'init', docker: 'absent', gpu: 'none' })
  check('WSL1 is called out', wsl1[0].includes('WSL1'), wsl1[0])
  check('a missing docker is stated', wsl1.some((l) => l.includes('docker: not installed')), wsl1.join(' | '))
  check('a missing GPU is stated', wsl1.some((l) => l.includes('no /dev/dxg')), wsl1.join(' | '))
  check('a non-systemd init names the real PID 1', wsl1.some((l) => l.includes('systemd: no (PID 1 is init)')), wsl1.join(' | '))
  check('a cli-only docker is distinguished from a working daemon',
    capabilityLines({ docker: 'cli-only' }).some((l) => l.includes('daemon unreachable')), 'cli-only')

  // `wsl --version` labels are localized, so nothing may be parsed by name: the
  // first three lines are WSL/kernel/WSLg in a fixed order.
  const localized = launcherSummary('WSL 版本: 2.6.3.0\n内核版本: 6.6.87.2-1\nWSLg 版本: 1.0.71\nMSRDC 版本: 1.2.6353\nDirect3D 版本: 1.611.1-81528511\nWindows: 10.0.26200.9457\n')
  check('the launcher line survives localized labels', localized.includes('WSL 版本: 2.6.3.0') && localized.includes('1.0.71'), localized)
  check('the Windows build line is kept', localized.includes('Windows: 10.0.26200.9457'), localized)
  check('Direct3D/MSRDC noise is dropped', !/Direct3D|MSRDC/.test(localized), localized)
  eq('an unparsable launcher output yields null', launcherSummary('no table here'), null)

  const empty = streamFacts(undefined)
  eq('missing stream is empty', empty.text, '')
  eq('missing stream is not lossy', empty.lossy, false)

  console.log('\nworkspace placement hint')
  const onWindowsMount = workspaceLine('D:\\DSHworkarea')
  check('a Windows-mount workspace is named with its mount',
    onWindowsMount.includes('workspace: /mnt/d/DSHworkarea') && onWindowsMount.includes('/mnt/d'), onWindowsMount)
  check('and it warns about the cost of building there', /much slower/.test(onWindowsMount), onWindowsMount)
  const onLinuxFs = workspaceLine('/home/xiny/proj')
  check('a Linux-filesystem workspace says so plainly',
    onLinuxFs === 'workspace: /home/xiny/proj (Linux filesystem)', onLinuxFs)
  eq('an inexpressible directory yields no line', workspaceLine(''), null)

  // ------------------------------------------------------------------ doctor
  console.log('\nproject-against-distribution report (wsl-doctor)')
  // A distribution that has python but no node — and whose `npm` is the Windows
  // one, which is the failure this tool exists to name.
  const doctorFacts = parseProbe(DOCTOR_PROBE_TEXT)
  eq('the probe parses into facts', doctorFacts['cmd.npm'], 'interop:/mnt/c/Program Files/nodejs/npm')
  eq('the manifests and packageManager decide what is needed',
    needsFromFacts(doctorFacts).map((need) => need.command).join(','), 'node,npm,pnpm')
  eq('a found Linux command is usable', commandState(doctorFacts, 'git').state, 'linux')
  eq('a /mnt command is called out as a Windows binary', commandState(doctorFacts, 'npm').state, 'interop')
  eq('an absent command is missing', commandState(doctorFacts, 'pnpm').state, 'missing')
  eq('suggestions map commands onto recipes', suggestionRecipes(['node', 'pnpm']).join(','), 'node,pnpm')
  eq('python maps to its own recipe', suggestionRecipes(['python3', 'pip3']).join(','), 'python')
  // Tool output has no common shape, so one extractor has to read all of them.
  eq('a v-prefixed version', versionToken('v24.11.0'), '24.11.0')
  eq('a named version', versionToken('Python 3.10.12'), '3.10.12')
  eq('a verbose one', versionToken('gcc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0'), '11.4.0')
  eq('a sentence', versionToken('git version 2.34.1'), '2.34.1')
  eq('a docker one', versionToken('Docker version 24.0.7, build 24.0.7-0ubuntu2~22.04.1'), '24.0.7')
  eq('and nothing yields null', versionToken(''), null)

  const report = composeDoctorReport(doctorFacts, {
    workspaceLine: 'workspace: /mnt/d/proj (Windows drive mount /mnt/d)',
    bootstrapAvailable: true,
    rootEnabled: false,
    rootProbe: null,
  })
  check('the report names the missing tool', report.includes('MISSING node'), report)
  check('and the Windows binary behind a found npm',
    /WINDOWS npm — resolves to \/mnt\/c\/Program Files\/nodejs\/npm/.test(report), report)
  check('it separates usable tools from blocked ones',
    report.includes('usable on the Linux side: python3') && report.includes('python3 3.10.12'), report)
  check('it states the privilege situation', report.includes('sudo: requires a password'), report)
  check('it says root is switched off rather than guessing', report.includes('root: switched off'), report)
  check('and it names the next step with the recipes to use',
    report.includes('wsl-bootstrap({ recipes: ["node", "pnpm"] })'), report)
  const reportNoBootstrap = composeDoctorReport(doctorFacts, {
    workspaceLine: '', bootstrapAvailable: false, rootEnabled: false, rootProbe: null,
  })
  check('without the installer mounted it points at the panel switch instead',
    reportNoBootstrap.includes('安装工具链'), reportNoBootstrap)
  const reportRoot = composeDoctorReport(doctorFacts, {
    workspaceLine: '', bootstrapAvailable: true, rootEnabled: true, rootProbe: 'available',
  })
  check('with root switched on the measured verdict is reported',
    reportRoot.includes('root: available through `wsl -u root`'), reportRoot)
  const emptyReport = composeDoctorReport(
    parseProbe('user.uid=0'),
    { workspaceLine: '', bootstrapAvailable: true, rootEnabled: false, rootProbe: null },
  )
  check('a directory with no manifest says so instead of inventing needs',
    emptyReport.includes('no manifest found'), emptyReport)

  // --------------------------------------------------------------- bootstrap
  console.log('\ninstaller plan (wsl-bootstrap)')
  eq('every recipe id is offered to the schema', RECIPE_IDS.join(','), 'node,pnpm,python,build,tools')
  eq('pnpm pulls in its runtime', resolveRecipes(['pnpm'], { curl: true }).join(','), 'node,pnpm')
  eq('node without curl pulls in the apt tools recipe',
    resolveRecipes(['node'], { curl: false }).join(','), 'node,tools')
  eq('and with curl it does not', resolveRecipes(['node'], { curl: true }).join(','), 'node')
  check('an unknown recipe is refused',
    (() => {
      try { resolveRecipes(['nope'], {}) ; return 'no error' } catch (error) { return error.message }
    })().includes('unknown recipe "nope"'), '')
  check('and the refusal lists the valid recipes',
    (() => {
      try { resolveRecipes(['nope'], {}) } catch (error) { return error.message.includes('node, pnpm, python, build, tools') }
      return false
    })(), '')

  const presence = parsePresence(['have.node=0', 'have.pnpm=0', 'have.python3=1', 'have.pip3=1', 'have.gcc=1', 'have.make=1', 'have.jq=0'].join('\n'))
  eq('presence parsing reads a hit', presence.python3, true)
  eq('and a miss', presence.node, false)
  check('the presence probe asks about every recipe command',
    presenceProbe().includes('command -v node') && presenceProbe().includes('command -v jq'), presenceProbe())

  const plan = planFor(['node', 'python', 'build'], presence)
  eq('a satisfied recipe is skipped', plan.skipped.map((entry) => entry.id).join(','), 'python,build')
  eq('the unsatisfied one becomes a step', plan.steps.map((step) => step.id).join(','), 'node')
  eq('and it runs as root', plan.steps[0].root, true)
  check('the plan shows the real commands', plan.steps[0].command.includes('nodejs.org/dist'), plan.steps[0].command)

  const aptPlan = planFor(['python', 'build', 'tools'], {})
  eq('every apt recipe collapses into ONE step', aptPlan.steps.length, 1)
  check('with the packages merged',
    aptPlan.steps[0].command.includes(
      'apt-get install -y build-essential ca-certificates curl git jq python3 python3-pip python3-venv rsync',
    ),
    aptPlan.steps[0].command)
  eq('and a read-only simulation of the same step',
    aptPlan.steps[0].simulate.startsWith('apt-get -s install -y '), true)
  check('the simulation cannot mutate', !aptPlan.steps[0].simulate.includes('apt-get update'), aptPlan.steps[0].simulate)

  const dryText = renderPlan({ recipes: ['node'], ...plan }, { distro: 'Ubuntu-22.04', simulation: 'Inst python3 (simulated)' })
  check('the dry run says nothing was installed',
    dryText.startsWith('dry run — nothing has been installed'), dryText.slice(0, 80))
  check('it names the distro', dryText.includes('Ubuntu-22.04'), dryText)
  check('it shows the simulation', dryText.includes('Inst python3 (simulated)'), dryText)
  check('and it tells the caller how to really install', dryText.includes('dryRun: false'), dryText)
  check('a plan with nothing to do says so',
    renderPlan({ recipes: ['python'], skipped: [{ id: 'python', what: 'python3' }], steps: [] }, {})
      .includes('nothing to install'), '')
  const outcome = renderOutcome([
    { id: 'node', what: 'Node.js', ok: true, exitCode: 0, output: 'installed: v24.0.0' },
    { id: 'python', what: 'python3', ok: false, exitCode: 100, output: 'first line\nE: Unable to locate package' },
  ])
  check('a successful step is reported ok', outcome.includes('[node] Node.js: ok'), outcome)
  check('a failed step carries the tail of its output',
    outcome.includes('FAILED (exit code 100)') && outcome.includes('Unable to locate package'), outcome)
  check('and the outcome explains the stop', outcome.includes('stopped at the first failure'), outcome)
  check('tailOf keeps the end', tailOf(`${'a'.repeat(10)}END`, 5).endsWith('END'), tailOf(`${'a'.repeat(10)}END`, 5))
  check('the install timeout is generous but finite', BOOTSTRAP_TIMEOUT_MS === 10 * 60 * 1000, String(BOOTSTRAP_TIMEOUT_MS))
}

// --- wsl-edit: the hunks behind the diff card ------------------------------

async function hunkUnitTests() {
  console.log('\nwsl-edit: hunk computation')

  const ten = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
  const one = computeHunks('p', ten, [ten.indexOf('line 5')], 'line 5', 'LINE FIVE')
  eq('one replacement is one hunk', one.length, 1)
  eq('the hunk keeps three lines of context each side', one[0].oldText.split('\n').filter(Boolean).length, 7)
  check('the hunk carries the change',
    one[0].newText.includes('LINE FIVE') && !one[0].newText.includes('line 5'), one[0].newText)
  eq('the hunk labels the file', one[0].path, 'p')
  eq('the context width is the platform\'s', HUNK_CONTEXT, 3)

  // Two replacements whose context overlaps are one card, not two overlapping ones.
  const near = computeHunks('p', ten, [ten.indexOf('line 4'), ten.indexOf('line 6')], 'line', 'LINE')
  eq('two nearby replacements merge into one hunk', near.length, 1)
  eq('a merged hunk applies both', (near[0].newText.match(/LINE/g) ?? []).length, 2)

  const twenty = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
  const far = computeHunks('p', twenty, [twenty.indexOf('line 2'), twenty.indexOf('line 18')], 'line', 'LINE')
  eq('two distant replacements stay separate', far.length, 2)

  // A replacement that spans lines still yields line-aligned hunks.
  const multiline = computeHunks('p', ten, [ten.indexOf('line 3\nline 4')], 'line 3\nline 4', 'merged')
  check('a multi-line replacement starts and ends on line boundaries',
    multiline[0].oldText.startsWith('line 1\n') && multiline[0].oldText.endsWith('line 7\n'), multiline[0].oldText)
  check('and its new text is the same window with the change',
    multiline[0].newText.startsWith('line 1\n') && multiline[0].newText.includes('merged'), multiline[0].newText)

  // A replacement that changes the byte length shifts every later line in the window.
  const grow = computeHunks('p', ten, [ten.indexOf('line 5')], 'line 5', 'line FIVE!')
  check('a longer replacement keeps the tail of the hunk', grow[0].newText.endsWith('line 7\nline 8\n'), grow[0].newText)
  const shrink = computeHunks('p', ten, [ten.indexOf('line 5')], 'line 5', '5')
  check('a shorter replacement keeps the tail of the hunk', shrink[0].newText.endsWith('line 7\nline 8\n'), shrink[0].newText)

  eq('no offsets means no hunks', computeHunks('p', ten, [], 'x', 'y').length, 0)

  const head = computeHunks('p', ten, [0], 'line 1', 'LINE 1')
  check('a hunk at the top of the file is clamped, not padded', head[0].oldText.startsWith('line 1\n'), head[0].oldText)
  const tail = computeHunks('p', ten, [ten.indexOf('line 10')], 'line 10', 'LINE 10')
  check('a hunk at the bottom of the file is clamped too', tail[0].oldText.endsWith('line 10\n'), tail[0].oldText)
}

// --- wsl-term: the text work behind the terminal tool ----------------------

async function terminalUnitTests() {
  console.log('\nwsl-term: text and selection helpers')

  // A serialized xterm screen carries colors, cursor moves, an OSC title and the
  // CRLF a PTY emits; a caller wants none of that.
  const screen = '\u001b[?2004h\u001b]0;bash\u0007\u001b[1;32mxiny@host\u001b[0m:~/dir$ \u001b[Ke\u001b[1mcho hi\u001b[0m\r\nhi\r\n\u001b[?2004l'
  eq('stripAnsi removes CSI, OSC and CR', stripAnsi(screen), 'xiny@host:~/dir$ echo hi\nhi\n')
  eq('stripAnsi drops other control bytes', stripAnsi('a\u0007b\u0000c'), 'abc')
  eq('stripAnsi tolerates a non-string', stripAnsi(undefined), '')

  // The helper is what keeps the line the USER reads readable: one short call per command
  // instead of the markers spelled out around it.
  const definition = helperDefinition('session-c9ad')
  check('the definition carries the caller session so a self-targeting dsh can be refused',
    definition.includes("DSH_WSL_CALLER_SESSION='session-c9ad'")
    && definition.includes('unset DSH_WSL_CALLER_SESSION'), definition.slice(0, 220))
  check('the helper definition names the helper and both markers',
    definition.startsWith(`${HELPER_NAME}()`) && definition.includes(START_PREFIX) && definition.includes(END_PREFIX),
    definition.slice(0, 80))
  check('the helper is POSIX (no local, no $RANDOM)',
    !/\blocal\b/.test(definition) && !definition.includes('$RANDOM'), definition)
  check('the helper prints the exit code of the command, not of printf',
    definition.indexOf('eval "$2"') < definition.indexOf('__dsh_r=$?'), definition)

  eq('a call is one short readable line, carrying its nonce',
    helperCall('make syn', 'k3f9a2'), `${HELPER_NAME} k3f9a2 'make syn'`)
  eq('a single quote in the command is escaped, not broken',
    helperCall("echo it's fine", 'k3f9a2'), `${HELPER_NAME} k3f9a2 'echo it'\\''s fine'`)
  rejects('an empty command is refused before anything is typed', () => helperCall('   ', 'k3f9a2'), /non-empty command/)
  rejects('a two-line command is refused (it would be submitted early)',
    () => helperCall('echo a\necho b', 'k3f9a2'), /single command line/)
  rejects('a call without a nonce is refused', () => helperCall('ls', ''), /needs a nonce/)

  // The capture a real terminal produces — INCLUDING the echoed definition line, which itself
  // contains the marker prefixes. This is the case that took the first live run out: a parser
  // that searched for a bare prefix found the definition's echo and waited out its deadline.
  const echoedDefinition = `${HELPER_NAME}() { printf '${START_PREFIX}%s\\n' "$1"; eval "$2"; __dsh_r=$?; printf '${END_PREFIX}%s:%s\\n' "$1" "$__dsh_r"; }\r\n`
  const capture = stripAnsi([
    "\u001b[1;32m$ \u001b[0m", echoedDefinition,
    `xiny@host:~/dir$ ${HELPER_NAME} k3f9a2 'echo hi'\r`,
    `${START_PREFIX}k3f9a2\r\n`,
    'hi\r\n',
    `${END_PREFIX}k3f9a2:0\r\n`,
    'xiny@host:~/dir$ ',
  ].join(''))
  const extracted = extractHelperResult(capture, 'k3f9a2')
  check('the definition echo does not confuse the parser', extracted.complete, JSON.stringify(extracted.output?.slice(0, 40)))
  check('the command output is extracted between the helper markers', extracted.output === 'hi', JSON.stringify(extracted))
  eq('and its exit code is read from the end marker', extracted.exitCode, 0)
  check('the same capture stays incomplete for another call\'s nonce',
    extractHelperResult(capture, 'other1').complete === false)
  check('a capture without the end marker is incomplete',
    extractHelperResult(`${START_PREFIX}k3f9a2\r\nhi\r\n`, 'k3f9a2').complete === false)
  const failed = extractHelperResult(`${START_PREFIX}k3f9a2\nnope\n${END_PREFIX}k3f9a2:1\n`, 'k3f9a2')
  check('a non-zero exit code survives', failed.exitCode === 1 && failed.output === 'nope', JSON.stringify(failed))
  // Two calls in the same terminal: each nonce reads only its own region.
  const twoCalls = `${START_PREFIX}a1\naaa\n${END_PREFIX}a1:0\n${START_PREFIX}b2\nbbb\n${END_PREFIX}b2:3\n`
  check('a later call reads its own region',
    extractHelperResult(twoCalls, 'b2').output === 'bbb' && extractHelperResult(twoCalls, 'b2').exitCode === 3)
  check('an unrelated capture is not complete',
    extractHelperResult('xiny@host:~$ ls\nfile\n', 'k3f9a2').complete === false)

  // Readiness: a terminal created a moment ago is not ready to be typed into, and typing then
  // loses the write (measured live: the definition vanished and the command answered
  // "command not found").
  check('a shell prompt looks ready', looksReady('xiny@host:~$ '))
  check('a root prompt looks ready too', looksReady('root@host:/# '))
  check('a custom arrow prompt (zsh/starship) is recognised, so collaboration can type there',
    looksReady('~/proj → ') && looksReady('~/proj λ ') && looksReady('~/proj ❯ '))
  check('a shell that is still starting does not',
    looksReady('wsl: localhost proxy is not mirrored into WSL.\n') === false)
  check('an empty screen is not ready', looksReady('') === false && looksReady(undefined) === false)
  check('a command still running is not ready', looksReady('$ make -B syn\ncompiling foo.c\n') === false)
  check('the last non-empty line is what counts', looksReady('busy\nxiny@host:~$ ') === true)
  // The screen arrives as the emulator's own serialization, so its last line ends in an escape
  // sequence. Missing that made every later `run` in a tool-created terminal wait out its whole
  // deadline without typing — measured from a frame trace.
  check('a prompt with terminal escapes still looks ready',
    looksReady('\u001b[1;32mxiny@XINY9\u001b[0m:\u001b[1;34m/home\u001b[0m$ \u001b[K'))
  check('a prompt after OSC and CRLF looks ready',
    looksReady('\u001b]0;bash\u0007xiny@XINY9:/home$ \r\n'))
  // The gate that runs before every write only looks at the capture TAIL: the prompt is the last
  // non-empty line, and re-stripping megabytes of ANSI on every streamed frame is quadratic (a
  // 30 s busy wait measured ~2 s of CPU with the whole capture). The bound is what makes the
  // check O(1) in the capture's size, so it is asserted rather than assumed.
  const longCapture = `${'history line\n'.repeat(10_000)}xiny@host:~$ `
  const gated = readinessText('screen', longCapture)
  check('the readiness gate reads a bounded tail of the capture',
    gated.length < 2_100 && gated.endsWith('xiny@host:~$ '), String(gated.length))
  check('and the prompt in that tail is still seen as ready', looksReady(gated))
  check('a prompt that fell out of the tail is NOT claimed as ready (the bound is real)',
    looksReady(readinessText('', `xiny@host:~$ ${'\n'.repeat(3)}${'x'.repeat(5_000)}`)) === false)

  const one = { id: 'a', state: 'running', title: 'bash' }
  const two = { id: 'b', state: 'running', title: 'bash' }
  const dead = { id: 'c', state: 'exited', exitCode: 0, title: 'bash' }
  eq('an explicit id wins', pickTerminal([one, two], 'a')?.id, 'a')
  eq('an unknown explicit id finds nothing', pickTerminal([one, two], 'zz'), null)
  eq('with no id the newest running terminal is used', pickTerminal([one, dead, two], undefined)?.id, 'b')
  eq('an exited terminal is still the last resort', pickTerminal([dead], undefined)?.id, 'c')
  eq('no terminals at all picks nothing', pickTerminal([], undefined), null)
  eq('autoTerminalIds prefers the stable name', autoTerminalIds([])[0], 'dsh-agent')
  check('autoTerminalIds skips names already in use',
    autoTerminalIds([{ id: 'dsh-agent' }])[0] === 'dsh-agent-2', JSON.stringify(autoTerminalIds([{ id: 'dsh-agent' }])))
  check('the empty list explains how a terminal appears',
    renderTerminals([], undefined)[0].includes('can open one'), renderTerminals([], undefined)[0])
  const rendered = renderTerminals([{ id: 'x', state: 'running', title: 'WSL', shell: { name: 'bash' }, cwd: '/home/xiny', cols: 120, rows: 30 }], 'x').join('\n')
  check('the list names the terminal, its shell, workspace, size and provenance',
    rendered.includes('id=x') && rendered.includes('bash') && rendered.includes('/home/xiny') && rendered.includes('120x30') && rendered.includes('opened by this tool'), rendered)
  // Measured live: the controller reports the SESSION's workspace, which on Windows
  // is a Windows path the WSL shell cannot use — so it must not be printed as a
  // plain `cwd` that implies where the shell actually is.
  check('a Linux workspace is reported plainly',
    describeSessionCwd('/home/xiny') === 'session workspace: /home/xiny', describeSessionCwd('/home/xiny'))
  const windowsCwd = describeSessionCwd('D:\\DSHworkarea')
  check('a Windows workspace says whose directory it is and what the shell does with it',
    windowsCwd.startsWith('session workspace: D:\\DSHworkarea (') && windowsCwd.includes('/home/<user>'), windowsCwd)
  check('a missing workspace is still named', describeSessionCwd(undefined).includes('unknown'), describeSessionCwd(undefined))
  check('the opened-terminal note does not promise sidebar visibility',
    OPENED_TERMINAL_NOTE.includes('may not appear'), OPENED_TERMINAL_NOTE)
  check('a free keyboard is reported as free', inputLine({}).includes('free'), inputLine({}))
  check('another attachment is named as the input holder',
    inputLine({ controllerId: 'client-7' }).includes('client-7'), inputLine({ controllerId: 'client-7' }))

  // Measured need: a 60 492-character `make` output was clipped to its first 20 000
  // characters, which held the churn and none of the result. The tail is what a build
  // log is for, and the whole capture goes to a file.
  const short = 'ok'
  eq('short output passes through untouched', clipTail(short, 10), 'ok')
  const long = `${'head'.repeat(100)}THE-ANSWER`
  const clipped = clipTail(long, 20)
  check('a long capture keeps its END, where the answer is',
    clipped.endsWith('THE-ANSWER'), JSON.stringify(clipped.slice(-40)))
  check('and says how much it dropped', /clipped: \d+ earlier characters omitted/.test(clipped), clipped.slice(0, 80))
  check('a single dropped character is described in the singular',
    clipTail('abcdef', 5).includes('1 earlier character omitted'), clipTail('abcdef', 5).split('\n')[0])
  eq('no spill reference means no line', spillLine({}), '')
  eq('the spill line names the file, its size and the hint',
    spillLine({ locator: '/tmp/x.log', bytes: 12, retrievalHint: 'read it' }),
    'full output (12 bytes): /tmp/x.log — read it')
  eq('a spill line without size or hint still names the file',
    spillLine({ locator: '/tmp/x.log' }), 'full output: /tmp/x.log')
  // The tail must not begin on the low half of a surrogate pair: that is not text, and it
  // would reach the transcript as a lone surrogate.
  const clippedAstral = clipTail('🙂🙂🙂', 3)
  const startsClean = !(clippedAstral.charCodeAt(clippedAstral.indexOf('\n') + 1) >= 0xdc00
    && clippedAstral.charCodeAt(clippedAstral.indexOf('\n') + 1) <= 0xdfff)
  check('clipping never starts on half a character', startsClean, JSON.stringify(clippedAstral))
  // A chatty command needs a bounded capture, and the frame must be cleaned ONCE, not once
  // per iteration over everything received so far.
  const stepA = appendCapture('', '\u001b[31mred\u001b[0m', 100)
  eq('the capture is colour-free', stepA.text, 'red')
  eq('and nothing was dropped yet', stepA.dropped, 0)
  const stepB = appendCapture(stepA.text, ' more', 8)
  eq('past the ceiling the TAIL is kept', stepB.text, 'red more'.slice(-8), stepB.text)
  eq('and the dropped count is explicit', stepB.dropped, stepA.text.length + ' more'.length - 8, String(stepB.dropped))
  eq('an empty frame is harmless', appendCapture('x', undefined, 10).text, 'x')

  // ---------------------------------------------------------------- regression guards
  // The guard is ONE linear pass over the command. The first version re-sliced the whole
  // segment per `rm` match: measured 18 s of the host's event loop for one 60 KB command.
  console.log('\nregression: destructive guard')
  {
    const started = Date.now()
    const spam = destructiveReason('rm '.repeat(20_000))
    check('a 60 KB `rm` spam is judged linearly and allowed',
      spam === null && Date.now() - started < 100, `${Date.now() - started} ms, reason=${String(spam)}`)
    const allowed = [
      'systemctl status reboot.target',
      'git clean -nfd',
      'mkfs --help',
      'fdisk -l',
    ]
    const allowedReasons = allowed.map((command) => destructiveReason(command))
    check('read-only investigations of the same tools are not refused',
      allowedReasons.every((reason) => reason === null), JSON.stringify(allowedReasons))
    const refused = [
      '2>/dev/null rm -r x',
      'eval "rm -rf /tmp/x"',
      'echo "rm -rf /" | bash',
      'echo x >| /dev/sda',
      'tee /dev/sdb',
      'cp disk.img /dev/sdb',
      'runuser -u root -- rm -rf /tmp/x',
    ]
    const refusedReasons = refused.map((command) => destructiveReason(command))
    check('the indirection forms are judged at their real command',
      refusedReasons.every((reason) => reason !== null), JSON.stringify(refusedReasons))
    check('a command past the inspection cap is refused, never silently allowed',
      destructiveReason('x'.repeat(70_000)) !== null)
  }

  // Workdir precedence: the environment must still reach a deployment whose switch is the
  // volatile cell the panel writes (the default), while an explicit plain switch wins.
  console.log('\nregression: workdir precedence')
  eq('DSH_WSL_WORKDIR=home means the home directory',
    resolveConfig({ DSH_WSL_WORKDIR: 'home' }, {}).defaultWorkdir, '~')
  eq('a fixed environment directory is used verbatim',
    resolveConfig({ DSH_WSL_WORKDIR: '/mnt/x' }, {}).defaultWorkdir, '/mnt/x')
  eq('DSH_WSL_WORKDIR=session follows the session',
    resolveConfig({ DSH_WSL_WORKDIR: 'session' }, {}).defaultWorkdir, null)
  eq('a plain (non-cell) switch still wins over the environment',
    resolveConfig({ DSH_WSL_WORKDIR: 'home' }, { startInSessionWorkspace: true }).defaultWorkdir, null)
  eq('the switch being off falls back to the home directory',
    resolveConfig({}, { startInSessionWorkspace: { get: () => false } }).defaultWorkdir, '~')
  eq('the default follows the session',
    resolveConfig({}, {}).defaultWorkdir, null)

  // The apt step installs `curl`; the Node tarball step downloads WITH curl. On a fresh image
  // the old order ran node first, so the installer died before the step that would have fixed it.
  console.log('\nregression: installer order and discovery')
  eq('the apt step runs before node when curl is missing',
    planFor(resolveRecipes(['node'], {}), {}).steps.map((step) => step.id).join(','), 'tools,node')
  eq('a machine that already has curl keeps node first',
    planFor(resolveRecipes(['node'], { curl: true }), { curl: true }).steps.map((step) => step.id).join(','), 'node')
  check('the LTS line is discovered and checksum-verified, not hardcoded',
    NODE_LTS_SCRIPT.includes('index.json') && NODE_LTS_SCRIPT.includes('SHASUMS256.txt'),
    NODE_LTS_SCRIPT.slice(0, 120))
  {
    // The command translator is told which distribution it translates FOR: a UNC path naming
    // another distribution must reach the program verbatim.
    const captureRunner = makeStubRunner()
    const tool = createWslTool({ ctx: { get: () => undefined }, config: CONFIG, runner: captureRunner })
    await tool.execute({ command: 'ls \\\\wsl.localhost\\Debian\\home', description: 'other distro', distro: 'Ubuntu-22.04' })
    eq('a command naming another distribution keeps its UNC path',
      captureRunner.calls[0].command, 'ls \\\\wsl.localhost\\Debian\\home')
    await tool.execute({ command: 'ls \\\\wsl.localhost\\Ubuntu-22.04\\home', description: 'same distro', distro: 'Ubuntu-22.04' })
    eq('a command naming this distribution is translated',
      captureRunner.calls[1].command, 'ls /home')
  }

  // A byte-trimmed stream window can start inside a character; the U+FFFD it produces must not
  // reach the model as a visible `�` at the head of every truncated Chinese output.
  console.log('\nregression: truncated multibyte stream')
  {
    const facts = streamFacts({ text: '\uFFFD汉汉汉', nextOffset: 12, lossy: true })
    eq('a truncated window does not start with U+FFFD', facts.text, '汉汉汉')
    check('the dropped-byte count stays within the character-boundary error',
      facts.droppedBytes >= 2 && facts.droppedBytes <= 5, String(facts.droppedBytes))
  }

  // The subtask log is bounded even when nothing is ever finished, and a running record that
  // still owns a live shell is never dropped to make room.
  console.log('\nregression: subtask log bounds')
  {
    const log = createSubtaskLog()
    for (let index = 0; index < 300; index += 1) log.start('s', `t${String(index)}`)
    const trimmed = log.list('s')
    check('300 unfinished records are trimmed to the limit',
      trimmed.entries.length <= 60, String(trimmed.entries.length))
    eq('and the total never regresses', trimmed.total, 300)
    const live = createSubtaskLog()
    for (let index = 0; index < 10; index += 1) {
      live.start('s', `live${String(index)}`, { terminalId: `live-${String(index)}` })
    }
    for (let index = 0; index < 300; index += 1) live.start('s', `t${String(index)}`)
    const mixed = live.list('s')
    check('a running record with a live shell is never trimmed',
      mixed.entries.filter((entry) => String(entry.title).startsWith('live')).length === 10
      && mixed.entries.length <= 60,
      JSON.stringify({ kept: mixed.entries.length }))
  }

  // Empty or unreadable wallets are "unavailable", never a zero balance; a real zero is zero.
  console.log('\nregression: wallet text and session ids')
  eq('no wallets means no text (the route reports unavailable)', walletText([]), '')
  eq('a null balance is not a zero balance', walletText([{ balance: null }]), '')
  eq('a real zero is printed as zero', walletText([{ currency: 'CNY', balance: '0' }]), '¥0.00')
  check('a session id rejects whitespace and control characters',
    validSessionId('session-a') === true && validSessionId('a b') === false
    && validSessionId('a\tb') === false && validSessionId('a\nb') === false, '')

  // The private PTY transport is a small state machine whose failures are PROCESS-level when it
  // drops a provider promise: the host turns an unhandled rejection into process.exit(1). These
  // checks pin the three cases that matter there.
  console.log('\npty transport: concurrency, write failures, owner cleanup')
  {
    const { provider, calls } = makePtyProvider()
    const transport = createPtyTransport({ ctx: {}, config: CONFIG, subprocess: provider })
    const agent = { id: 'session-pty-concurrent' }
    const [first, second] = await Promise.all([
      transport.create(agent, { id: 'dsh-agent', cols: 80, rows: 24 }),
      transport.create(agent, { id: 'dsh-agent', cols: 80, rows: 24 }),
    ])
    eq('two concurrent creates of one id spawn one shell', calls.spawned.length, 1)
    eq('and both calls answer the same terminal', `${first.id}/${second.id}`, 'dsh-agent/dsh-agent')
  }
  {
    const unhandled = []
    const listener = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    try {
      const { provider } = makePtyProvider({ writeRejects: true })
      const transport = createPtyTransport({ ctx: {}, config: CONFIG, subprocess: provider })
      const agent = { id: 'session-pty-write' }
      await transport.create(agent, { id: 'dsh-agent', cols: 80, rows: 24 })
      const failure = await transport.write(agent, 'dsh-agent', 'attachment', 'x')
        .then(() => null, (error) => String(error?.message ?? error))
      check('a provider write rejection becomes a rejected transport write',
        /has exited|could not write/.test(String(failure)), String(failure))
      await tickMs(30)
      eq('and it never escapes as an unhandled rejection', unhandled.length, 0)
    } finally {
      process.off('unhandledRejection', listener)
    }
  }
  {
    const { provider, calls } = makePtyProvider()
    const transport = createPtyTransport({ ctx: {}, config: CONFIG, subprocess: provider })
    const disposers = []
    const agent = {
      id: 'session-pty-owner',
      ctx: { effect: (fn) => { disposers.push(fn); return () => {} } },
    }
    await transport.create(agent, { id: 'dsh-agent', cols: 80, rows: 24 })
    eq('the owning conversation registers one shell cleanup', disposers.length, 1)
    // `effect(callback)` takes a callback that RETURNS the disposer (the cordis shape), so the
    // shell cleanup is the result of calling it once and then the result again.
    const dispose = disposers[0]()
    await (typeof dispose === 'function' ? dispose() : dispose)
    eq('disposing that conversation terminates its shell', calls.terminated, 1)
  }
}

// --- tool-level tests ------------------------------------------------------

async function toolTests(tools, shim) {
  // Facts about THIS machine, read rather than assumed. A hard-coded `/home/xiny` or
  // `Ubuntu-22.04` turns "the runner passes -d through" into "the author happens to have
  // that distro installed", and the suite then fails on every other machine for reasons
  // that have nothing to do with the code under test.
  const REAL_HOME = (await machineFact('wsl.exe', ['-e', 'bash', '-lc', 'printf %s "$HOME"'])) || '/home'
  const REAL_DISTRO = (await machineFact('wsl.exe', ['-l', '-q']))
    .split('\n').map((line) => line.trim()).filter((line) => line !== '')[0] ?? 'Ubuntu-22.04'

  console.log('\nwsl: stdout / exit codes')
  const ok = await tools.wsl.execute({ command: 'echo hello', description: 'echo' })
  eq('exit code 0', ok.exitCode, 0)
  eq('stdout captured', ok.stdout.trim(), 'hello')
  eq('not marked timed out', ok.timedOut, false)
  eq('not truncated', ok.truncated, false)
  check('no markers rendered', render(ok) === 'hello\n', JSON.stringify(render(ok)))

  const failing = await tools.wsl.execute({ command: 'echo out; echo err 1>&2; exit 7', description: 'fail' })
  eq('exit code 7', failing.exitCode, 7)
  check('markers rendered', render(failing) === 'out\n[stderr]\nerr\n[exit code: 7]', JSON.stringify(render(failing)))

  console.log('\nwsl: environment and validation')
  const envResult = await tools.wsl.execute({
    command: 'printf "%s|%s" "$FOO" "$BAR"',
    description: 'env',
    env: { FOO: 'hello world', BAR: "it's quoted" },
  })
  eq('env values survive quoting', envResult.stdout, "hello world|it's quoted")

  await rejects('invalid env key is refused', () => tools.wsl.execute({
    command: 'true', description: 'bad env', env: { 'BAD KEY': 'x' },
  }), /not a valid shell variable name/)
  await rejects('empty command is refused', () => tools.wsl.execute({ command: '  ', description: 'x' }), /non-empty string/)
  await rejects('zero timeout is refused', () => tools.wsl.execute({ command: 'true', description: 'x', timeoutMs: 0 }), /positive integer/)
  // The result schema declares `timeoutMs` as an integer; a fractional deadline used to pass the
  // check here and then be rejected by the host AFTER the command had already run.
  await rejects('a fractional timeout is refused', () => tools.wsl.execute({
    command: 'true', description: 'x', timeoutMs: 1.5,
  }), /positive integer/)
  await rejects('a non-string workdir is refused', () => tools.wsl.execute({
    command: 'pwd', description: 'x', workdir: 5,
  }), /workdir must be a string/)
  await rejects('a non-string distro is refused', () => tools.wsl.execute({
    command: 'true', description: 'x', distro: 7,
  }), /distro must be a string/)

  console.log('\nwsl: workdir')
  const tilde = await tools.wsl.execute({ command: 'pwd', description: 'home', workdir: '~/.' })
  eq('tilde workdir resolves', tilde.stdout.trim(), REAL_HOME)
  const spaced = await tools.wsl.execute({ command: 'pwd', description: 'spaced', workdir: 'C:\\Program Files' })
  eq('windows workdir with a space resolves', spaced.stdout.trim(), '/mnt/c/Program Files')
  const spacedForward = await tools.wsl.execute({ command: 'pwd', description: 'spaced', workdir: 'C:/Program Files' })
  eq('forward-slash workdir resolves', spacedForward.stdout.trim(), '/mnt/c/Program Files')
  const badDir = await tools.wsl.execute({ command: 'pwd', description: 'missing', workdir: '/no/such/dir' })
  check('missing workdir fails without running the command', badDir.exitCode !== 0 && badDir.stdout.trim() === '', JSON.stringify(badDir.stdout))

  console.log('\nwsl: guard enforcement')
  await rejects('destructive command is refused', () => tools.wsl.execute({
    command: 'rm -rf /tmp/dsh-wsl-guard', description: 'delete',
  }), /refused a destructive command/)
  // Each rm invocation is judged alone: `-f` on one and `-r` on the next must
  // not add up to a pass, which is how a recursive delete slipped through.
  await rejects('split flags across two rm calls are refused', () => tools.wsl.execute({
    command: 'rm /tmp/dsh-wsl-a -f; rm /tmp/dsh-wsl-b -r', description: 'delete two',
  }), /recursive delete/)
  const allowed = await tools.wsl.execute({
    command: 'rm -r -f /tmp/dsh-wsl-guard-notexist; echo survived',
    description: 'allowed delete',
    allowDangerous: true,
  })
  eq('allowDangerous executes the command', allowed.stdout.trim(), 'survived')

  // The sidebar panel's switches. Each one is read once, at mount, so the mount
  // is the unit under test and every case builds its own ctx. Every case pairs
  // with a control mount on the default switch: an assertion that only proves
  // "the command ran" would pass just as well if the switch were ignored.
  console.log('\nwsl: plugin settings gates')
  const guardOffTools = makeCtx(shim, { settings: { dangerGuard: false } })
  const unguardedResult = await guardOffTools.wsl.execute({
    command: 'rm -r -f /tmp/dsh-wsl-unguarded; echo ran',
    description: 'guard off',
  })
  eq('turning the guard off lets a destructive command run', unguardedResult.stdout.trim(), 'ran')
  await rejects('the control mount still refuses the same command', () => tools.wsl.execute({
    command: 'rm -r -f /tmp/dsh-wsl-unguarded; echo ran', description: 'guard on',
  }), /refused a destructive command/)

  const noBackgroundTools = makeCtx(shim, { jobs, settings: { backgroundJobs: false } })
  await rejects('the background switch is enforced even where jobs exist', () => noBackgroundTools.wsl.execute({
    command: 'echo x', description: 'background off', runInBackground: true,
  }), /background jobs are switched off/)
  const backgroundTools = makeCtx(shim, { jobs })
  const startedJob = await backgroundTools.wsl.execute({
    command: 'echo bg-switch', description: 'background on', runInBackground: true,
  })
  check('the control mount still starts a job', typeof startedJob.jobId === 'string', JSON.stringify(startedJob.jobId))

  const verbatimTools = makeCtx(shim, { settings: { translatePaths: false } })
  const keptVerbatim = await verbatimTools.wsl.execute({
    command: "echo 'C:\\keep\\me'", description: 'translation off',
  })
  eq('the translation switch keeps a Windows path verbatim', keptVerbatim.stdout.trim(), 'C:\\keep\\me')
  const rewrittenByDefault = await tools.wsl.execute({ command: "echo 'C:\\keep\\me'", description: 'translation on' })
  eq('the control mount rewrites it', rewrittenByDefault.stdout.trim(), '/mnt/c/keep/me')

  const wslOnlyTools = makeCtx(shim, {
    settings: {
      tools: {
        wsl: true, path: false, env: false, doctor: false, bootstrap: false, read: false, write: false, edit: false, grep: false,
      },
    },
  })
  eq('a tool switch removes exactly that tool, and the switchless terminal tool stays',
    Object.keys(wslOnlyTools).sort().join(','), 'wsl,wsl-term')
  const allOffTools = makeCtx(shim, {
    settings: {
      tools: {
        wsl: false, path: false, env: false, doctor: false, bootstrap: false, read: false, write: false, edit: false, grep: false,
      },
    },
  })
  eq('with every switch off, only the switchless terminal tool remains',
    Object.keys(allOffTools).sort().join(','), 'wsl-term')
  eq('the control mount registers the file tools, the read-only tools and the terminal tool',
    Object.keys(tools).sort().join(','), 'wsl,wsl-doctor,wsl-edit,wsl-env,wsl-grep,wsl-path,wsl-read,wsl-term,wsl-write')
  // The installer is absent unless asked for: it adds software. The terminal tool is not
  // optional and not switchable — a terminal the user opens is the consent it needs.
  const optInTools = makeCtx(shim, { settings: { tools: { bootstrap: true } } })
  eq('the installer switch registers exactly its own tool',
    Object.keys(optInTools).sort().join(','), 'wsl,wsl-bootstrap,wsl-edit,wsl-env,wsl-grep,wsl-path,wsl-read,wsl-term,wsl-write')

  // A volatile field is written into the same object the loader handed `apply` and
  // then announced, so the behaviour switches must take effect with no remount. The
  // settings object is mutated in place here, exactly as the loader does it.
  console.log('\nwsl: live settings updates')
  const liveSettings = { dangerGuard: true }
  const liveTools = makeCtx(shim, { settings: liveSettings })
  await rejects('the guard is on at mount', () => liveTools.wsl.execute({
    command: 'rm -r -f /tmp/dsh-wsl-live; echo ran', description: 'still guarded',
  }), /refused a destructive command/)
  const fireUpdate = liveTools.handlers?.get('loader/volatile-update')
  check('the plugin listens for volatile updates', typeof fireUpdate === 'function')
  liveSettings.dangerGuard = false
  if (typeof fireUpdate === 'function') fireUpdate()
  const liveRun = await liveTools.wsl.execute({
    command: 'rm -r -f /tmp/dsh-wsl-live; echo ran', description: 'now unguarded',
  })
  eq('a behaviour switch applies without a restart', liveRun.stdout.trim(), 'ran')

  // A tool switch is the same kind of live setting: the panel is where these are
  // flipped, and a switch that only works after a restart reads as broken. Measured
  // in the wild: a user turned a tool switch on 24 seconds after starting the app
  // and the tool was still missing, because registration only ran at mount.
  const switchableSettings = { tools: { wsl: true, path: true, env: true, doctor: true, bootstrap: false } }
  const switchableTools = makeCtx(shim, { settings: switchableSettings })
  const fireToolUpdate = switchableTools.handlers?.get('loader/volatile-update')
  check('the plugin listens for volatile updates that add tools', typeof fireToolUpdate === 'function')
  eq('the installer starts absent while the terminal tool is already there',
    Object.keys(switchableTools).sort().join(','), 'wsl,wsl-doctor,wsl-edit,wsl-env,wsl-grep,wsl-path,wsl-read,wsl-term,wsl-write')
  switchableSettings.tools.bootstrap = true
  if (typeof fireToolUpdate === 'function') fireToolUpdate()
  eq('turning a tool switch on registers its tool live, without a restart',
    Object.keys(switchableTools).sort().join(','), 'wsl,wsl-bootstrap,wsl-doctor,wsl-edit,wsl-env,wsl-grep,wsl-path,wsl-read,wsl-term,wsl-write')
  switchableSettings.tools.doctor = false
  if (typeof fireToolUpdate === 'function') fireToolUpdate()
  eq('turning a tool switch off retires its tool live too',
    Object.keys(switchableTools).sort().join(','), 'wsl,wsl-bootstrap,wsl-edit,wsl-env,wsl-grep,wsl-path,wsl-read,wsl-term,wsl-write')
  switchableSettings.tools.doctor = true
  if (typeof fireToolUpdate === 'function') fireToolUpdate()
  eq('and it can come back afterwards',
    Object.keys(switchableTools).sort().join(','), 'wsl,wsl-bootstrap,wsl-doctor,wsl-edit,wsl-env,wsl-grep,wsl-path,wsl-read,wsl-term,wsl-write')

  // The panel's 「复制插件信息」 gets the version from here, so a release never has to
  // edit a string in the client half: the Host half reads its own manifest.
  console.log('\nself-info route')
  // The terminal-subtask log is what the client dock row above the composer renders: the
  // running ones first (that is the point of the display), each finished one with its result,
  // its commands and what happened to its shell. It is the client-facing half of the protocol
  // "one shell per subtask, then close it or leave it idle".
  {
    const log = createSubtaskLog()
    log.start("s1", "跑通 sta 流程", { terminalId: "dsh-agent", terminalCreated: true })
    log.recordCommand("s1", "跑通 sta 流程", "make sta", 0)
    log.start("s1", "修终端就绪竞态", { terminalId: "user-term", terminalCreated: false })
    check("the terminal-subtask log keeps one entry per piece of work", log.list("s1").total === 2)
    check("a started subtask counts as running", log.list("s1").running === 2)
    log.finish("s1", "跑通 sta 流程", { result: "三条连跑全通过", terminalKept: true })
    log.finish("s1", "修终端就绪竞态", { result: "已修", terminalKept: false })
    const done = log.list("s1")
    check("finished subtasks leave the running count", done.running === 0 && done.total === 2)
    check("a finished subtask carries its result and its shell decision",
      done.entries.every((entry) => projectSubtask(entry).result !== null
        && ["idle", "closed"].includes(projectSubtask(entry).terminal)),
      JSON.stringify(done.entries.map(projectSubtask)))
    check("one subtask was closed and one left idle, and the dock can tell",
      done.entries.map((entry) => projectSubtask(entry).terminal).sort().join(",") === "closed,idle",
      JSON.stringify(done.entries.map(projectSubtask)))
    check("the commands of a subtask are what the dock row prints",
      done.entries.some((entry) => projectSubtask(entry).commands.some((command) => command.command === "make sta")),
      JSON.stringify(done.entries.map((entry) => projectSubtask(entry).commands)))
    check("a terminal the tool did not open is marked as the user's",
      done.entries.some((entry) => entry.terminalCreated === false))
    check("the other conversation stays empty", log.list("s2").total === 0)
  }
  {
    const log = createSubtaskLog()
    const entry = log.start("s3", "dies", { terminalId: "t", terminalCreated: false })
    const exited = projectSubtask(entry, { id: "t", state: "exited", exitCode: 7 })
    check("a shell that exited ends its record even while its tab exists",
      exited.status === "done" && exited.terminal === "closed" && exited.result === "终端已退出",
      JSON.stringify(exited))
    eq("a running shell keeps the record open", projectSubtask(entry, { id: "t", state: "running" }).status, "running")
    const totalBefore = log.list("s3").total
    const phantom = log.finish("s3", "never-started", { terminalKept: true })
    check("finishing a title that never started is a no-op, not a phantom record",
      phantom === null && log.list("s3").total === totalBefore && log.list("s3").entries.length === 1,
      JSON.stringify(log.list("s3")))
  }
  // Three original routes plus three WSL-channel routes: state for the panel, install for
  // the shim, and the picker's create-a-session action. The channel's own server is
  eq('the plugin publishes its eight routes', tools.routes.length, 8)
  const channelStateRoute = tools.routes.find((route) => route.path === '/dsh-wsl-tool/channel')
  const channelInstallRoute = tools.routes.find((route) => route.path === '/dsh-wsl-tool/channel-install')
  const channelNewRoute = tools.routes.find((route) => route.path === '/dsh-wsl-tool/channel-new')
  const pathsRoute = tools.routes.find((route) => route.path === '/dsh-wsl-tool/paths')
  const dirsRoute = tools.routes.find((route) => route.path === '/dsh-wsl-tool/dirs')
  check('the directory-browser route is namespaced', dirsRoute !== undefined, JSON.stringify(tools.routes.map((r) => r.path)))
  check('the channel state route is namespaced', channelStateRoute !== undefined, JSON.stringify(tools.routes.map((r) => r.path)))
  check('the channel install route is namespaced', channelInstallRoute !== undefined, JSON.stringify(tools.routes.map((r) => r.path)))
  check('the channel new-session route is namespaced', channelNewRoute !== undefined, JSON.stringify(tools.routes.map((r) => r.path)))
  check('the path-candidates route is namespaced', pathsRoute !== undefined, JSON.stringify(tools.routes.map((r) => r.path)))
  eq('the channel state route matches exactly', channelStateRoute?.kind, 'exact')
  eq('the channel state route is read-only', await (async () => {
    const probe = { writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } }
    await channelStateRoute.handler({ method: 'POST', headers: {} }, probe)
    return probe.code
  })(), 405)
  const infoRoute = tools.routes.find((route) => route.path === '/dsh-wsl-tool/info')
  const terminalRoute = tools.routes.find((route) => route.path === '/dsh-wsl-tool/terminal-cwd')
  check('the self-info route is namespaced', infoRoute !== undefined, JSON.stringify(tools.routes.map((r) => r.path)))
  eq('the route matches exactly', infoRoute?.kind, 'exact')
  const ownManifest = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  const answered = { writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } }
  // The handler is async: it probes WSL (default distribution, kernel, capabilities)
  // before answering, so the body exists only after the await.
  await infoRoute.handler({ method: 'GET' }, answered)
  eq('the route answers 200', answered.code, 200)
  eq('the route forbids caching', answered.headers['cache-control'], 'no-store')
  const payload = JSON.parse(answered.body)
  eq('it reports this package name', payload.name, ownManifest.name)
  eq('it reports this package version', payload.version, ownManifest.version)
  eq('it reports the platform', payload.platform, process.platform)
  check('it carries the switch states the panel shows', payload.config.tools.wsl === true)
  check('it carries the effective timeout', 'commandTimeoutMs' in payload.config)
  check('it carries no filesystem paths',
    !JSON.stringify(payload).includes(process.cwd()),
    JSON.stringify(payload).slice(0, 160))
  // Both of these are best-effort reads: a value or null, never a wrong value.
  check('it reports the DSH build only when it could read one',
    payload.dsh === null || (typeof payload.dsh === 'object' && typeof payload.dsh.version === 'string'),
    JSON.stringify(payload.dsh))
  check('it never mistakes this plugin for the application',
    payload.dsh === null || payload.dsh.name !== payload.name,
    JSON.stringify(payload.dsh))
  check('the WSL facts are an object or null, never a guess',
    payload.wsl === null || typeof payload.wsl === 'object',
    JSON.stringify(payload.wsl))
  // The one bridge question a person debugging it has. Counts only: this route is local.
  check('the terminal block reports the transport, never ids',
    payload.terminal === null
    || (typeof payload.terminal === 'object'
      && typeof payload.terminal.kind === 'string'
      && typeof payload.terminal.bridgeCapable === 'boolean'
      && (payload.terminal.bridge === null
        || (typeof payload.terminal.bridge?.client === 'boolean'
          && typeof payload.terminal.bridge?.attachments === 'number'))),
    JSON.stringify(payload.terminal))
  const refusedInfo = { writeHead(code) { this.code = code }, end() {} }
  await infoRoute.handler({ method: 'POST' }, refusedInfo)
  eq('a non-GET is refused with 405', refusedInfo.code, 405)

  // The panel's 「WSL 终端启动路径」 edits the profile's OWN patch layer, because the
  // sidebar terminal belongs to another plugin and only that layer can override its
  // `args`. These checks drive the real route handler against a temporary profile, so
  // the backup / write / read-back path is what is exercised, not a re-imitation of it.
  console.log('\nterminal-cwd route')
  check('the terminal route is published', terminalRoute !== undefined)
  eq('the terminal route matches exactly', terminalRoute?.kind, 'exact')
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-wsl-profile-'))
  const bareDir = mkdtempSync(join(tmpdir(), 'dsh-wsl-bare-'))
  const capDir = mkdtempSync(join(tmpdir(), 'dsh-wsl-cap-'))
  const previousProfileDir = process.env.DSH_PROFILE_DIR
  try {
    const patchFile = join(profileDir, 'cordis.patch.yml')
    const original = samplePatch()
    writeFileSync(patchFile, original, 'utf8')
    // A body arrives as a stream; this fake replays one chunk and the end, which is all
    // the handler needs, and records what the handler answered. Writes carry the JSON
    // content type by default because the route requires it (checked below).
    const call = (method, body, headers) => callRoute(terminalRoute, method, body, headers)
    const backupsIn = (dir) => readdirSync(dir).filter((name) => name.includes('.bak-'))

    process.env.DSH_PROFILE_DIR = profileDir
    const read = await call('GET')
    eq('GET answers 200', read.code, 200)
    const readBody = JSON.parse(read.body)
    eq('GET reports no startup directory yet', readBody.path, '')
    check('GET reports the terminal row as available', readBody.available === true, read.body)

    // The host web server has no origin policy of its own, so the route refuses anything
    // but JSON: a cross-site page cannot set that content type without a preflight, and
    // no preflight is ever answered. A form or a `no-cors` fetch cannot set it at all.
    const formPost = await call('POST', JSON.stringify({ path: '/mnt/evil' }), { 'content-type': 'text/plain' })
    eq('a form-style content type is refused with 415', formPost.code, 415)
    check('and it says why', /application\/json/.test(String(JSON.parse(formPost.body).error)), formPost.body)
    const barePost = await call('POST', JSON.stringify({ path: '/mnt/evil' }), {})
    eq('a POST with no content type is refused too', barePost.code, 415)
    eq('neither refusal touched the file', readFileSync(patchFile, 'utf8'), original)
    eq('neither refusal took a backup', backupsIn(profileDir).length, 0)

    const saved = await call('POST', JSON.stringify({ path: '/mnt/d/project' }))
    eq('POST answers 200', saved.code, 200)
    const savedBody = JSON.parse(saved.body)
    check('POST reports success', savedBody.ok === true, saved.body)
    eq('POST echoes the saved directory', savedBody.path, '/mnt/d/project')
    const written = readFileSync(patchFile, 'utf8')
    eq('only the args line changed on disk', changedLines(original, written), 1)
    eq('the directory is on disk', readTerminalCwd(written).path, '/mnt/d/project')
    const backups = backupsIn(profileDir)
    eq('a backup was taken before the write', backups.length, 1)
    if (backups.length === 1) {
      eq('the backup holds the pre-write file', readFileSync(join(profileDir, backups[0]), 'utf8'), original)
    }
    const onDisk = readFileSync(patchFile)
    check('the write added no BOM', onDisk[0] !== 0xef && onDisk[1] !== 0xbb, onDisk.subarray(0, 3).toString('hex'))
    eq('GET now reports the directory', JSON.parse((await call('GET')).body).path, '/mnt/d/project')

    const again = JSON.parse((await call('POST', JSON.stringify({ path: '/mnt/d/project' }))).body)
    check('saving the value that is already there succeeds', again.ok === true, again.body)
    eq('and that no-op takes no second backup', backupsIn(profileDir).length, 1)

    const refused = JSON.parse((await call('POST', JSON.stringify({ path: '/mnt/a\n/mnt/b' }))).body)
    check('a multi-line path is refused', refused.ok === false, JSON.stringify(refused))
    check('the refusal says why', /换行/.test(String(refused.error)), String(refused.error))
    eq('the refused write left the file alone', readFileSync(patchFile, 'utf8'), written)
    eq('a refusal takes no backup for a file it did not touch', backupsIn(profileDir).length, 1)
    const quoted = JSON.parse((await call('POST', JSON.stringify({ path: "/mnt/it's" }))).body)
    check('a quoted path is refused', quoted.ok === false && /引号/.test(String(quoted.error)), String(quoted.error))
    eq('the quoted refusal left the file alone', readFileSync(patchFile, 'utf8'), written)

    const cleared = JSON.parse((await call('POST', JSON.stringify({ path: '' }))).body)
    check('an empty path clears the flag', cleared.ok === true, cleared.body)
    eq('the cleared file carries no --cd', readTerminalCwd(readFileSync(patchFile, 'utf8')).path, '')
    eq('the clear is a second backup', backupsIn(profileDir).length, 2)

    // The same row also carries how much history its terminal keeps. Same rules: one
    // property per request, exactly one changed line, a backup before the write, and a
    // value that is not a sane count changes nothing.
    const beforeScroll = readFileSync(patchFile, 'utf8')
    const scrollSaved = JSON.parse((await call('POST', JSON.stringify({ scrollback: '5000' }))).body)
    check('a history length saves', scrollSaved.ok === true && scrollSaved.scrollback === 5000, JSON.stringify(scrollSaved))
    const afterScroll = readFileSync(patchFile, 'utf8')
    eq('the history length landed in the row', readTerminalScrollback(afterScroll).value, 5000)
    // A new key is an INSERTED line, so the positional helper cannot describe it; what
    // matters is that the file gained exactly one line and lost nothing.
    eq('the history length is a new line, not a rewrite of another',
      afterScroll.split('\n').length, beforeScroll.split('\n').length + 1)
    eq('and the tail of the file is untouched', afterScroll.endsWith(beforeScroll.slice(beforeScroll.lastIndexOf('\n'))), true)
    eq('the row itself is still readable', readTerminalCwd(afterScroll).row, true)
    eq('a third backup was taken', backupsIn(profileDir).length, 3)
    eq('GET reports the history length', JSON.parse((await call('GET')).body).scrollback, 5000)
    check('nothing else in the file moved', verifyTerminalScrollbackRewrite(beforeScroll, afterScroll, 5000) === null)

    const badScroll = JSON.parse((await call('POST', JSON.stringify({ scrollback: 'many' }))).body)
    check('a non-numeric history length is refused',
      badScroll.ok === false && /数字/.test(String(badScroll.error)), String(badScroll.error))
    eq('the refusal left the file alone', readFileSync(patchFile, 'utf8'), afterScroll)
    const hugeScroll = JSON.parse((await call('POST', JSON.stringify({ scrollback: '999999' }))).body)
    check('an absurd history length is refused and says the range',
      hugeScroll.ok === false && /100000/.test(String(hugeScroll.error)), String(hugeScroll.error))
    const twoFields = await call('POST', JSON.stringify({ path: '/mnt/x', scrollback: '10' }))
    eq('changing two settings in one request is refused', twoFields.code, 400)
    eq('and that refusal changed nothing', readFileSync(patchFile, 'utf8'), afterScroll)

    const clearedScroll = JSON.parse((await call('POST', JSON.stringify({ scrollback: '' }))).body)
    check('an empty history length clears the key',
      clearedScroll.ok === true && clearedScroll.scrollback === null, JSON.stringify(clearedScroll))
    eq('the key is gone from the file', readTerminalScrollback(readFileSync(patchFile, 'utf8')).value, null)

    // A write that cannot land must not leave the user's patch truncated: writeFileSync
    // truncates before writing, so the handler restores the in-memory copy and says whether
    // that worked. A read-only file is the cheapest way to reach that branch.
    const beforeFailure = readFileSync(patchFile, 'utf8')
    chmodSync(patchFile, 0o444)
    try {
      const failedWrite = JSON.parse((await call('POST', JSON.stringify({ path: '/mnt/d/locked' }))).body)
      check('a write that cannot land is reported as a failure', failedWrite.ok === false, JSON.stringify(failedWrite))
      check('and the answer says whether the file was restored',
        /还原/.test(String(failedWrite.error)), String(failedWrite.error))
      eq('the patch is exactly what it was', readFileSync(patchFile, 'utf8'), beforeFailure)
    } finally {
      chmodSync(patchFile, 0o644)
    }
    // Pure rules behind those answers, so a failure names the rule rather than the route.
    eq('a negative history length is not a count', validateTerminalScrollback('-1').ok, false)
    eq('a fractional history length is not a count', validateTerminalScrollback('1.5').ok, false)
    check('blank means "platform default"',
      validateTerminalScrollback('   ').ok === true && validateTerminalScrollback('').value === null)
    eq('a plain count parses', validateTerminalScrollback('2000').value, 2000)
    check('a row without a block config is refused rather than guessed at',
      writeTerminalScrollback('plugins:\n  - id: terminal-controller\n    config: {}\n', '10').ok === false,
      writeTerminalScrollback('plugins:\n  - id: terminal-controller\n    config: {}\n', '10').error)
    check('a patch without the row is refused',
      writeTerminalScrollback('plugins: []\n', '10').ok === false)
    // "Ours" means a DIRECT child of `config:`. A deeper `scrollback:` belongs to a nested
    // block — rewriting it would change another plugin's meaning, which is the exact
    // mistake this writer exists to avoid.
    const nested = [
      'plugins:',
      '  - id: terminal-controller',
      '    config:',
      '      shell:',
      '        path: wsl.exe',
      '        scrollback: 42',
      '',
    ].join('\n')
    const nestedWrite = writeTerminalScrollback(nested, '5000')
    check('a nested scrollback is not mistaken for the row setting', nestedWrite.ok === true, String(nestedWrite.error))
    check('the nested key is left exactly as it was', nestedWrite.text.includes('        scrollback: 42'), nestedWrite.text)
    check('and the row setting is added beside shell, not inside it',
      nestedWrite.text.includes('\n      scrollback: 5000\n'), JSON.stringify(nestedWrite.text))
    eq('the row now reads back as the new value', readTerminalScrollback(nestedWrite.text).value, 5000)
    const twice = [
      'plugins:',
      '  - id: terminal-controller',
      '    config:',
      '      scrollback: 1000',
      '      scrollback: 2000',
      '      shell:',
      '        path: wsl.exe',
      '',
    ].join('\n')
    check('two settings at the same level are refused rather than guessed at',
      writeTerminalScrollback(twice, '3000').ok === false, String(writeTerminalScrollback(twice, '3000').error))
    eq('and that refusal left the text alone', writeTerminalScrollback(twice, '3000').text, twice)

    eq('a malformed body is a 400', (await call('POST', '{oops')).code, 400)
    eq('a body without a path field is a 400', (await call('POST', JSON.stringify({ nope: true }))).code, 400)
    eq('another method is refused with 405', (await call('DELETE')).code, 405)

    // A profile whose patch has no terminal row: the opt-in is missing, and the route
    // must say so WITHOUT creating a row — adding one would switch the sidebar terminal
    // to WSL without the user ever opting in.
    writeFileSync(join(bareDir, 'cordis.patch.yml'), '- id: ui-settings\n  config:\n    enabled: true\n', 'utf8')
    process.env.DSH_PROFILE_DIR = bareDir
    const bareRead = JSON.parse((await call('GET')).body)
    check('a patch without the terminal row reports available: false', bareRead.available === false, JSON.stringify(bareRead))
    const bareWrite = JSON.parse((await call('POST', JSON.stringify({ path: '/mnt/d/x' }))).body)
    check('writing into that profile is refused', bareWrite.ok === false, bareWrite.body)
    eq('that profile was not touched at all', readdirSync(bareDir).length, 1)

    process.env.DSH_PROFILE_DIR = ''
    const noDir = JSON.parse((await call('GET')).body)
    check('no patch location at all degrades instead of throwing',
      noDir.available === false && typeof noDir.error === 'string', JSON.stringify(noDir))
    check('and the error names both places it looked',
      noDir.error.includes('profileContext') && noDir.error.includes('DSH_PROFILE_DIR'), String(noDir.error))

    // One backup per save is the point, but they must not accumulate forever: the newest
    // ten are kept, and only files carrying the exact name this plugin writes are ever
    // considered (a hand-made `.bak` is not ours to delete).
    writeFileSync(join(capDir, 'cordis.patch.yml'), original, 'utf8')
    writeFileSync(join(capDir, 'cordis.patch.yml.bak-keep-me'), 'hand-made, not ours', 'utf8')
    process.env.DSH_PROFILE_DIR = capDir
    for (let index = 0; index < 14; index += 1) {
      await call('POST', JSON.stringify({ path: `/mnt/d/p${index}` }))
    }
    const keptBackups = backupsIn(capDir).filter((name) => name !== 'cordis.patch.yml.bak-keep-me')
    eq('old backups are pruned to the cap', keptBackups.length, 10)
    const keptValues = keptBackups.map((name) => readTerminalCwd(readFileSync(join(capDir, name), 'utf8')).path)
    const expectedKept = []
    for (let index = 3; index <= 12; index += 1) expectedKept.push(`/mnt/d/p${index}`)
    eq('the window holds the newest ten pre-write states',
      keptValues.slice().sort().join(','), expectedKept.slice().sort().join(','))
    eq('the current value survived the pruning',
      readTerminalCwd(readFileSync(join(capDir, 'cordis.patch.yml'), 'utf8')).path, '/mnt/d/p13')
    check('a backup name this plugin did not write is left alone',
      existsSync(join(capDir, 'cordis.patch.yml.bak-keep-me')), 'hand-made .bak was deleted')
  } finally {
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfileDir
    rmSync(profileDir, { recursive: true, force: true })
    rmSync(bareDir, { recursive: true, force: true })
    rmSync(capDir, { recursive: true, force: true })
  }

  // Where the patch file comes from. The host's own answer wins: `profileContext.patchPath`
  // is the file the platform's settings UI edits. The environment is only the fallback,
  // because MEASURED, the desktop host process does NOT carry DSH_PROFILE_DIR — only model
  // tool subprocesses do. A route that trusted the environment found no patch file at all,
  // reported `available: false`, and the panel showed a dead, untypeable field.
  console.log('\nterminal-cwd route: where the patch file comes from')
  const serviceDir = mkdtempSync(join(tmpdir(), 'dsh-wsl-service-'))
  const envDir = mkdtempSync(join(tmpdir(), 'dsh-wsl-env-'))
  const previousProfileDirForService = process.env.DSH_PROFILE_DIR
  try {
    writeFileSync(join(serviceDir, 'cordis.patch.yml'), samplePatch(), 'utf8')
    writeFileSync(join(envDir, 'cordis.patch.yml'), samplePatch(), 'utf8')
    const serviceTools = makeCtx(shim, { profileContext: { patchPath: join(serviceDir, 'cordis.patch.yml') } })
    const serviceRoute = serviceTools.routes.find((route) => route.path === '/dsh-wsl-tool/terminal-cwd')
    process.env.DSH_PROFILE_DIR = envDir
    const serviceRead = JSON.parse((await callRoute(serviceRoute, 'GET')).body)
    eq('the service answer wins over the environment', serviceRead.available, true)
    const serviceWrite = JSON.parse((await callRoute(serviceRoute, 'POST', JSON.stringify({ path: '/mnt/d/service' }))).body)
    check('and the write succeeds', serviceWrite.ok === true, JSON.stringify(serviceWrite))
    eq('the service file received the value',
      readTerminalCwd(readFileSync(join(serviceDir, 'cordis.patch.yml'), 'utf8')).path, '/mnt/d/service')
    eq('the environment file was left alone',
      readFileSync(join(envDir, 'cordis.patch.yml'), 'utf8'), samplePatch())
    eq('no backup appeared beside the environment file', readdirSync(envDir).length, 1)
  } finally {
    if (previousProfileDirForService === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfileDirForService
    rmSync(serviceDir, { recursive: true, force: true })
    rmSync(envDir, { recursive: true, force: true })
  }

  console.log('\nwsl: timeout')
  const timedOut = await tools.wsl.execute({ command: 'sleep 5', description: 'slow', timeoutMs: 900 })
  eq('timeout is reported as a fact', timedOut.timedOut, true)
  eq('the effective timeout is reported', timedOut.timeoutMs, 900)
  check('timeout marker names the effective timeout', /\[timed out after 900ms; the command was killed\]/.test(render(timedOut)), JSON.stringify(render(timedOut)))
  check('timeout does not report a bare exit code', !/\[exit code:/.test(render(timedOut)))
  const noTimeoutGiven = await tools.wsl.execute({ command: 'echo default-timeout', description: 'default' })
  eq('a command without timeoutMs still gets the default', noTimeoutGiven.timeoutMs, 600_000)
  eq('the default did not trip', noTimeoutGiven.timedOut, false)

  console.log('\nwsl: truncation and spill')
  const big = await tools.wsl.execute({ command: 'seq 1 200000', description: 'big output' })
  eq('large output is marked truncated', big.truncated, true)
  check('dropped bytes are counted', big.stdoutDroppedBytes > 0, `dropped=${big.stdoutDroppedBytes}`)
  eq('counts add up', big.stdoutTotalBytes, big.stdoutDroppedBytes + Buffer.byteLength(big.stdout, 'utf8'))
  check('spill file is offered', typeof big.stdoutSpillPath === 'string' && big.stdoutSpillPath.length > 0, String(big.stdoutSpillPath))
  if (typeof big.stdoutSpillPath === 'string') {
    eq('spill file holds the complete stream', statSafe(big.stdoutSpillPath), big.stdoutTotalBytes)
    const head = readFileSync(big.stdoutSpillPath, 'utf8').slice(0, 6)
    check('spill file starts at the head of the stream', head.startsWith('1\n2\n3'), JSON.stringify(head))
  }
  const rendered = render(big)
  check('truncation marker names the spill file', rendered.includes('full stream:') && rendered.includes('bytes'), rendered.split('\n').pop())
  check('truncation marker quotes the window cap, not a derived count',
    /at most the last 65536 of 1288895 bytes were kept/.test(rendered), rendered.split('\n').pop())

  // A multi-byte character straddling the byte-trimmed window makes the decoded
  // text count a replacement character, so a derived "kept" number would claim
  // MORE than the 64 KiB window. The marker must never do that.
  const midChar = await tools.wsl.execute({
    command: `head -c 65534 /dev/zero | tr '\\0' x; awk 'BEGIN{for(i=0;i<40000;i++)printf "\\xe2\\x82\\xac"}'`,
    description: 'multibyte output',
  })
  eq('mid-character stream is truncated', midChar.truncated, true)
  eq('mid-character total is exact', midChar.stdoutTotalBytes, 65_534 + 120_000)
  const midRendered = render(midChar)
  check('marker never claims more than the cap',
    /at most the last 65536 of 185534 bytes were kept/.test(midRendered), midRendered.split('\n').pop())

  console.log('\nwsl: path translation opt-out')
  const translated = await tools.wsl.execute({ command: "echo 'C:\\Users\\me'", description: 'translated' })
  eq('windows path is translated by default', translated.stdout.trim(), '/mnt/c/Users/me')
  const verbatim = await tools.wsl.execute({
    command: "echo 'C:\\Users\\me'", description: 'verbatim', translatePaths: false,
  })
  eq('translatePaths:false passes it through', verbatim.stdout.trim(), 'C:\\Users\\me')
  await rejects('translatePaths must be boolean', () => tools.wsl.execute({
    command: 'true', description: 'x', translatePaths: 'yes',
  }), /must be a boolean/)

  console.log('\nwsl: long command fallback')
  const longResult = await tools.wsl.execute({ command: `echo ${'x'.repeat(31_000)}`, description: 'long' })
  eq('long command still runs', longResult.stdout.trim().length, 31_000)
  const lastArgv = shim.calls.at(-1).argv
  check('long command uses bash -ls on stdin', lastArgv.includes('-ls'), lastArgv.slice(0, 6).join(' '))
  check('long command sends the script on stdin', typeof shim.calls.at(-1).stdio.stdin === 'object')
  const shortArgv = (await tools.wsl.execute({ command: 'echo short', description: 'short' }), shim.calls.at(-1).argv)
  check('short command keeps bash -lc', shortArgv.includes('-lc'), shortArgv.slice(0, 6).join(' '))

  console.log('\nwsl: distro selection')
  await tools.wsl.execute({ command: 'true', description: 'default distro' })
  const defaultArgv = shim.calls.at(-1).argv
  check('no distro configured drops -d (system default)', !defaultArgv.includes('-d'), defaultArgv.slice(0, 4).join(' '))
  await tools.wsl.execute({ command: 'true', description: 'pinned', distro: REAL_DISTRO })
  const pinnedArgv = shim.calls.at(-1).argv
  eq('an explicit distro passes -d', pinnedArgv.slice(0, 4).join(' '), `wsl.exe -d ${REAL_DISTRO} -e`)

  console.log('\nwsl: presentCall shows the directory actually used')
  const card = tools.wsl.presentCall({ command: 'pwd', description: 'x', workdir: 'C:\\Program Files' })
  eq('the card cwd is the translated path', card.cwd, '/mnt/c/Program Files')
  const plainCard = tools.wsl.presentCall({ command: 'pwd', description: 'x' })
  check('no workdir means no cwd on the card', !('cwd' in plainCard))

  // `ToolCallView` knows exactly three cards, and only a terminal card has a
  // `description` slot: a card outside the vocabulary has no renderer at all.
  console.log('\nwsl: presentCall cards use the platform vocabulary')
  const GENERIC_FIELDS = ['card', 'title', 'kind', 'rawInput', 'content', 'locations']
  const TERMINAL_FIELDS = ['card', 'title', 'description', 'cwd']
  const DIFF_FIELDS = ['card', 'title', 'diffs', 'locations']
  const READ_FIELDS = ['card', 'path', 'offset', 'lines', 'totalLines', 'lang', 'content']
  for (const [name, tool] of Object.entries(tools)) {
    const view = tool.presentCall({ command: 'echo hi', description: 'label', path: '/tmp', workdir: 'C:\\tmp' })
    check(`${name}: declares a card the UI knows`, ['generic', 'terminal', 'diff', 'read'].includes(view?.card), String(view?.card))
    check(`${name}: the card carries a title`, typeof view?.title === 'string' && view.title.length > 0, JSON.stringify(view?.title))
    const allowed = view?.card === 'terminal'
      ? TERMINAL_FIELDS
      : view?.card === 'diff' ? DIFF_FIELDS
        : view?.card === 'read' ? READ_FIELDS : GENERIC_FIELDS
    const extra = Object.keys(view ?? {}).filter((key) => !allowed.includes(key))
    check(`${name}: no field outside the ${view?.card} card`, extra.length === 0, extra.join(', '))
  }

  console.log('\nwsl: stdin')
  const fed = await tools.wsl.execute({ command: 'cat', description: 'feed stdin', stdin: 'line one\nline two\n' })
  eq('stdin reaches the command', fed.stdout, 'line one\nline two\n')
  const counted = await tools.wsl.execute({ command: 'wc -c', description: 'count stdin', stdin: '12345' })
  eq('the exact bytes arrive', counted.stdout.trim(), '5')
  const emptyStdin = await tools.wsl.execute({ command: 'wc -c', description: 'no stdin', stdin: '' })
  eq('an empty stdin is still a pipe that closes', emptyStdin.stdout.trim(), '0')
  await rejects('stdin must be a string', () => tools.wsl.execute({
    command: 'cat', description: 'bad stdin', stdin: 42,
  }), /stdin must be a string/)
  await rejects('a command over the argv limit cannot also take stdin', () => tools.wsl.execute({
    command: `echo ${'x'.repeat(31_000)}`, description: 'both', stdin: 'data',
  }), /cannot also carry `stdin`/)

  console.log('\nwsl: forwarded host environment')
  {
    // The values are per-execution, so they come from the host's shell-env
    // registry via the exec context — never from the host's own process.env,
    // which is why a process.env-only implementation forwards nothing.
    const forwardingTools = makeCtx(shim, {
      jobs,
      // These assertions are about the env forwarding layer, so the workdir layer is
      // pinned: follow-session is ON by default now, which would run the command from
      // the session directory instead of `~` and the fake shim answers by cwd.
      settings: { startInSessionWorkspace: false },
      shellEnv: {
        collect: (exec) => ({
          DSH_SESSION_ID: exec?.agent?.session?.header?.id,
          DSH_HOME: 'C:\\Users\\me\\.dsh',
          DSH_WEB_URL: 'http://127.0.0.1:3080',
        }),
      },
    })
    const exec = { agent: { session: { header: { id: 'session-smoke-test', cwd: 'D:\\smoke-ws' } } } }
    const seen = await forwardingTools.wsl.execute({ command: 'printenv DSH_SESSION_ID', description: 'forwarded env' }, exec)
    eq('the session id reaches the Linux side', seen.stdout.trim(), 'session-smoke-test')
    const home = await forwardingTools.wsl.execute({ command: 'printenv DSH_HOME', description: 'forwarded home' }, exec)
    eq('DSH_HOME arrives as a /mnt path', home.stdout.trim(), '/mnt/c/Users/me/.dsh')
    const url = await forwardingTools.wsl.execute({ command: 'printenv DSH_WEB_URL || echo unset', description: 'url stays out' }, exec)
    eq('DSH_WEB_URL stays out of the distro', url.stdout.trim(), 'unset')
    const overridden = await forwardingTools.wsl.execute(
      { command: 'printenv DSH_SESSION_ID', description: 'explicit wins', env: { DSH_SESSION_ID: 'explicit-wins' } },
      exec,
    )
    eq('an explicit env entry overrides the forwarded one', overridden.stdout.trim(), 'explicit-wins')
  }

  console.log('\nwsl: timeout ceiling')
  const capped = await tools.wsl.execute({ command: 'echo capped', description: 'capped timeout', timeoutMs: 999_999_999 })
  eq('a huge timeoutMs is capped at the ceiling', capped.timeoutMs, 86_400_000)
  eq('the capped command still ran', capped.stdout.trim(), 'capped')
  eq('capping is not a timeout', capped.timedOut, false)

  console.log('\nwsl: DSH_WSL_WORKDIR=session')
  const previousWorkdir = process.env.DSH_WSL_WORKDIR
  process.env.DSH_WSL_WORKDIR = 'session'
  try {
    // `apply()` reads the environment at mount, which is exactly what a restart
    // does, so a second mount is how a deployment switches this on.
    const sessionTools = makeCtx(shim, { jobs })
    // The SESSION's workspace, not the directory the host was launched from —
    // and a real directory, so `cd` proves which one was used.
    const sessionDir = mkdtempSync(join(tmpdir(), 'dsh-wsl-session-'))
    try {
      const exec = { agent: { session: { header: { cwd: sessionDir } } } }
      const sessionPwd = await sessionTools.wsl.execute({ command: 'pwd', description: 'session cwd' }, exec)
      eq('the default workdir follows the session workspace',
        sessionPwd.stdout.trim(), windowsPathToWsl(sessionDir))
      const noSession = await sessionTools.wsl.execute({ command: 'pwd', description: 'no session' })
      eq('without a session it falls back to the process cwd',
        noSession.stdout.trim(), windowsPathToWsl(process.cwd()))
      const overridden = await sessionTools.wsl.execute({ command: 'pwd', description: 'explicit wins', workdir: '~/.' }, exec)
      eq('an explicit workdir still wins', overridden.stdout.trim(), REAL_HOME)
    } finally {
      rmSync(sessionDir, { recursive: true, force: true })
    }
  } finally {
    if (previousWorkdir === undefined) delete process.env.DSH_WSL_WORKDIR
    else process.env.DSH_WSL_WORKDIR = previousWorkdir
  }

  console.log('\nwsl: background jobs')
  const started = await tools.wsl.execute({
    command: 'echo from-the-job', description: 'background echo', runInBackground: true,
  })
  check('a job id comes back', /^wsl-\d+$/.test(started.jobId ?? ''), String(started.jobId))
  check('the background result carries no exit code', started.exitCode === null)
  check('no default deadline applies in the background', started.timeoutMs === null)
  check('the render points at the job tools',
    render(started) === `[started in the background as job ${started.jobId}; read it with job_output, stop it with job_kill]`, render(started))
  const settled = await jobs.settled(started.jobId)
  eq('the job completed', settled.outcome.status, 'completed')
  check('the job detail carries the exit code', /exit code 0/.test(settled.outcome.detail ?? ''), String(settled.outcome.detail))
  // The registry's terminal payload is `result` (`dsh-jobs-local` keeps only `outcome.result`,
  // and `job_output` renders it once after settlement). `output` is not a field anything reads:
  // sending the text there made every background command's output unreachable while the fake
  // registry still "passed", which is exactly how the bug shipped.
  check('the job result holds the command output', (settled.outcome.result ?? '').includes('from-the-job'), JSON.stringify(settled.outcome.result))
  check('and the dead `output` field is gone from the outcome',
    !('output' in settled.outcome), JSON.stringify(Object.keys(settled.outcome)))
  // `owner` must be the owner's SESSION ID, not the Agent handle: the registry
  // resolves it through the live-agent registry (`agents.get(sessionId)`) and
  // answers `session "…" has no live agent` for anything else. DSH 0.1.5
  // tolerated the handle, so only a real host or this assertion catches it.
  check('an execution with no agent starts an unowned job', !('owner' in settled.spec), JSON.stringify(settled.spec.owner))
  const ownedExec = { agent: { id: 'session-smoke-owner', session: { header: { cwd: process.cwd() } } } }
  const ownedJob = await tools.wsl.execute(
    { command: 'echo owned', description: 'owned job', runInBackground: true },
    ownedExec,
  )
  const ownedSpec = jobs.record(ownedJob.jobId).spec
  check('a background job is owned by the calling session id', ownedSpec.owner === 'session-smoke-owner', JSON.stringify(ownedSpec.owner))
  check('the owner is a session id, not the agent handle', typeof ownedSpec.owner === 'string', typeof ownedSpec.owner)
  await jobs.settled(ownedJob.jobId)
  // The label is the bare command: the runtime already frames it with the job id
  // and the `wsl` kind, so a prefix here would read "wsl-1 [wsl] — wsl: …".
  eq('the job label is the command, unprefixed', settled.spec.label, 'echo from-the-job')
  const multilineLabel = await tools.wsl.execute({
    command: '\n\n  echo skipped-blank-lines\n', description: 'label from a later line', runInBackground: true,
  })
  eq('a blank first line still yields a usable label',
    jobs.record(multilineLabel.jobId).spec.label, 'echo skipped-blank-lines')
  await jobs.settled(multilineLabel.jobId)
  const longLabel = await tools.wsl.execute({
    command: `echo ${'y'.repeat(200)}`, description: 'long label', runInBackground: true,
  })
  const longLabelText = jobs.record(longLabel.jobId).spec.label
  check('a long label is truncated', longLabelText.length === 120 && longLabelText.endsWith('…'), String(longLabelText.length))
  await jobs.settled(longLabel.jobId)

  const failingJob = await tools.wsl.execute({
    command: 'echo bad; exit 3', description: 'background failure', runInBackground: true,
  })
  const failedSettled = await jobs.settled(failingJob.jobId)
  eq('a non-zero exit is completed, not failed', failedSettled.outcome.status, 'completed')
  check('the failure detail carries the code', /exit code 3/.test(failedSettled.outcome.detail ?? ''), String(failedSettled.outcome.detail))
  check('and the failing command\'s output still rides the result',
    (failedSettled.outcome.result ?? '').includes('bad') && /\[exit code: 3\]/.test(failedSettled.outcome.result ?? ''),
    JSON.stringify(failedSettled.outcome.result))

  const stderrJob = await tools.wsl.execute({
    command: 'echo oops 1>&2; exit 1', description: 'background stderr', runInBackground: true,
  })
  const stderrSettled = await jobs.settled(stderrJob.jobId)
  check('stderr is kept in the job result', (stderrSettled.outcome.result ?? '').includes('oops'), JSON.stringify(stderrSettled.outcome.result))

  const longJob = await tools.wsl.execute({
    command: 'sleep 30', description: 'background cancel', runInBackground: true,
  })
  jobs.record(longJob.jobId).hooks.cancel('test reason')
  const cancelled = await jobs.settled(longJob.jobId)
  eq('a cancelled job reports killed', cancelled.outcome.status, 'killed')
  check('the cancel reason survives', /test reason/.test(cancelled.outcome.detail ?? ''), String(cancelled.outcome.detail))
  // The status line says `killed`; an exit code left in the body would be the
  // kill's own artifact and would contradict it.
  check('a cancelled job does not also report an exit code',
    !/\[exit code:/.test(cancelled.outcome.result ?? ''), JSON.stringify(cancelled.outcome.result))

  const timedJob = await tools.wsl.execute({
    command: 'sleep 5', description: 'background timeout', runInBackground: true, timeoutMs: 700,
  })
  // The start result names the deadline the job really armed, not a blanket null: a caller has to
  // be able to tell a no-deadline job from a 700 ms one before it settles.
  eq('a background start reports the deadline it armed', timedJob.timeoutMs, 700)
  const timedOutcome = await jobs.settled(timedJob.jobId)
  eq('an explicit timeout still kills a background job', timedOutcome.outcome.status, 'killed')
  check('the timeout is named in the detail', /timed out/.test(timedOutcome.outcome.detail ?? ''), String(timedOutcome.outcome.detail))

  await rejects('the guard still applies in the background', () => tools.wsl.execute({
    command: 'rm -rf /tmp/nope', description: 'destructive', runInBackground: true,
  }), /refused a destructive command/)

  console.log('\nwsl: background without a jobs service')
  const noJobsTools = makeCtx(shim, {})
  await rejects('a missing jobs service is a clear error', () => noJobsTools.wsl.execute({
    command: 'echo x', description: 'no jobs', runInBackground: true,
  }), /needs the background-job service/)

  // A registry that refuses (no controller serves this composition) must also
  // leave the caller a way forward.
  const refusingJobs = { start() { throw new Error('no job controller serves this agent') } }
  const refusingTools = makeCtx(shim, { jobs: refusingJobs })
  await rejects('a refusing registry names the fallback', () => refusingTools.wsl.execute({
    command: 'echo x', description: 'refused job', runInBackground: true,
  }), /could not start a background job.*foreground/s)

  // ------------------------------------------------- 管理员模式（以 root 执行）
  console.log('\nwsl: root execution is switch-gated')
  const plainStart = shim.calls.length
  const plain = await tools.wsl.execute({ command: 'id -u', description: 'user id' })
  eq('a call without asRoot is not root', plain.asRoot, false)
  check('its argv has no -u root', !shim.calls[plainStart].argv.includes('-u'), shim.calls[plainStart].argv.join(' '))
  check('and its text carries no root marker', !render(plain).includes('ran as root'), render(plain))
  await rejects('asRoot is refused while the panel switch is off',
    () => tools.wsl.execute({ command: 'id -u', description: 'root id', asRoot: true }), /管理员模式/)
  await rejects('a non-boolean asRoot is refused',
    () => tools.wsl.execute({ command: 'id -u', description: 'root id', asRoot: 'yes' }), /must be a boolean/)

  const rootTools = makeCtx(shim, { jobs, settings: { allowRoot: true } })
  const rootStart = shim.calls.length
  const rooted = await rootTools.wsl.execute({ command: 'id -u', description: 'root id', asRoot: true })
  eq('with the switch on the call really is root', rooted.stdout.trim(), '0')
  eq('and the result says so', rooted.asRoot, true)
  const rootArgv = shim.calls[rootStart].argv
  check('the launcher gets `-u root` before `-e`',
    rootArgv.includes('-u') && rootArgv.indexOf('-u') < rootArgv.indexOf('-e') && rootArgv[rootArgv.indexOf('-u') + 1] === 'root',
    rootArgv.join(' '))
  check('and the model-facing text marks it',
    render(rooted).includes('[ran as root: wsl -u root]'), JSON.stringify(render(rooted).slice(0, 80)))
  await rejects('the destructive guard still applies to a root call',
    () => rootTools.wsl.execute({
      command: 'rm -rf /tmp/definitely-not-there', description: 'guarded as root', asRoot: true,
    }), /refused a destructive command/)
  const rootBackground = await rootTools.wsl.execute({
    command: 'echo root-background', description: 'root background', asRoot: true, runInBackground: true,
  })
  eq('a background root call carries the flag into its result', rootBackground.asRoot, true)
  eq('and it is still a job', typeof rootBackground.jobId, 'string')

  console.log('\nwsl-doctor: the tool assembles the report')
  const doctorRunner = makeStubRunner({
    spawn: (argv) => (argv.includes('-l') ? '  * Ubuntu-22.04    Running    2\n' : ''),
    run: (command) => (command.includes('package.json') ? { stdout: DOCTOR_PROBE_TEXT } : {}),
  })
  const doctorValue = await createWslDoctorTool({ config: CONFIG, runner: doctorRunner })
    .execute({ workspace: '/tmp/proj' })
  check('the report names the distribution it probed',
    doctorValue.summary.includes('distro: Ubuntu-22.04 (system default)'), doctorValue.summary)
  check('and the interop trap the tool exists for', doctorValue.summary.includes('WINDOWS npm'), doctorValue.summary)
  eq('the probe ran in the directory the caller named', doctorRunner.calls[0].opts.workdir, '/tmp/proj')
  check('and the probe is the project probe',
    doctorRunner.calls[0].command.includes('command -v node'), doctorRunner.calls[0].command.slice(0, 60))
  check('root is NOT probed while the panel switch is off',
    !doctorRunner.calls.some((call) => call.opts?.asRoot === true),
    JSON.stringify(doctorRunner.calls.map((call) => call.opts?.asRoot)))

  const rootDoctorRunner = makeStubRunner({
    spawn: (argv) => (argv.includes('-l') ? '  * Ubuntu-22.04    Running    2\n' : ''),
    run: (command) => {
      if (command === 'id -u') return { stdout: '0\n' }
      return command.includes('package.json') ? { stdout: DOCTOR_PROBE_TEXT } : {}
    },
  })
  const rootDoctorValue = await createWslDoctorTool({
    config: { ...CONFIG, allowRoot: true }, runner: rootDoctorRunner,
  }).execute({})
  check('with root on it measures and reports availability',
    rootDoctorValue.summary.includes('root: available through `wsl -u root`'), rootDoctorValue.summary)

  const blockedRunner = makeStubRunner({
    spawn: () => '  * Ubuntu-22.04    Running    2\n',
    run: () => ({ exitCode: 1, stderr: 'bash: line 1: cd: /nope: No such file or directory' }),
  })
  const blockedValue = await createWslDoctorTool({ config: CONFIG, runner: blockedRunner })
    .execute({ workspace: '/nope' })
  check('an unusable workspace is reported, not thrown',
    blockedValue.summary.includes('could not be entered') && blockedValue.summary.includes('/nope'), blockedValue.summary)
  check('and it names the distribution the same way the full report does',
    blockedValue.summary.includes('distro: Ubuntu-22.04 (system default)'), blockedValue.summary)

  console.log('\nwsl-bootstrap: plan first, install only on request')
  const presentOutput = ['have.node=0', 'have.pnpm=0', 'have.python3=0', 'have.pip3=0',
    'have.gcc=1', 'have.make=1', 'have.jq=0', 'have.rsync=1', 'have.curl=1', 'have.git=1'].join('\n')
  const bootstrapRunner = makeStubRunner({
    run: (command) => {
      if (command.includes('command -v')) return { stdout: presentOutput }
      if (command.includes('apt-get update --print-uris')) {
        return { stdout: 'apt-get update (dry run, --print-uris): sources resolve\nInst python3 (simulated)' }
      }
      if (command.includes('apt-get -s')) return { stdout: 'Inst python3 (simulated)' }
      return { stdout: 'installed python3' }
    },
  })
  const bootstrap = createWslBootstrapTool({
    config: { ...CONFIG, tools: { ...CONFIG.tools, bootstrap: true } },
    runner: bootstrapRunner,
  })
  const dryValue = await bootstrap.execute({ recipes: ['python'] })
  check('the dry run says nothing was installed',
    dryValue.summary.startsWith('dry run — nothing has been installed'), dryValue.summary.slice(0, 80))
  check('it shows what apt would report', dryValue.summary.includes('Inst python3 (simulated)'), dryValue.summary)
  const updateAt = dryValue.summary.indexOf('apt-get update (dry run')
  check('the simulated plan reflects the real order (update before install)',
    updateAt >= 0 && updateAt < dryValue.summary.indexOf('Inst python3 (simulated)'), dryValue.summary.slice(-420))
  {
    // A dry run must not touch the package lists: `apt-get -s update` is not even supported by
    // apt, so the update half is simulated with the read-only `--print-uris` form.
    const simulateCall = bootstrapRunner.calls.find((call) => String(call.command).includes('apt-get -s'))
    check('the simulated update is the read-only --print-uris form',
      String(simulateCall?.command).includes('apt-get update --print-uris')
      && !String(simulateCall?.command).includes('apt-get update -y'),
      String(simulateCall?.command).slice(0, 160))
  }
  check('it prints the exact command',
    dryValue.summary.includes('apt-get install -y python3 python3-pip python3-venv'), dryValue.summary)
  check('it says how to really install', dryValue.summary.includes('dryRun: false'), dryValue.summary)
  check('no step ran as root in a dry run',
    !bootstrapRunner.calls.some((call) => call.opts?.asRoot === true),
    JSON.stringify(bootstrapRunner.calls.map((call) => call.opts?.asRoot)))
  check('and nothing was installed',
    !bootstrapRunner.calls.some((call) => String(call.command).includes('apt-get install')),
    JSON.stringify(bootstrapRunner.calls.map((call) => String(call.command).slice(0, 40))))

  const installStart = bootstrapRunner.calls.length
  const installValue = await bootstrap.execute({ recipes: ['python'], dryRun: false })
  const installStep = bootstrapRunner.calls.slice(installStart)
    .find((call) => String(call.command).includes('apt-get install'))
  eq('the install step runs as root', installStep?.opts?.asRoot, true)
  check('with the packages the recipe names', String(installStep?.command).includes('python3-venv'), String(installStep?.command))
  check('and it is given a real deadline',
    installStep?.opts?.timeoutMs === BOOTSTRAP_TIMEOUT_MS, String(installStep?.opts?.timeoutMs))
  check('the outcome is reported per recipe',
    installValue.summary.includes('[python]') && installValue.summary.includes('ok'), installValue.summary)

  await rejects('an unknown recipe is refused',
    () => bootstrap.execute({ recipes: ['nope'] }), /unknown recipe/)
  await rejects('an empty recipe list is refused',
    () => bootstrap.execute({ recipes: [] }), /non-empty array/)
  await rejects('a non-array recipe list is refused',
    () => bootstrap.execute({ recipes: 'node' }), /non-empty array/)
  await rejects('a non-boolean dryRun is refused',
    () => bootstrap.execute({ recipes: ['node'], dryRun: 'no' }), /must be a boolean/)
  await rejects('a failing presence probe is a tool error, not a silent install',
    () => createWslBootstrapTool({
      config: CONFIG,
      runner: makeStubRunner({ run: (command) => (command.includes('command -v') ? { exitCode: 1, stderr: 'boom' } : {}) }),
    }).execute({ recipes: ['node'] }), /could not inspect/)

  const failingStep = await createWslBootstrapTool({
    config: CONFIG,
    runner: makeStubRunner({
      run: (command) => {
        if (command.includes('command -v')) return { stdout: presentOutput }
        if (command.includes('apt-get -s')) return { stdout: 'simulated' }
        return { exitCode: 100, stderr: 'E: Unable to locate package python3-venv' }
      },
    }),
  }).execute({ recipes: ['python'], dryRun: false })
  check('a failing step is reported with its output',
    failingStep.summary.includes('FAILED (exit code 100)') && failingStep.summary.includes('Unable to locate package'),
    failingStep.summary)
  check('and the run stops there', failingStep.summary.includes('stopped at the first failure'), failingStep.summary)

  console.log('\nwsl: an unenterable workdir stops the whole script')
  // Regression: `cd <dir> && <script>` guards only the first command, so the rest
  // of a multi-line script used to run in the HOST's directory. Measured live: the
  // doctor described the DSH profile directory's manifests as the project's.
  const badMulti = await tools.wsl.execute({
    command: 'echo first\npwd\necho second',
    description: 'multi-line into a missing directory',
    workdir: '/nope/does-not-exist',
  })
  check('the call fails instead of running elsewhere', badMulti.exitCode !== 0, `exit ${badMulti.exitCode}`)
  check('and no line of the script ran',
    !badMulti.stdout.includes('first') && !badMulti.stdout.includes('second'), JSON.stringify(badMulti.stdout))
  check('with bash naming the directory on stderr',
    /No such file or directory/.test(badMulti.stderr), JSON.stringify(badMulti.stderr))
  const liveBadDoctor = await tools['wsl-doctor'].execute({ workspace: '/nope/does-not-exist' })
  check('the doctor reports the unusable workspace instead of another directory',
    liveBadDoctor.summary.includes('could not be entered') && !liveBadDoctor.summary.includes('project: package.json'),
    liveBadDoctor.summary)

  console.log('\nwsl-path')
  const toLinux = await tools['wsl-path'].execute({ path: 'C:\\Program Files\\Git' })
  eq('windows -> linux', toLinux.converted, '/mnt/c/Program Files/Git')
  const toWindows = await tools['wsl-path'].execute({ path: `${REAL_HOME}/x` })
  check('linux -> windows', new RegExp(REAL_DISTRO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(toWindows.converted) && /home/.test(toWindows.converted), toWindows.converted)
  const forced = await tools['wsl-path'].execute({ path: '/tmp', direction: 'win' })
  check('forced direction', /tmp/.test(forced.converted), forced.converted)
  const tildePath = await tools['wsl-path'].execute({ path: '~' })
  check('tilde path is expanded before conversion', tildePath.converted !== '~' && /home/.test(tildePath.converted), tildePath.converted)
  await rejects('empty path is refused', () => tools['wsl-path'].execute({ path: '  ' }), /non-empty string/)
  // A RELATIVE input used to come back as a relative Windows path (`relative\dir`): a Windows
  // path that names nothing. `-a` resolves it against the shell's own directory (the session
  // workspace), and absolute inputs are unchanged by it. Asserted on the command line the runner
  // is handed, so the flag cannot silently disappear again.
  {
    const pathRunner = makeStubRunner({ run: () => ({ stdout: '/converted\n' }) })
    const pathTool = createWslPathTool({ config: CONFIG, runner: pathRunner })
    await pathTool.execute({ path: '/home/x' })
    eq('a linux path is converted with wslpath -a -w', pathRunner.calls[0].command, "wslpath -a -w '/home/x'")
    await pathTool.execute({ path: 'C:\\x' })
    eq('a windows path is converted with wslpath -a -u', pathRunner.calls[1].command, "wslpath -a -u 'C:\\x'")
    await rejects('an unknown direction is refused instead of auto-detected',
      () => pathTool.execute({ path: '/tmp', direction: 'up' }), /direction must be one of/)
  }

  console.log('\nwsl-env')
  const env = await tools['wsl-env'].execute({})
  check('reports the distro', env.summary.includes(`distro: ${REAL_DISTRO}`), env.summary)
  check('reports the kernel', /Linux \d/.test(env.summary), env.summary)
  check('reports the architecture', /Linux \S+ \S+/.test(env.summary), env.summary.split('\n')[1])
  check('reports cpu count', /nproc: \d+/.test(env.summary), env.summary)
  check('reports distributions', env.summary.includes('--- distributions ---'), env.summary)
  check('reports the launcher version line', /^launcher: .*\d/m.test(env.summary), env.summary)
  check('reports the capability lines', /WSL2/.test(env.summary) && /systemd: (yes|no)/.test(env.summary), env.summary)
  check('reports the GPU situation', /GPU: /.test(env.summary), env.summary)
  check('names where the session files live', /^workspace: \//m.test(env.summary), env.summary)
  // The capability probe must actually have reached the machine: a parsed fact
  // shows up either as a cgroup label or as an explicit GPU verdict.
  check('the capability probe reached the machine',
    /cgroup v\d/.test(env.summary) || /\/dev\/dxg/.test(env.summary), env.summary)
  check('the capability probe did not fall back', !env.summary.includes('capabilities unavailable'), env.summary)
  await rejects('unknown distro is reported, not swallowed', () => tools['wsl-env'].execute({ distro: 'NoSuchDistro' }), /not registered/)
  await rejects('unknown distro on wsl is reported', () => tools.wsl.execute({ command: 'true', description: 'x', distro: 'NoSuchDistro' }), /not registered/)

  // The host validates a result against `output.schema`, which declares
  // additionalProperties: false — so any drift between the returned keys and
  // the declared ones would make every call fail in the live harness.
  console.log('\nresult shape matches the declared output schema')
  const shape = [
    ['wsl', await tools.wsl.execute({ command: 'echo shape', description: 'shape' })],
    ['wsl-path', await tools['wsl-path'].execute({ path: '/tmp' })],
    ['wsl-env', await tools['wsl-env'].execute({})],
  ]
  for (const [name, value] of shape) {
    const declared = Object.keys(tools[name].output.schema.properties).sort()
    const returned = Object.keys(value).sort()
    check(`${name}: returned keys match the schema`, returned.join(',') === declared.join(','), `${returned.join(',')} vs ${declared.join(',')}`)
    check(`${name}: schema root allows no extras`, tools[name].output.schema.additionalProperties === false)
    check(`${name}: every property is required`, tools[name].output.schema.required.slice().sort().join(',') === declared.join(','))
  }

  // --- wsl-term ------------------------------------------------------------
  //
  // The terminal tool is the only thing here that types into a shell the user is
  // looking at, so its tests are about the guarantees around that: the switch
  // decides whether it exists at all, nothing is typed before the attachment
  // proves it holds the keyboard, and the keyboard is handed back every time.
  console.log('\nwsl-term: reading and driving the session terminal')
  const termAgent = { id: 'session-1' }
  const termInfoOf = (id) => ({
    id, title: 'WSL', shell: { name: 'bash', path: '/bin/bash', args: ['-i'] },
    cwd: '/home/xiny', cols: 120, rows: 30, state: 'running', exitCode: null,
  })
  /**
   * The terminal engine's tests drive a fake controller. The pre-bridge transport generation is
   * gone, so the fake is wrapped in the surface the PTY/bridge transports provide: ownership,
   * kind and the user-terminal list.
   */
  const transportOver = (stub) => ({
    kind: 'bridge',
    bridgeCapable: false,
    provider: undefined,
    // Ownership is per terminal, like the real transports: everything this fake shell table
    // holds belongs to the tool except the synthetic `user-term` the tests add by hand.
    owns: (_sessionId, id) => !String(id).startsWith('user-term'),
    kindOf: () => 'bridge',
    describe: (sessionId, id) => stub.list(sessionId).find((info) => String(info.id) === String(id)) ?? null,
    list: (sessionId) => stub.list(sessionId),
    userTerminals: async () => [],
    create: (agent, request, signal) => stub.create(agent, request, signal),
    follow: (agent, id, attachmentId, signal, options) => stub.follow(agent, id, attachmentId, signal, options),
    write: (agent, id, attachmentId, data) => stub.write(agent, id, attachmentId, data),
    close: (agent, id) => stub.close(agent, id),
  })
  const makeTermTool = (stub, config = CONFIG, subtasks = null) =>
    createWslTermTool({ ctx: { get: () => stub }, config, subtasks, transport: transportOver(stub) })
  /** The nonce a call line carries, which is what its markers must use. */
  const nonceOf = (data) => new RegExp(`${HELPER_NAME} ([0-9a-f]+) '`).exec(data)?.[1] ?? null
  /**
   * A shell that has the helper. It also echoes the definition line first, exactly as a real
   * PTY does — that echo contains the marker prefixes, and it is what took the first live run
   * out, so the stubs keep it in.
   */
  const replyWithCommand = (data) => {
    if (nonceOf(data) === null) {
      return data.includes(`${HELPER_NAME}()`)
        ? [{ type: 'output', data: `${(data.split('\r')[0] ?? '').replace('\u0015', '')}\r\n` }]
        : []
    }
    const nonce = nonceOf(data)
    return [
      { type: 'output', data: `${START_PREFIX}${nonce}\r\n` },
      { type: 'output', data: 'hi from the terminal\r\n' },
      { type: 'output', data: `${END_PREFIX}${nonce}:0\r\n` },
    ]
  }

  {
    const stub = makeTerminalStub({
      terminals: [{ ...termInfoOf('t1'), controllerId: 'client-1' }],
    })
    const listed = await makeTermTool(stub).execute({ action: 'list' }, { agent: termAgent })
    check('list names the terminal and who holds its keyboard',
      listed.summary.includes('id=t1') && listed.summary.includes('client-1'), listed.summary)
    eq('list asks the controller for this very session', stub.calls.list[0], 'session-1')
  }
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], screen: '\u001b[32mhello\u001b[0m\r\n$ ' })
    const read = await makeTermTool(stub).execute({ action: 'read', timeoutMs: 40 }, { agent: termAgent })
    check('read returns the screen without escape sequences',
      read.summary.includes('hello') && !read.summary.includes('\u001b'), JSON.stringify(read.summary))
    check('read says what the screen actually is (the viewport)', read.summary.includes('viewport'), read.summary)
    eq('read detaches, handing the keyboard back', stub.calls.detached, 1)
  }
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], onWrite: replyWithCommand })
    const run = await makeTermTool(stub).execute({ action: 'run', command: 'echo hi from the terminal' }, { agent: termAgent })
    check('run returns the command output and its exit code',
      run.summary.includes('hi from the terminal') && run.summary.includes('exit code: 0'), run.summary)
    check('run clears the pending input line before typing', stub.calls.write[0].data.startsWith('\u0015'), JSON.stringify(stub.calls.write[0].data.slice(0, 6)))
    // The whole point of the helper: the FIRST write defines it once, and the line that runs
    // the command is short enough to read.
    check('run defines the helper once, then calls it with the command',
      stub.calls.write[0].data.includes(`${HELPER_NAME}()`)
      && /__dsh_term_run [0-9a-f]{8} 'echo hi from the terminal'/.test(stub.calls.write[1].data),
      JSON.stringify(stub.calls.write.map((write) => write.data.slice(0, 44))))
    check('and both lines end with Enter',
      stub.calls.write[0].data.endsWith('\r') && stub.calls.write[1].data.endsWith('\r'),
      JSON.stringify(stub.calls.write.map((write) => write.data.slice(-2))))
    // A second command in the same terminal reuses the definition rather than re-sending it.
    const again = await makeTermTool(stub).execute({ action: 'run', command: 'echo again' }, { agent: termAgent })
    check('a second run reuses the helper', again.summary.includes('exit code: 0'), again.summary.slice(-80))
    eq('and does not define it again',
      stub.calls.write.filter((write) => write.data.includes(`${HELPER_NAME}()`)).length, 1)
    check('the second call carries the second command with a fresh nonce',
      /__dsh_term_run [0-9a-f]{8} 'echo again'/.test(stub.calls.write.at(-1).data)
      && nonceOf(stub.calls.write.at(-1).data) !== nonceOf(stub.calls.write[1].data),
      JSON.stringify(stub.calls.write.at(-1).data.slice(0, 44)))
    eq('run does not open a second terminal when one exists', stub.calls.create.length, 0)
    eq('run detaches as well', stub.calls.detached, 2)
    // Measured on a real sidebar terminal: after this tool detaches, the user's view
    // stays read-only until they click 接管输入, so the model must be told to say so.
    check('run tells the model the user has to take the input back',
      run.summary.includes('接管输入') && /tell them/i.test(run.summary), run.summary)
  }
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], screen: 'ready' })
    const listed = await makeTermTool(stub).execute({ action: 'list' }, { agent: termAgent })
    check('listing does not mention a keyboard handover, because it never attaches',
      !listed.summary.includes('接管输入'), listed.summary)
  }
  {
    const stub = makeTerminalStub({ terminals: [], onWrite: replyWithCommand })
    const run = await makeTermTool(stub).execute({ action: 'run', command: 'pwd' }, { agent: termAgent })
    eq('with no terminal at all the tool opens one', stub.calls.create[0]?.id, 'dsh-agent')
    eq('and drives the terminal it opened', stub.calls.follow[0]?.id, 'dsh-agent')
    check('the summary names the terminal it opened and does not promise a sidebar tab',
      run.summary.includes('opened by this tool') && run.summary.includes('may not appear there')
      && !run.summary.includes('visible in the sidebar'), run.summary)
    check('the opened terminal is described by the controller, not invented',
      run.summary.includes('/home/xiny') && run.summary.includes('120x30'), run.summary)
  }
  {
    const stub = makeTerminalStub({
      terminals: [],
      createError: (request) => (request.id === 'dsh-agent' ? new Error('Terminal was closed in this Session') : null),
      onWrite: replyWithCommand,
    })
    await makeTermTool(stub).execute({ action: 'run', command: 'pwd' }, { agent: termAgent })
    eq('an identity closed earlier falls through to the next name',
      stub.calls.create.map((call) => call.id).join(','), 'dsh-agent,dsh-agent-2')
  }
  {
    // A freshly created terminal: the first frames are the launcher's warning, the prompt comes
    // later. Typing before it loses the write, so the tool waits — and then types.
    const early = makeTerminalStub({
      terminals: [termInfoOf('t1')],
      screen: 'wsl: localhost proxy is not mirrored into WSL.\r\n',
      onWrite: (data) => (nonceOf(data) === null ? [] : [
        { type: 'output', data: `${START_PREFIX}${nonceOf(data)}\r\n` },
        { type: 'output', data: 'after the prompt\r\n' },
        { type: 'output', data: `${END_PREFIX}${nonceOf(data)}:0\r\n` },
      ]),
    })
    // The prompt arrives while the tool is waiting for it.
    const promptTimer = setTimeout(() => {
      early.pushFrame({ type: 'output', data: 'xiny@host:~$ ' })
    }, 60)
    const run = await makeTermTool(early).execute({ action: 'run', command: 'echo hi', timeoutMs: 4000 }, { agent: termAgent })
    clearTimeout(promptTimer)
    check('a just-created shell is typed into only once its prompt is there',
      run.summary.includes('after the prompt') && run.summary.includes('exit code: 0'), run.summary)
    // The definition may already have been sent for this id by an earlier test (the ready set is
    // per process), so what matters here is that the CALL was typed — and only after the prompt.
    check('and the call was typed after that prompt',
      early.calls.write.length >= 1
      && early.calls.write.at(-1).data.includes(`${HELPER_NAME} `)
      && early.calls.write.at(-1).data.includes("'echo hi'"),
      JSON.stringify(early.calls.write.map((write) => write.data.slice(0, 30))))
  }
  {
    // A shell that never becomes ready inside the call's own deadline: nothing is typed, and
    // the result says exactly that rather than pretending.
    const never = makeTerminalStub({
      terminals: [termInfoOf('t1')],
      screen: 'wsl: still starting\r\n',
    })
    const run = await makeTermTool(never).execute({ action: 'run', command: 'echo hi', timeoutMs: 120 }, { agent: termAgent })
    check('a shell that never shows a prompt gets nothing typed',
      run.summary.includes('nothing was typed'), run.summary)
    eq('and nothing was written to it', never.calls.write.length, 0)
  }
  {
    // The failure this instrumentation was built for: ONE frame, and it is a real (escaped)
    // serialized screen — and then the shell sends nothing more. The command must still be typed,
    // because nothing here needs another frame to arrive.
    const oneFrame = makeTerminalStub({
      terminals: [termInfoOf('t1')],
      screen: '',
      onWrite: (data) => (nonceOf(data) === null ? [] : [
        { type: 'output', data: `${START_PREFIX}${nonceOf(data)}\r\n` },
        { type: 'output', data: 'typed anyway\r\n' },
        { type: 'output', data: `${END_PREFIX}${nonceOf(data)}:0\r\n` },
      ]),
    })
    // Override the snapshot with an escaped prompt, and send no output before the write.
    const original = oneFrame.follow
    oneFrame.follow = (agent, id, attachmentId, signal) => {
      const inner = original.call(oneFrame, agent, id, attachmentId, signal)
      return (async function* escaped() {
        const first = await inner.next()
        if (!first.done && first.value?.type === 'snapshot') {
          yield { ...first.value, screen: '\u001b[1;32mxiny@XINY9\u001b[0m:\u001b[1;34m/home\u001b[0m$ \u001b[K' }
        } else if (!first.done) {
          yield first.value
        }
        for (;;) {
          const next = await inner.next()
          if (next.done) return
          yield next.value
        }
      })()
    }
    const run = await makeTermTool(oneFrame).execute({ action: 'run', command: 'echo typed' }, { agent: termAgent })
    check('a single escaped snapshot is enough to type the command',
      run.summary.includes('typed anyway') && run.summary.includes('exit code: 0'), run.summary)
  }
  {
    // Frames must survive the readiness polls. The loop keeps exactly ONE `next()` in flight: an
    // async generator queues concurrent requests FIFO and hands each yielded frame to the one at
    // the head, so abandoning a request silently swallows a future frame — here, the command's
    // own markers — and the call then waits out its deadline for a command that already finished.
    //
    // The screen deliberately does NOT start as a prompt, so the gate holds the write and the loop
    // really does poll: that is the state the abandoned requests came from.
    const spaced = makeTerminalStub({
      terminals: [termInfoOf('t1')],
      screen: 'wsl: still starting',
      onWrite: (data) => {
        const nonce = nonceOf(data)
        if (nonce === null) return []
        setTimeout(() => spaced.pushFrame({ type: 'output', data: `${START_PREFIX}${nonce}\r\n` }), 200)
        setTimeout(() => spaced.pushFrame({ type: 'output', data: 'spaced output\r\n' }), 500)
        setTimeout(() => spaced.pushFrame({ type: 'output', data: `${END_PREFIX}${nonce}:0\r\n` }), 800)
        return []
      },
    })
    // The prompt arrives while the gate is still holding the write, so polls have already happened.
    setTimeout(() => spaced.pushFrame({ type: 'output', data: 'xiny@XINY9:/home$ ' }), 900)
    const run = await makeTermTool(spaced).execute(
      { action: 'run', command: 'echo spaced', timeoutMs: 6000 }, { agent: termAgent })
    check('frames that arrive across poll windows are all seen',
      run.summary.includes('spaced output') && run.summary.includes('exit code: 0'), run.summary)
  }
  {
    // The shell lost the helper, so this call re-sends the definition — and the definition's own
    // echo contains `#DSH-START:`. Taking that echo for a marker would hide the accurate message
    // AND skip the `helperReady` reset, so the next call would refuse to define it again.
    const echoOnly = makeTerminalStub({
      terminals: [termInfoOf('echo-scan')],
      onWrite: (data) => [{ type: 'output', data: `\r\n${String(data).replace(/\u0015/g, '')}\r\n` }],
    })
    const tool = makeTermTool(echoOnly)
    const first = await tool.execute({ action: 'run', command: 'make syn', timeoutMs: 4000 }, { agent: termAgent })
    check('a definition echo containing the marker is not mistaken for one',
      first.summary.includes('nothing ran'), first.summary)
    const second = await tool.execute({ action: 'run', command: 'make syn', timeoutMs: 4000 }, { agent: termAgent })
    void second
    const definitions = echoOnly.calls.write.filter((write) => write.data.includes(`${HELPER_NAME}()`)).length
    check('and the helper is defined again on the next call', definitions >= 2, String(definitions))
  }
  {
    // A snapshot that lands after the readiness window must still be respected: window anchored to
    // the snapshot, not to the call. The screen never becomes a prompt, so the write can only be
    // released by the window itself — and it must not happen on the first frame after the window.
    const late = makeTerminalStub({ terminals: [termInfoOf('t1')], noSnapshot: true, screen: '' })
    const started = Date.now()
    setTimeout(() => late.pushFrame({ type: 'snapshot', sequence: 1, screen: 'wsl: still starting' }), 1800)
    setTimeout(() => late.pushFrame({ type: 'output', data: 'still no prompt here' }), 1900)
    const run = await makeTermTool(late).execute(
      { action: 'run', command: 'echo late', timeoutMs: 8000 }, { agent: termAgent })
    const wroteAt = (late.calls.write.at(-1)?.at ?? 0) - started
    check('a late snapshot still holds the write for its own readiness window',
      wroteAt >= 3200, `wrote at ${wroteAt} ms (expected >= 3200)`)
    void run
  }
  {
    // A cancelled call must hand the keyboard back at once instead of holding the attachment
    // until its own deadline.
    const cancellable = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const started = Date.now()
    await makeTermTool(cancellable).execute(
      { action: 'run', command: 'sleep 999', timeoutMs: 6000 },
      { agent: termAgent, signal: controller.signal })
    const elapsed = Date.now() - started
    check('a cancelled call releases the terminal immediately',
      elapsed < 3000 && cancellable.calls.detached >= 1, `elapsed ${elapsed} ms, detached ${cancellable.calls.detached}`)
  }
  {
    // The terminal path goes through the same dangerous-command guard as the one-shot path —
    // a terminal is where a mistyped command lands in a shell the user is watching — and a
    // refusal must not touch the terminal at all: no keystroke, nothing memorised.
    const guarded = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    const guardedTool = makeTermTool(guarded)
    await rejects('the terminal path refuses a destructive command', () => guardedTool.execute(
      { action: 'run', command: 'rm -rf /tmp/dsh-wsl-term-guard' }, { agent: termAgent }),
    /refused a destructive command/)
    eq('and the refusal typed nothing into the terminal', guarded.calls.write.length, 0)

    const allowedStub = makeTerminalStub({
      terminals: [termInfoOf('t1')],
      onWrite: (data) => (nonceOf(data) === null ? [] : [
        { type: 'output', data: `${START_PREFIX}${nonceOf(data)}\r\n` },
        { type: 'output', data: `${END_PREFIX}${nonceOf(data)}:0\r\n` },
      ]),
    })
    const allowed = await makeTermTool(allowedStub).execute(
      { action: 'run', command: 'rm -rf /tmp/dsh-wsl-term-guard', allowDangerous: true }, { agent: termAgent })
    check('an intended destructive command passes with allowDangerous',
      allowed.summary.includes('exit code: 0'), allowed.summary)

    const unguardedStub = makeTerminalStub({
      terminals: [termInfoOf('t1')],
      onWrite: (data) => (nonceOf(data) === null ? [] : [
        { type: 'output', data: `${START_PREFIX}${nonceOf(data)}\r\n` },
        { type: 'output', data: `${END_PREFIX}${nonceOf(data)}:0\r\n` },
      ]),
    })
    const unguarded = await makeTermTool(unguardedStub, { ...CONFIG, dangerGuard: false }).execute(
      { action: 'run', command: 'rm -rf /tmp/dsh-wsl-term-guard' }, { agent: termAgent })
    check('and the guard switch turns the refusal off here too',
      unguarded.summary.includes('exit code: 0'), unguarded.summary)
  }
  {
    // A shell that has the helper and whose command hangs: the start marker arrives, then
    // nothing, so the deadline is what ends the call.
    const stub = makeTerminalStub({
      terminals: [termInfoOf('t1')],
      onWrite: (data) => (nonceOf(data) !== null ? [{ type: 'output', data: `${START_PREFIX}${nonceOf(data)}\r\n` }] : []),
    })
    const run = await makeTermTool(stub).execute({ action: 'run', command: 'sleep 99', timeoutMs: 60 }, { agent: termAgent })
    check('a command that never returns is reported as still running',
      run.summary.includes('still running after 60 ms'), run.summary)
    check('and the caller is told how to stop it', run.summary.includes('interrupt'), run.summary)
    eq('a timeout still hands the keyboard back', stub.calls.detached, 1)
  }
  {
    // A shell WITHOUT the helper (a new shell in the same terminal, or `unset -f`): nothing
    // ran, and saying so beats reporting a timeout for a command that never started.
    const silent = makeTerminalStub({ terminals: [termInfoOf('fresh-1')], onWrite: () => [] })
    const run = await createWslTermTool({ ctx: { get: () => silent }, config: CONFIG, transport: transportOver(silent) })
      .execute({ action: 'run', command: 'echo hi', timeoutMs: 60 }, { agent: termAgent })
    check('a shell without the helper is reported as "nothing ran"',
      run.summary.includes('nothing ran') && run.summary.includes(HELPER_NAME), run.summary)
    check('and the next call promises to define it again',
      run.summary.includes('next `run` defines it again'), run.summary.slice(-200))
  }
  {
    const stub = makeTerminalStub({
      terminals: [termInfoOf('t1')],
      onWrite: () => [{ type: 'state', info: { ...termInfoOf('t1'), state: 'exited', exitCode: 130 } }],
    })
    const run = await makeTermTool(stub).execute({ action: 'run', command: 'exit' }, { agent: termAgent })
    check('a shell that exits mid-command is reported as an exit, with its code',
      run.summary.includes('did not return before the shell exited') && run.summary.includes('130'), run.summary)
  }

  // Long output: this is the case that produced the rule. A build log's answer is at
  // the bottom, so the tail comes back inline and the whole capture is filed.
  const longFrames = (data) => {
    const nonce = nonceOf(data)
    if (nonce === null) return []
    return [
      { type: 'output', data: `${START_PREFIX}${nonce}\r\n` },
      { type: 'output', data: `START-OF-LOG\r\n${'x'.repeat(25_000)}\r\nTHE-ACTUAL-ANSWER\r\n` },
      { type: 'output', data: `${END_PREFIX}${nonce}:0\r\n` },
    ]
  }
  const termCtx = (stub, spillStore) => ({
    get: (name) => (name === 'terminalController' ? stub : name === 'spillStore' ? spillStore : undefined),
  })
  {
    const spillCalls = []
    const spillStore = {
      async saveText(input) {
        spillCalls.push(input)
        return {
          locator: '/spilled/wsl-term-run-output.log',
          bytes: Buffer.byteLength(input.content, 'utf8'),
          retrievalHint: 'read it back with the file tools',
        }
      },
    }
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], onWrite: longFrames })
    const run = await createWslTermTool({ ctx: termCtx(stub, spillStore), config: CONFIG, transport: transportOver(stub) })
      .execute({ action: 'run', command: 'make syn' }, { agent: termAgent })
    check('a long command log returns its END, not its beginning',
      run.summary.includes('THE-ACTUAL-ANSWER') && !run.summary.includes('START-OF-LOG'), run.summary.slice(-240))
    check('and names the file that holds all of it',
      run.summary.includes('/spilled/wsl-term-run-output.log') && run.summary.includes('read it back'), run.summary.slice(-200))
    check('the spilled content is complete and free of escape sequences',
      spillCalls.length === 1 && spillCalls[0].content.includes('START-OF-LOG')
      && spillCalls[0].content.includes('THE-ACTUAL-ANSWER') && !spillCalls[0].content.includes('\u001b'),
      JSON.stringify(spillCalls[0]?.content?.length))
    check('and it is scoped to the calling session',
      spillCalls[0]?.owner?.sessionId === 'session-1', JSON.stringify(spillCalls[0]?.owner))
    check('the inline body is the configured window, not the whole log',
      run.summary.includes('earlier characters omitted'), run.summary.slice(-240))
  }
  {
    // No spill service (an older build): a temp file still beats losing the output.
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], onWrite: longFrames })
    const run = await makeTermTool(stub).execute({ action: 'run', command: 'make syn' }, { agent: termAgent })
    const path = /full output \(\d+ bytes\): (\S+)/.exec(run.summary)?.[1]
    check('without a spill service the output still lands in a file',
      typeof path === 'string' && path.includes('dsh-wsl-term-'), run.summary.slice(-200))
    if (typeof path === 'string') { try { rmSync(path, { force: true }) } catch { /* best effort */ } }
  }
  {
    // A storage failure must not fail a command that already ran.
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], onWrite: longFrames })
    const failing = { async saveText() { throw new Error('ENOSPC') } }
    const run = await createWslTermTool({ ctx: termCtx(stub, failing), config: CONFIG, transport: transportOver(stub) })
      .execute({ action: 'run', command: 'make syn' }, { agent: termAgent })
    check('a storage failure still reports the tail and the exit code',
      run.summary.includes('THE-ACTUAL-ANSWER') && run.summary.includes('exit code: 0'), run.summary.slice(-240))
    const path = /full output \(\d+ bytes\): (\S+)/.exec(run.summary)?.[1]
    if (typeof path === 'string') { try { rmSync(path, { force: true }) } catch { /* best effort */ } }
  }
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    const input = await makeTermTool(stub).execute({ action: 'input', data: 'ls', submit: true }, { agent: termAgent })
    eq('input sends the keystrokes with Enter', stub.calls.write[0].data, 'ls\r')
    check('the summary echoes what was typed', input.summary.includes('"ls"'), input.summary)
    // `input` is raw keystrokes, but with `submit` the line is EXECUTED — otherwise it would be
    // the one unguarded way to run a destructive command through a shell nobody inspected.
    const guardedInput = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    await rejects('input with submit goes through the destructive guard',
      () => makeTermTool(guardedInput).execute(
        { action: 'input', data: 'rm -rf /tmp/dsh-wsl-term-input', submit: true }, { agent: termAgent }),
      /refused a destructive command/)
    eq('and the refusal typed nothing', guardedInput.calls.write.length, 0)
    const rawOnly = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    await makeTermTool(rawOnly).execute({ action: 'input', data: 'rm -rf /tmp/dsh-wsl-term-input' }, { agent: termAgent })
    eq('without submit the same keys are only typed, not refused', rawOnly.calls.write.length, 1)
  }
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    const interrupt = await makeTermTool(stub).execute({ action: 'interrupt' }, { agent: termAgent })
    eq('interrupt sends Ctrl-C', stub.calls.write[0].data, '\u0003')
    check('the summary says Ctrl-C was sent', interrupt.summary.includes('Ctrl-C'), interrupt.summary)
  }
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    const tool = makeTermTool(stub)
    await rejects('close needs an explicit id', () => tool.execute({ action: 'close' }, { agent: termAgent }), /close needs an explicit/)
    const closed = await tool.execute({ action: 'close', id: 't1' }, { agent: termAgent })
    eq('close closes the terminal it was told to close', stub.calls.close[0], 't1')
    check('the summary confirms it', closed.summary.includes('closed.'), closed.summary)
  }
  // The host does not validate a plugin tool's parameters, so the tool's own checks are the only
  // boundary. A wrong type must be an ERROR, never a fall-through: `id: 7` used to be ignored and
  // the command was typed into whatever terminal the automatic selection picked instead.
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    const tool = makeTermTool(stub)
    await rejects('a non-string id is refused, not silently ignored',
      () => tool.execute({ action: 'run', id: 7, command: 'echo x' }, { agent: termAgent }), /id must be a string/)
    eq('and nothing was typed anywhere', stub.calls.write.length + stub.calls.follow.length, 0)
    await rejects('a non-boolean keepTerminal is refused',
      () => tool.execute({ action: 'subtask-done', subtask: 'x', keepTerminal: 'no' }, { agent: termAgent }),
      /keepTerminal must be a boolean/)
    await rejects('a non-boolean submit is refused',
      () => tool.execute({ action: 'input', data: 'x', submit: 'yes' }, { agent: termAgent }), /submit must be a boolean/)
    await rejects('a non-string subtask is refused',
      () => tool.execute({ action: 'run', command: 'echo x', subtask: 5 }, { agent: termAgent }), /subtask must be a string/)
  }
  {
    const stub = makeTerminalStub({
      terminals: [termInfoOf('t1')],
      writeError: { code: 'terminal/control-unavailable', message: 'Terminal input is controlled by another attachment' },
    })
    await rejects('a terminal someone else is typing into is reported, not fought over',
      () => makeTermTool(stub).execute({ action: 'run', command: 'ls' }, { agent: termAgent }), /another attachment/)
  }
  // A refused call must leave nothing behind: no terminal opened, no keyboard taken.
  {
    const bare = makeTerminalStub({ terminals: [] })
    await rejects('close without an id is refused', () => makeTermTool(bare).execute({ action: 'close' }, { agent: termAgent }),
      /needs an explicit id/)
    eq('and it did not open a terminal for a call that cannot run', bare.calls.create.length, 0)
    const bare2 = makeTerminalStub({ terminals: [] })
    await rejects('run without a command is refused', () => makeTermTool(bare2).execute({ action: 'run' }, { agent: termAgent }),
      /non-empty command/)
    eq('and that refusal opened nothing either', bare2.calls.create.length, 0)
    const bare3 = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    await rejects('input without keystrokes is refused', () => makeTermTool(bare3).execute({ action: 'input' }, { agent: termAgent }),
      /non-empty data/)
    eq('and it never attached or wrote', bare3.calls.follow.length + bare3.calls.write.length, 0)
  }
  // One keystroke is the whole call: the tool must let go instead of holding the keyboard
  // until the deadline (measured before the fix: 30 s for a single `input`).
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')] })
    const started = Date.now()
    const sent = await makeTermTool(stub).execute({ action: 'input', data: 'x', submit: true, timeoutMs: 3000 }, { agent: termAgent })
    const elapsed = Date.now() - started
    check('a keystroke call returns as soon as it has been sent', elapsed < 2500, `${elapsed} ms`)
    check('and it reports the keystroke', sent.summary.includes('sent "x" with Enter'), sent.summary.slice(-120))
    eq('the terminal was written once', stub.calls.write.length, 1)
  }
  // Nothing was typed if the deadline beats the first frame — saying otherwise is a lie the
  // caller cannot detect.
  {
    for (const [action, args] of [['input', { data: 'x' }], ['interrupt', {}], ['run', { command: 'ls' }]]) {
      const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], noSnapshot: true })
      const result = await makeTermTool(stub).execute({ action, ...args, timeoutMs: 150 }, { agent: termAgent })
      eq(`no snapshot means nothing was written for ${action}`, stub.calls.write.length, 0)
      check(`and ${action} says nothing was sent`,
        result.summary.includes('nothing was') || result.summary.includes('nothing was typed'), result.summary.slice(-200))
    }
  }
  // A transport that ignores the abort must not hold the call open past its own deadline.
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], stallOnReturn: true })
    const started = Date.now()
    await makeTermTool(stub).execute({ action: 'interrupt', timeoutMs: 400 }, { agent: termAgent })
    const elapsed = Date.now() - started
    check('a stalled detach does not extend the call', elapsed < 4000, `${elapsed} ms`)
  }
  await rejects('an unknown action is refused',
    () => makeTermTool(makeTerminalStub()).execute({ action: 'nope' }, { agent: termAgent }), /unknown action/)
  // Every declared action must be an accepted one. `subtask-done` was declared in the schema
  // enum and MISSING from the validator's own list, so the whole finish-a-record path was
  // dead code that only failed at the moment the model used it. Driving the declared enum
  // through the validator is what catches that class of bug.
  {
    const declared = makeTermTool(makeTerminalStub()).parameters.properties.action.enum
    check('the tool declares the finish action', declared.includes('subtask-done'), JSON.stringify(declared))
    for (const action of declared) {
      const stub = makeTerminalStub({ terminals: [termInfoOf('t1')] })
      let refused = null
      try {
        await makeTermTool(stub).execute({ action, timeoutMs: 120 }, { agent: termAgent })
      } catch (error) {
        refused = String(error?.message ?? error)
      }
      check(`\`${action}\` is accepted, not merely declared`,
        refused === null || !/unknown action/.test(refused), `${action} refused: ${refused}`)
    }
  }
  // The protocol end to end, through the tool: a run that names a subtask opens a record and
  // logs its command, and `subtask-done` writes the result and decides the shell.
  {
    const log = createSubtaskLog()
    const stub = makeTerminalStub({ terminals: [], onWrite: replyWithCommand })
    const tool = makeTermTool(stub, CONFIG, log)
    await tool.execute({ action: 'run', command: 'pwd', subtask: '检查重启后的子任务记录' }, { agent: termAgent })
    const running = log.list('session-1')
    check('a run that names a subtask opens a record for it',
      running.total === 1 && running.running === 1 && running.entries[0].title === '检查重启后的子任务记录',
      JSON.stringify(running))
    check('and the command it ran is on that record',
      running.entries[0].commands.map((entry) => entry.command).join('|') === 'pwd',
      JSON.stringify(running.entries[0].commands))
    let finished = null
    let failure = null
    try {
      finished = await tool.execute(
        { action: 'subtask-done', subtask: '检查重启后的子任务记录', result: '确认可用', keepTerminal: false },
        { agent: termAgent })
    } catch (error) {
      failure = String(error?.message ?? error)
    }
    const done = log.list('session-1')
    const entry = done.entries[0]
    check('subtask-done closes the record with its result',
      failure === null && done.running === 0 && entry?.result === '确认可用',
      `${failure ?? ''} ${JSON.stringify(done)}`)
    check('and keepTerminal:false closes the shell this tool opened',
      entry !== undefined && projectSubtask(entry).terminal === 'closed' && stub.calls.close.includes(entry.terminalId),
      `${entry === undefined ? 'no record' : JSON.stringify(projectSubtask(entry))} closes=${JSON.stringify(stub.calls.close)}`)
    check('and the action reports what it recorded',
      finished !== null && finished.summary.includes('确认可用'), String(finished?.summary ?? failure))
  }
  // A subtask can move between shells, and "this tool opened it" is what `subtask-done` reads
  // before closing a shell — while the tool promises never to close one the USER opened. So
  // joining the user's own terminal under the same subtask name must CLEAR that mark. Measured
  // shape before the fix: the entry kept created=true while its terminalId became the user's
  // terminal, and `subtask-done keepTerminal:false` closed the user's shell.
  {
    const log = createSubtaskLog()
    const stub = makeTerminalStub({ terminals: [], onWrite: replyWithCommand })
    const tool = makeTermTool(stub, CONFIG, log)
    await tool.execute({ action: 'run', command: 'pwd', subtask: '同步交接单' }, { agent: termAgent })
    const opened = log.list('session-1').entries[0]
    check('a shell this tool opened is marked as its own',
      opened?.terminalCreated === true && opened?.terminalId === 'dsh-agent',
      JSON.stringify({ created: opened?.terminalCreated, id: opened?.terminalId }))
    // The user opens their own terminal; the model joins it for the same subtask.
    stub.infos.push(termInfoOf('user-term'))
    await tool.execute({ action: 'run', command: 'ls', subtask: '同步交接单', id: 'user-term' }, { agent: termAgent })
    const joined = log.list('session-1').entries[0]
    check('joining a terminal the user opened moves the record onto it',
      joined?.terminalId === 'user-term', JSON.stringify(joined?.terminalId))
    check('and clears the "this tool opened it" mark',
      joined?.terminalCreated === false, JSON.stringify({ created: joined?.terminalCreated, id: joined?.terminalId }))
    const finished = await tool.execute(
      { action: 'subtask-done', subtask: '同步交接单', result: 'done', keepTerminal: false },
      { agent: termAgent })
    check('subtask-done never closes a terminal the user opened',
      !stub.calls.close.includes('user-term'), JSON.stringify(stub.calls.close))
    check('and says it left that terminal alone',
      typeof finished.summary === 'string' && finished.summary.includes('the user opened it'),
      String(finished?.summary).slice(-160))
  }
  // A subtask spans SEVERAL `run` calls in the same shell. The ownership mark describes the shell
  // the record points at, not "did this call create it": the second step used to reset it, so
  // `subtask-done keepTerminal:false` silently kept a shell this tool had opened and even called
  // it "the user opened it".
  {
    const log = createSubtaskLog()
    const stub = makeTerminalStub({ terminals: [], onWrite: replyWithCommand })
    const tool = makeTermTool(stub, CONFIG, log)
    await tool.execute({ action: 'run', command: 'echo one', subtask: '两步' }, { agent: termAgent })
    eq('the first step marks the shell it opened as the tool\'s own',
      log.list('session-1').entries[0]?.terminalCreated, true)
    await tool.execute({ action: 'run', command: 'echo two', subtask: '两步' }, { agent: termAgent })
    eq('the second step keeps that mark on the same shell',
      log.list('session-1').entries[0]?.terminalCreated, true)
    eq('and both steps reused one terminal', stub.calls.create.length, 1)
    const finished = await tool.execute(
      { action: 'subtask-done', subtask: '两步', result: 'done', keepTerminal: false }, { agent: termAgent })
    check('subtask-done closes the shell a multi-step subtask opened',
      stub.calls.close.includes('dsh-agent') && finished.summary.includes('closed (this tool opened it)'),
      `${JSON.stringify(stub.calls.close)} ${String(finished.summary).slice(-160)}`)
  }
  // A run that fails while attaching never typed anything: the record it opened must not stay
  // "running" for the rest of the run (the dock would show work in progress forever).
  {
    const log = createSubtaskLog()
    const stub = makeTerminalStub({ terminals: [] })
    stub.follow = () => { throw new Error('attach refused by the host') }
    const tool = makeTermTool(stub, CONFIG, log)
    const failure = await tool.execute({ action: 'run', command: 'echo x', subtask: '幽灵' }, { agent: termAgent })
      .then(() => null, (error) => String(error?.message ?? error))
    check('a failed attach is reported', /attach refused by the host/.test(String(failure)), String(failure))
    const entry = log.list('session-1').entries[0]
    eq('and the record it opened is finished, not left running', entry?.status, 'done')
    eq('with the failure as its result', entry?.result, '终端不可用')
  }
  // Automatic selection never lands on an exited private shell: a fresh one is opened instead.
  // An explicit id still reaches it (the caller named it).
  {
    const stub = makeTerminalStub({
      terminals: [{ ...termInfoOf('dead'), state: 'exited', exitCode: 0 }],
      onWrite: replyWithCommand,
    })
    const run = await makeTermTool(stub).execute({ action: 'run', command: 'echo fresh' }, { agent: termAgent })
    eq('an exited shell is not reused by the automatic choice', stub.calls.create[0]?.id, 'dsh-agent')
    check('and the fresh shell ran the command', run.summary.includes('exit code: 0'), run.summary.slice(-160))
    check('the header does not name the exited shell',
      !/terminal dead /.test(String(run.summary).split('\n')[0]), String(run.summary).slice(0, 120))
  }
  // Terminal ids are per Session, and a tool-opened terminal is named from a STABLE pool
  // (`dsh-agent`, `dsh-agent-2`, …), so two conversations both get `dsh-agent` — in two
  // different shells. The "this shell already has the helper" set is keyed by session +
  // terminal; keyed by terminal id alone, the second conversation's first `run` skipped the
  // definition line, typed a call into a shell that had never been given the helper, and
  // reported "nothing ran" about a command that never executed. The stub below is faithful:
  // it only knows the helper if THIS shell was told about it.
  {
    const shellThatOnlyKnowsWhatItWasTold = () => {
      let defined = false
      return (data) => {
        if (nonceOf(data) === null) {
          if (!data.includes(`${HELPER_NAME}()`)) return []
          defined = true
          return [{ type: 'output', data: `${(data.split('\r')[0] ?? '').replace('\u0015', '')}\r\n` }]
        }
        if (!defined) return [{ type: 'output', data: `bash: ${HELPER_NAME}: command not found\r\n` }]
        const nonce = nonceOf(data)
        return [
          { type: 'output', data: `${START_PREFIX}${nonce}\r\n` },
          { type: 'output', data: 'ran for real\r\n' },
          { type: 'output', data: `${END_PREFIX}${nonce}:0\r\n` },
        ]
      }
    }
    const sessionA = { id: 'session-helper-a' }
    const sessionB = { id: 'session-helper-b' }
    const stubA = makeTerminalStub({ terminals: [], onWrite: shellThatOnlyKnowsWhatItWasTold() })
    const stubB = makeTerminalStub({ terminals: [], onWrite: shellThatOnlyKnowsWhatItWasTold() })
    const runA = await makeTermTool(stubA).execute({ action: 'run', command: 'pwd' }, { agent: sessionA })
    const runB = await makeTermTool(stubB).execute({ action: 'run', command: 'pwd' }, { agent: sessionB })
    check('both conversations get a tool-opened terminal named the same',
      stubA.calls.create[0]?.id === 'dsh-agent' && stubB.calls.create[0]?.id === 'dsh-agent',
      JSON.stringify([stubA.calls.create[0]?.id, stubB.calls.create[0]?.id]))
    check('the first conversation defines the helper in its shell',
      stubA.calls.write[0]?.data.includes(`${HELPER_NAME}()`),
      JSON.stringify(stubA.calls.write.map((write) => write.data.slice(0, 40))))
    check('the second conversation defines it in ITS shell too',
      stubB.calls.write[0]?.data.includes(`${HELPER_NAME}()`),
      JSON.stringify(stubB.calls.write.map((write) => write.data.slice(0, 40))))
    check('and so its first run really executes',
      runA.summary.includes('ran for real') && runB.summary.includes('ran for real'),
      `${JSON.stringify(String(runA.summary).slice(-120))} | ${JSON.stringify(String(runB.summary).slice(-160))}`)
  }
  // A capture past its ceiling drops its HEAD, and this call's own start marker can be in what
  // fell off. The command ran; calling that "this shell has no helper" is a wrong diagnosis of
  // the shell — and it is why the `dropped === 0` guard exists. The deadline is short on
  // purpose: the marker is gone, so the loop cannot see completion and must time out.
  {
    const spillStore = {
      async saveText(input) {
        return {
          locator: '/spilled/wsl-term-run-output.log',
          bytes: Buffer.byteLength(input.content, 'utf8'),
          retrievalHint: 'read it back with the file tools',
        }
      },
    }
    const flooding = (data) => {
      const nonce = nonceOf(data)
      if (nonce === null) return []
      return [
        { type: 'output', data: `${START_PREFIX}${nonce}\r\n` },
        { type: 'output', data: `${'y'.repeat(4_200_000)}\r\n` },
        { type: 'output', data: `${END_PREFIX}${nonce}:0\r\n` },
      ]
    }
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], onWrite: flooding })
    const run = await createWslTermTool({ ctx: termCtx(stub, spillStore), config: CONFIG, transport: transportOver(stub) })
      .execute({ action: 'run', command: 'yes', timeoutMs: 1500 }, { agent: termAgent })
    check('a capture that lost its head is not reported as a missing helper',
      !String(run.summary).includes('nothing ran'), String(run.summary).slice(0, 220))
    check('and it still admits the capture is partial',
      /first \d+ characters were dropped/.test(String(run.summary)), String(run.summary).slice(-200))
  }
  // Every call that reaches the terminal service is bounded by the budget the caller gave the
  // call. Measured shape before the fix: a controller that stopped answering held the tool open
  // past its own `timeoutMs`, with the user's terminal still attached — and therefore read-only.
  {
    const started = Date.now()
    let failure = null
    try {
      await makeTermTool(makeTerminalStub({ terminals: [], stallOnCreate: true }))
        .execute({ action: 'run', command: 'pwd', timeoutMs: 300 }, { agent: termAgent })
    } catch (error) {
      failure = String(error?.message ?? error)
    }
    const elapsed = Date.now() - started
    check('a create that never answers fails fast instead of hanging',
      failure !== null && /did not answer/.test(failure), String(failure))
    check('and it gives up on the call budget, not on the provider\'s patience',
      elapsed < 3000, `${elapsed} ms`)
  }
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t1')], stallOnWrite: true })
    const started = Date.now()
    let failure = null
    try {
      await makeTermTool(stub).execute({ action: 'input', data: 'x', timeoutMs: 300 }, { agent: termAgent })
    } catch (error) {
      failure = String(error?.message ?? error)
    }
    const elapsed = Date.now() - started
    check('a write that never answers fails fast too',
      failure !== null && /did not answer/.test(failure), String(failure))
    check('and the keyboard is still handed back',
      stub.calls.detached >= 1 && elapsed < 5000, `${elapsed} ms detached=${stub.calls.detached}`)
  }
  {
    // A close the tool is allowed to send (its own shell) but the service never answers.
    const stub = makeTerminalStub({ terminals: [], stallOnClose: true })
    const tool = makeTermTool(stub)
    const opened = await tool.execute({ action: 'run', command: 'echo hi', timeoutMs: 300 }, { agent: termAgent })
    const ownId = /terminal (\S+) "/.exec(opened.summary)?.[1]
    await rejects('an explicit close that never answers is reported, not waited out',
      () => tool.execute({ action: 'close', id: ownId, timeoutMs: 300 }, { agent: termAgent }),
      /did not answer/)
  }
  {
    // The close a `subtask-done` sends is a courtesy: the record is already finished, so a silent
    // service has to be reported in the summary instead of turning that into a failed call.
    const log = createSubtaskLog()
    const stub = makeTerminalStub({ terminals: [], onWrite: replyWithCommand })
    const tool = makeTermTool(stub, CONFIG, log)
    await tool.execute({ action: 'run', command: 'pwd', subtask: '收尾' }, { agent: termAgent })
    stub.stall.close = true
    const finished = await tool.execute(
      { action: 'subtask-done', subtask: '收尾', result: 'done', keepTerminal: false, timeoutMs: 300 },
      { agent: termAgent })
    check('a close that never answers does not fail a finished subtask',
      String(finished.summary).includes('is done.') && /close request went unanswered/.test(String(finished.summary)),
      String(finished.summary))
  }
  // DSH 0.2.1 replaced `terminalController.follow`/`write` with an attachment that reads the
  // CALLER's Remote invocation uplink, which a plugin cannot supply — the tool died with
  // `controller.follow is not a function` and every terminal action was unusable. The fix drives
  // a PTY this plugin owns (`subprocess.spawnTerminal`) and wraps it in the same five calls.
  // The stub below is a 0.2.1 host: the controller has the NEW api and no `follow`.
  const makePtyHost = () => {
    const calls = { writes: [], terminated: 0, spawn: [], shell: 0 }
    let finished = false
    let exitResolve
    const done = new Promise((resolve) => { exitResolve = resolve })
    const queue = []
    const waiters = []
    const push = (text) => {
      const value = Buffer.from(String(text), 'utf8')
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else queue.push(value)
    }
    const output = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
            if (finished) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => waiters.push(resolve))
          },
        }
      },
    }
    const handle = {
      output,
      done,
      write(data) {
        const text = String(data)
        calls.writes.push(text)
        if (text.includes(`${HELPER_NAME}()`)) {
          // A real PTY echoes the definition line; that echo must not pass for a marker.
          push(`${text.replace(/^\u0015/, '').split('\r')[0]}\r\n`)
          return
        }
        const nonce = nonceOf(text)
        if (nonce === null) return
        push(`${START_PREFIX}${nonce}\r\n`)
        push('pty output line\r\n')
        push(`${END_PREFIX}${nonce}:1\r\n`)
      },
      async terminate() { calls.terminated += 1; finished = true; exitResolve({ exitCode: 0 }) },
      async resize() {},
      async inspectActivity() { return { state: 'idle', revision: 0 } },
    }
    const subprocess = {
      resolveExecutable: async (name) => { calls.shell += 1; return `C:/Windows/System32/${name}` },
      spawnTerminal: async (spec) => { calls.spawn.push(spec); return handle },
    }
    // A 0.2.1 controller: list/create/attach/close, and deliberately no follow/write.
    const controller = { list: () => [], create: async () => {}, attach: () => {}, close: async () => {} }
    const ctx = {
      get: (name) => (name === 'subprocess' ? subprocess : name === 'terminalController' ? controller : undefined),
    }
    return { ctx, calls }
  }
  const makePtyTool = (host, subtasks = null) => createWslTermTool({ ctx: host.ctx, config: { ...CONFIG, distro: 'Ubuntu-22.04' }, subtasks })
  // A session workspace the shell should start in, and the translation the launcher must use.
  const ptyAgent = { id: 'session-pty', session: { header: { cwd: 'C:\\work\\proj' } } }
  {
    const host = makePtyHost()
    const log = createSubtaskLog()
    const tool = makePtyTool(host, log)
    const run = await tool.execute({ action: 'run', command: 'pwd', subtask: '0.2.1 的终端' }, { agent: ptyAgent })
    check('on a 0.2.1 host the tool drives its own PTY instead of dying on follow',
      String(run.summary).includes('pty output line') && String(run.summary).includes('exit code: 1'),
      String(run.summary))
    check('and it starts the configured distribution in the session workspace',
      JSON.stringify(host.calls.spawn[0]?.argv) === JSON.stringify([
        'C:/Windows/System32/wsl.exe', '-d', 'Ubuntu-22.04', '--cd', '/mnt/c/work/proj', '-e', 'bash', '-l',
      ]),
      JSON.stringify(host.calls.spawn[0]?.argv))
    check('and the header names that workspace',
      String(run.summary).includes('/mnt/c/work/proj'), String(run.summary).slice(0, 220))
    check('the helper is defined in that shell before the first call',
      host.calls.writes[0]?.includes(`${HELPER_NAME}()`) && host.calls.writes.length >= 2,
      JSON.stringify(host.calls.writes.map((write) => write.slice(0, 30))))
    check('a private PTY says it is not in the sidebar',
      String(run.summary).includes('does not appear in the sidebar'), String(run.summary).slice(0, 240))
    check('the subtask is recorded on the PTY shell',
      log.list('session-pty').entries[0]?.terminalId === 'dsh-agent' && log.list('session-pty').entries[0]?.terminalCreated === true,
      JSON.stringify(log.list('session-pty').entries[0]?.terminalId))
    const listed = await tool.execute({ action: 'list' }, { agent: ptyAgent })
    check('list names the PTY shell it opened', String(listed.summary).includes('id=dsh-agent'), String(listed.summary))
    const finished = await tool.execute(
      { action: 'subtask-done', subtask: '0.2.1 的终端', result: 'done', keepTerminal: false }, { agent: ptyAgent })
    check('keepTerminal:false kills the PTY',
      host.calls.terminated === 1 && String(finished.summary).includes('closed'), String(finished.summary))
  }
  {
    // The pre-bridge generation (a controller that only speaks follow/write, DSH ≤ 0.2.0) is no
    // longer supported: a host offering nothing else must not fall back to driving the user's
    // browser terminal behind their back.
    const ctx = {
      get: (name) => (name === 'terminalController'
        ? { follow() {}, write() {}, list: () => [], create: async () => {}, close: async () => {} }
        : undefined),
    }
    const legacy = ctx.get('terminalController')
    const transport = createTerminalTransport({ ctx, config: CONFIG })
    check('a follow/write-only controller is never used as the transport', transport !== legacy, String(transport))
    await rejects('and the tool explains that this build is unsupported',
      () => createWslTermTool({ ctx: { get: () => undefined }, config: CONFIG })
        .execute({ action: 'list' }, { agent: termAgent }),
      /no terminal this plugin can drive/)
  }
  await rejects('subtask-done without the subtask name is refused',
    () => makeTermTool(makeTerminalStub(), CONFIG, createSubtaskLog())
      .execute({ action: 'subtask-done' }, { agent: termAgent }), /needs .?subtask/)
  await rejects('run without a command is refused before attaching',
    () => makeTermTool(makeTerminalStub({ terminals: [termInfoOf('t1')] })).execute({ action: 'run' }, { agent: termAgent }),
    /non-empty command/)
  // A vanished id must not break the workflow: ids change when the app re-creates a
  // terminal, and the caller has no way to know. It falls back, and says so.
  {
    const stub = makeTerminalStub({ terminals: [termInfoOf('t2')] })
    const run = await makeTermTool(stub).execute({ action: 'read', id: 'zz' }, { agent: termAgent })
    check('a vanished id falls back to the terminal that is there',
      run.summary.includes('terminal t2') && run.summary.includes('"zz" is gone'), run.summary)
    check('and it says which one it used instead',
      run.summary.includes('one of this tool\'s own shells was used'), run.summary.slice(0, 340))
  }
  {
    const stub = makeTerminalStub({ terminals: [] })
    const run = await makeTermTool(stub).execute({ action: 'read', id: 'zz' }, { agent: termAgent })
    check('a vanished id with nothing left opens a terminal instead of failing',
      run.summary.includes('opened a terminal') || run.summary.includes('a new one was opened'), run.summary.slice(0, 400))
  }
  await rejects('close with an unknown id is still refused (it never ends a terminal nobody named)',
    () => makeTermTool(makeTerminalStub({ terminals: [termInfoOf('t1')] })).execute({ action: 'close', id: 'zz' }, { agent: termAgent }),
    /no terminal with id/)

  await rejects('a non-positive timeout is refused',
    () => makeTermTool(makeTerminalStub({ terminals: [termInfoOf('t1')] })).execute({ action: 'run', command: 'ls', timeoutMs: -1 }, { agent: termAgent }),
    /positive number/)
  await rejects('input without keystrokes is refused',
    () => makeTermTool(makeTerminalStub({ terminals: [termInfoOf('t1')] })).execute({ action: 'input' }, { agent: termAgent }),
    /non-empty data/)
  await rejects('a build without a drivable terminal says so instead of throwing a type error',
    () => createWslTermTool({ ctx: { get: () => undefined }, config: CONFIG }).execute({ action: 'list' }, { agent: termAgent }),
    /no terminal this plugin can drive/)
  await rejects('a call with no agent session is refused',
    () => makeTermTool(makeTerminalStub()).execute({ action: 'list' }, {}), /owning agent session/)

  // Most distributions do not ship `rg`, so the fallback is what actually runs on them.
  // The preferred engine's parser still has to be right, and it can be tested on the
  // records `rg --json` documents instead of on an installed binary: the two engines
  // must produce ONE shape, or `wsl-grep` means two different things depending on what
  // the user happened to install.
  console.log('\nfile tools: the two search engines parse to one shape')
  {
    const rgBody = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'src/a.ts' }, lines: { text: 'const x = 1\n' }, line_number: 12 } }),
      JSON.stringify({ type: 'context', data: { path: { text: 'src/a.ts' }, lines: { text: 'noise\n' }, line_number: 13 } }),
      JSON.stringify({
        type: 'match',
        data: { path: { bytes: Buffer.from('src/中文.ts', 'utf8').toString('base64') }, lines: { text: 'y\n' }, line_number: 3 },
      }),
      JSON.stringify({ type: 'summary', data: { stats: {} } }),
    ].join('\n')
    const rg = parseRgJson(rgBody)
    eq('rg json: only match records become results', rg.length, 2)
    eq('rg json: the path, the line number and the line survive',
      JSON.stringify(rg[0]), JSON.stringify({ file: 'src/a.ts', line: 12, text: 'const x = 1' }))
    eq('rg json: a non-UTF-8 path arrives base64-encoded and is decoded', rg[1].file, 'src/中文.ts')
    eq('rg json: a malformed stream yields no matches instead of throwing',
      parseRgJson('{"type":"match","data":{}}\nnot json at all\n').length, 0)

    const grep = parseGrepZ('src/a.ts\u000012:const x = 1\nsrc/b.ts\u00003:y\n')
    eq('grep -Z: every line is one match', grep.length, 2)
    eq('grep -Z: the NUL is what separates a path from a line number',
      JSON.stringify(grep[0]), JSON.stringify({ file: 'src/a.ts', line: 12, text: 'const x = 1' }))
    eq('grep -Z: a colon in a path does not confuse it', parseGrepZ('a:b.ts\u00007:z\n')[0].file, 'a:b.ts')

    eq('a line under the preview cap is returned untouched', previewLine('short', 2000), 'short')
    check('a line over the cap is cut and marked', previewLine('x'.repeat(3000), 2000).endsWith('…'))
    const wide = previewLine('中'.repeat(1000), 2000)
    check('the cut never splits a multi-byte character',
      !wide.includes('\ufffd') && Buffer.byteLength(wide, 'utf8') <= 2003, `${Buffer.byteLength(wide, 'utf8')} bytes`)

    const script = grepScript({ path: '~/src', pattern: 'a b', include: '*.ts' })
    check('the script prefers rg when the distribution has it', script.includes('command -v rg'))
    check('and falls back to grep -E with a NUL-separated name', script.includes('grep -r -n -I -H -Z -E'))
    check('the include reaches both engines', script.includes("--glob='*.ts'") && script.includes("--include='*.ts'"))
    check('a pattern with a space stays one word', script.includes("--regexp='a b'") && script.includes("-e 'a b'"))
    check('the target is quoted once and used from a variable', script.includes("p=~/'src'") && script.includes('"$p"'))
    const bare = grepScript({ path: '.', pattern: 'x' })
    check('without an include neither engine gets a filter',
      !bare.includes('--glob=') && !bare.includes('--include='))
  }

  // Two properties of the file scripts that are cheaper to read than to run, and
  // that a reader of the output could not otherwise tell apart.
  console.log('\nfile tools: the scripts ask before they assume')
  {
    // A read prints the file's byte count BEFORE it can know the file is readable.
    // Without the guard the header would report a size of 0 for a file the caller
    // may not open, which is indistinguishable from an empty file.
    const read = readScript('/etc/shadow', 1, 10)
    const guardAt = read.indexOf('[ ! -r "$p" ]')
    check('the read refuses an unreadable file before counting its bytes',
      guardAt !== -1 && guardAt < read.indexOf('wc -c'), read)
    check('and says why, with its own exit code', read.includes('permission denied') && read.includes('exit 10'))
    check('an unreadable file is not reported as an empty one',
      !read.includes('exit 0\nprintf'), read)

    const plain = writeScript('/tmp/a')
    check('a plain write copies the mode only', plain.includes('chmod --reference=') && !plain.includes('chown'))
    check('the mode is copied without assuming GNU chmod',
      plain.includes('stat -c %a') && plain.includes('chmod "$m"'), plain)
    check('an unresolvable symlink is refused instead of replacing the link',
      plain.includes('if [ -L "$p" ]') && plain.includes('readlink -f -- "$p"'))
    const owned = writeScript('/tmp/a', { keepOwner: true })
    check('keepOwner copies the owner as well', owned.includes('chown --reference="$p" -- "$t"'), owned)
    check('keepOwner still copies the mode', owned.includes('chmod --reference="$p" -- "$t"'))
    check('a failed chown never fails the write',
      owned.includes('if chown --reference="$p" -- "$t" 2>/dev/null; then :;')
      && owned.includes('chown "$o" -- "$t" 2>/dev/null || :'), owned)

    // The scratch-file exit code has to BE a number: `exit ${FS_EXIT.INTERNAL}`
    // with a missing entry makes bash print "numeric argument required" and leave
    // with 2, which a caller would report as a search failure.
    check('the search script always exits with a number',
      !/\bexit undefined\b/.test(grepScript({ path: '.', pattern: 'x' }))
      && Number.isInteger(FS_EXIT.INTERNAL) && FS_EXIT.INTERNAL > 0, String(FS_EXIT.INTERNAL))

    // `\d` is the one rg escape GNU grep -E reads as a literal `d`: leaving it
    // alone turns `\d+` into "matches dd" — an exit-0 answer that is silently
    // wrong. The fallback translates it; `\w`, `\s` and `\b` mean the same in both
    // engines and are left alone.
    eq('grep fallback: \\d becomes a digit class', grepFallbackPattern('\\d+'), '[0-9]+')
    eq('grep fallback: \\D becomes a negated digit class', grepFallbackPattern('\\D'), '[^0-9]')
    eq('grep fallback: \\w, \\s and \\b are shared escapes and stay',
      grepFallbackPattern('\\w+\\s\\b'), '\\w+\\s\\b')
    eq('grep fallback: an escaped backslash is not a digit class',
      grepFallbackPattern('\\\\d'), '\\\\d')
    eq('grep fallback: inside a bracket expression the range is inlined',
      grepFallbackPattern('[\\d.]'), '[0-9.]')
    eq('grep fallback: a negated class keeps its caret',
      grepFallbackPattern('[^\\d]'), '[^0-9]')
    const digitScript = grepScript({ path: '.', pattern: 'id\\d+' })
    check('the fallback command runs the translated pattern',
      digitScript.includes("grep -r -n -I -H -Z -E -e 'id[0-9]+'"), digitScript.slice(0, 400))
    check('while rg keeps the ripgrep syntax it understands',
      digitScript.includes("--regexp='id\\d+'"), digitScript.slice(0, 400))
  }

  // The platform's own read/write/edit tools cannot reach a distribution: its home is a 9p
  // share (`\\wsl.localhost\...`) and the write path there dies at the rename that makes the
  // write atomic. These three tools run the same operations INSIDE the distribution instead,
  // so what they are tested for is file semantics — text versus binary, a file versus a
  // directory, a unique match versus an ambiguous one — not the transport, which `wsl` already
  // covers. Every path here is created by the test: nothing depends on the author's home.
  console.log('\nfile tools: read, write and edit inside the distribution')
  const fsRoot = (await tools.wsl.execute({
    command: 'mktemp -d', description: 'a scratch directory for the file-tool tests',
  })).stdout.trim()
  check('the scratch directory is absolute', fsRoot.startsWith('/'), fsRoot)
  const samplePath = `${fsRoot}/sample.txt`
  const sampleText = '第一行：中文\nsecond "quoted" line\n$HOME and `ticks`\nno trailing newline'
  try {
    // `read` answers with numbered lines, exactly as the host's own `read` does: the number
    // is what a follow-up edit or a citation needs, the text is what the model reasons
    // about. This helper turns a window back into the raw text, so the assertions below can
    // talk about the file instead of about the envelope.
    const readText = (value) => value.lines.map((line) => line.text).join('\n')

    const created = await tools['wsl-write'].execute({ path: samplePath, content: sampleText }, {})
    eq('a write to a path that was not there reports a create', created.operation, 'create')
    // The value names the file and what happened to it, and stops there: the content is
    // already in the arguments (where the diff card reads it from, and where a replay
    // still has it), and a before-image cannot be expressed — the host's schema subset
    // has no `type: ['string', 'null']`, and a rejected schema unmounts the tool.
    eq('the write result carries the file and the operation, not the content',
      Object.keys(created).sort().join(','), 'operation,path')
    eq('write resolves the path to one absolute location', created.path, samplePath)
    {
      const rendered = tools['wsl-write'].output.render({}, created)[0].text
      check('write renders the host acknowledgement a model already knows',
        rendered.startsWith(`<path>${samplePath}</path>`) && rendered.includes('Created file'), rendered)
    }

    const whole = await tools['wsl-read'].execute({ path: samplePath }, {})
    eq('read returns the exact text, unnumbered', readText(whole), sampleText)
    eq('read counts an unterminated last line', whole.totalLines, 4)
    eq('read numbers its lines from 1', whole.lines[0].number, 1)
    {
      const rendered = tools['wsl-read'].output.render({}, whole)[0].text
      check('read renders the host envelope, so the model reads one format',
        rendered.startsWith(`<path>${samplePath}</path>`), rendered.slice(0, 120))
      check('and numbers every line inside it', rendered.includes('1: 第一行：中文'), rendered.slice(0, 200))
      check('and closes with the end-of-file footer', rendered.includes('(End of file - total 4 lines)'), rendered.slice(-80))
    }

    const sliced = await tools['wsl-read'].execute({ path: samplePath, offset: 2, limit: 2 }, {})
    eq('offset/limit slice by line', readText(sliced), 'second "quoted" line\n$HOME and `ticks`')
    eq('the slice reports where it started', sliced.offset, 2)
    eq('the slice reports how many lines it holds', sliced.lines.length, 2)
    eq('and still knows the file is longer than the window', sliced.totalLines, 4)
    {
      const rendered = tools['wsl-read'].output.render({ offset: 2, limit: 2 }, sliced)[0].text
      check('a windowed read says where to continue next',
        rendered.includes('(Showing lines 2-3 of 4. Use offset=4 to continue.)'), rendered.slice(-120))
    }

    // The UI side of a read: the platform's `read` card, not the model-facing envelope.
    // The structured window cannot be recovered from the text, so it rides in the persisted
    // metadata and `presentResult` narrows it back — which is also what makes a replayed
    // read redraw without touching the file again.
    {
      const call = tools['wsl-read'].presentCall({ path: samplePath, offset: 3 })
      eq('a read call is a generic card that knows it is a read', call.card + '/' + call.kind, 'generic/read')
      check('and its title names the file', call.title.includes(samplePath), call.title)
      eq('and it follows the file at the first line read', call.locations[0].line, 3)

      const meta = tools['wsl-read'].output.presentationMeta({}, whole)
      const card = tools['wsl-read'].presentResult({ path: samplePath }, { content: [], isError: false, meta })
      eq('a completed read presents the platform read card', card.card, 'read')
      eq('the card carries the resolved path', card.path, samplePath)
      eq('and the window start', card.offset, 1)
      eq('and every numbered line', card.lines.length, 4)
      eq('and the file total, so the UI can say "4 of 4"', card.totalLines, 4)
      eq('a .txt file has no language hint, so it renders as plain text', card.lang, undefined)
      check('a UI without the read capability gets the window without the envelope',
        card.content[0].text.startsWith('1: 第一行：中文') && !card.content[0].text.includes('<path>'),
        card.content[0].text.slice(0, 80))

      // The hint is what makes the card a code view instead of a wall of text.
      await tools['wsl-write'].execute({ path: `${fsRoot}/probe.py`, content: 'print(1)\n' }, {})
      const py = await tools['wsl-read'].execute({ path: `${fsRoot}/probe.py` }, {})
      const pyMeta = tools['wsl-read'].output.presentationMeta({}, py)
      eq('a .py file carries a python hint',
        tools['wsl-read'].presentResult({ path: py.path }, { content: [], isError: false, meta: pyMeta }).lang, 'python')
      eq('the hint is persisted with the result, so a replay keeps it', pyMeta.lang, 'python')

      eq('a failed read presents nothing, so the UI falls back',
        tools['wsl-read'].presentResult({ path: samplePath }, { content: [], isError: true }), undefined)
      eq('a replayed read without metadata presents nothing',
        tools['wsl-read'].presentResult({ path: samplePath }, { content: [], isError: false }), undefined)
    }

    // A directory, a missing path and a binary file are the three ways "read this file"
    // means something else. Each has its own message, because "failed" is not a diagnosis.
    await rejects('reading a directory is refused, and says so',
      () => tools['wsl-read'].execute({ path: fsRoot }, {}), /is a directory/)
    await rejects('reading a missing path is refused, and says so',
      () => tools['wsl-read'].execute({ path: `${fsRoot}/not-here.txt` }, {}), /no such file or directory/)
    await tools['wsl-write'].execute({ path: `${fsRoot}/blob.dat`, content: 'text\u0000more' }, {})
    await rejects('reading a binary file is refused rather than returned as mojibake',
      () => tools['wsl-read'].execute({ path: `${fsRoot}/blob.dat` }, {}), /binary file/)

    // The mode is the part a naive rewrite loses: `cat > file` keeps the inode, and a
    // temp-file-and-rename keeps the CONTENT but replaces the inode. The edit path copies
    // the old mode onto the new file, so a 755 script stays executable.
    await tools.wsl.execute({ command: `chmod 755 ${samplePath}`, description: 'make the sample executable' })
    const edited = await tools['wsl-edit'].execute({
      path: samplePath, oldString: 'second "quoted" line', newString: 'SECOND line',
    }, {})
    eq('edit reports one replacement', edited.replacements, 1)
    eq('edit reports the byte size before the change', edited.beforeBytes, Buffer.byteLength(sampleText))
    eq('edit reports the byte size after the change', edited.afterBytes, Buffer.byteLength(sampleText) - 9)
    eq('edit leaves the file executable',
      (await tools.wsl.execute({ command: `stat -c %a ${samplePath}`, description: 'read the mode back' })).stdout.trim(),
      '755')
    eq('edit wrote exactly the replacement',
      readText(await tools['wsl-read'].execute({ path: samplePath }, {})),
      sampleText.replace('second "quoted" line', 'SECOND line'))

    // `$&`, `$1` and a backtick are literal text here: the replacement is not a shell
    // string and not a regexp replacement pattern, so nothing in it can expand.
    const literal = await tools['wsl-edit'].execute({
      path: samplePath, oldString: 'SECOND line', newString: 'cost: $& $1 `x`',
    }, {})
    eq('a replacement full of metacharacters is inserted literally', literal.replacements, 1)
    check('the metacharacters survived',
      readText(await tools['wsl-read'].execute({ path: samplePath }, {})).includes('cost: $& $1 `x`'))

    await rejects('an ambiguous match is refused rather than guessed',
      () => tools['wsl-edit'].execute({ path: samplePath, oldString: 'a', newString: 'b' }, {}),
      /appears \d+ times/)
    await rejects('a match that is not there is refused',
      () => tools['wsl-edit'].execute({ path: samplePath, oldString: 'zzz-not-here', newString: 'b' }, {}),
      /was not found/)
    await rejects('an identical old and new string is refused as a no-op',
      () => tools['wsl-edit'].execute({ path: samplePath, oldString: 'x', newString: 'x' }, {}),
      /nothing to change/)
    const every = await tools['wsl-edit'].execute({
      path: samplePath, oldString: '\n', newString: '\n\n', replaceAll: true,
    }, {})
    eq('replaceAll counts every match it made', every.replacements, 3)

    // The UI side of an edit: a pending card built from the arguments, then the applied
    // hunks. Neither reaches the model — the text above is what it reads — so the assertions
    // here are about what a reader sees, and about a card surviving a replay without the file.
    const editCall = tools['wsl-edit'].presentCall({ path: samplePath, oldString: 'second', newString: 'SECOND' })
    eq('an edit call presents a diff card', editCall.card, 'diff')
    eq('the pending card shows the literal replacement', editCall.diffs[0].oldText, 'second')
    eq('and the text it becomes', editCall.diffs[0].newText, 'SECOND')
    eq('the pending card follows the file', editCall.locations[0].path, samplePath)
    check('an edit result carries hunks for the card', Array.isArray(edited.diffs) && edited.diffs.length === 1,
      JSON.stringify(edited.diffs))
    check('a hunk is a window of the file it changed',
      edited.diffs[0].oldText.includes('second "quoted" line') && edited.diffs[0].newText.includes('SECOND line'),
      JSON.stringify(edited.diffs[0]))
    eq('the hunks come through the presentation metadata',
      JSON.stringify(tools['wsl-edit'].output.presentationMeta({}, edited)), JSON.stringify({ path: edited.path, diffs: edited.diffs }))
    const editShown = tools['wsl-edit'].presentResult({ path: samplePath }, {
      content: [], isError: false, meta: tools['wsl-edit'].output.presentationMeta({}, edited),
    })
    eq('a completed edit presents the applied diff', editShown.card, 'diff')
    check('the completed card draws the change', editShown.diffs[0].newText.includes('SECOND line'), JSON.stringify(editShown.diffs))
    eq('a failed edit presents nothing, so the UI falls back',
      tools['wsl-edit'].presentResult({ path: samplePath }, { content: [], isError: true }), undefined)
    eq('a replayed result without metadata presents nothing',
      tools['wsl-edit'].presentResult({ path: samplePath }, { content: [], isError: false }), undefined)
    eq('the model-facing text of an edit is unchanged by the card',
      tools['wsl-edit'].output.render({}, edited)[0].text.includes('1 replacement'), true)

    // A write draws the card the platform's own `write` draws: no before-image, so every
    // line is an addition. The content comes from the arguments -- which a replay still
    // has -- so unlike an edit there is no metadata to carry.
    const writeArgs = { path: samplePath, content: 'one\ntwo\nthree\n' }
    const writeCall = tools['wsl-write'].presentCall(writeArgs)
    eq('a write call presents a diff card', writeCall.card, 'diff')
    eq('a write has no old side, so the diff is all additions', writeCall.diffs[0].oldText, null)
    eq('the write card carries the content that was written', writeCall.diffs[0].newText, writeArgs.content)
    eq('the write card follows the file', writeCall.locations[0].path, samplePath)
    eq('a completed write presents the content it wrote',
      tools['wsl-write'].presentResult(writeArgs, { content: [], isError: false }).diffs[0].newText, writeArgs.content)
    eq('a failed write presents nothing, so the UI falls back',
      tools['wsl-write'].presentResult(writeArgs, { content: [], isError: true }), undefined)
    eq('a replayed write with no content draws an empty addition',
      tools['wsl-write'].presentResult({ path: samplePath }, { content: [], isError: false }).diffs[0].newText, '')

    // `~` and a nested directory that does not exist yet: the first is what a model
    // writes when it means the home, the second is what it writes when it means "put it
    // there", and both have to work without a shell call to prepare them.
    // A previous run may have left this tree behind, and the assertion below is that THIS
    // write creates the parents — so the tree has to be absent before it.
    await tools.wsl.execute({ command: 'rm -rf ~/dsh-fs-smoke', description: 'clear a previous run', allowDangerous: true })
    const nested = await tools['wsl-write'].execute({
      path: '~/dsh-fs-smoke/深 层/文件.txt', content: 'tilde ok',
    }, {})
    check('write expands `~` to the home directory', /^\/home\/[^/]+\/dsh-fs-smoke\/深 层\/文件\.txt$/.test(nested.path), nested.path)
    eq('write creates the missing parent directories', nested.operation, 'create')
    eq('the nested file reads back', readText(await tools['wsl-read'].execute({ path: nested.path }, {})), 'tilde ok')

    const replaced = await tools['wsl-write'].execute({ path: samplePath, content: 'replaced\n' }, {})
    eq('a write over an existing file reports an update', replaced.operation, 'update')
    eq('the replacement content is what was written',
      readText(await tools['wsl-read'].execute({ path: samplePath }, {})), 'replaced')

    const emptied = await tools['wsl-write'].execute({ path: `${fsRoot}/empty.txt`, content: '' }, {})
    eq('writing empty content still reports a normal write', emptied.operation, 'create')
    eq('an empty file reads as empty rather than as an error',
      readText(await tools['wsl-read'].execute({ path: `${fsRoot}/empty.txt` }, {})), '')

    // Searching is the fourth file operation, and the only one whose answer depends on
    // what the distribution has installed. Both engines are asked for the same things,
    // including the two that a naive shell grep gets wrong: a path containing a colon
    // (which `-Z` exists for) and a binary file (which must not be returned at all).
    const grepRoot = `${fsRoot}/grep`
    await tools['wsl-write'].execute({ path: `${grepRoot}/a.txt`, content: 'alpha\nBeta\nalphabet\n' }, {})
    await tools['wsl-write'].execute({ path: `${grepRoot}/sub/b.ts`, content: 'const alpha = 1\n// 中文 alpha\n' }, {})
    await tools['wsl-write'].execute({ path: `${grepRoot}/colon:name.txt`, content: 'alpha with a colon in the name\n' }, {})
    await tools['wsl-write'].execute({ path: `${grepRoot}/blob.dat`, content: 'alpha\u0000binary\n' }, {})

    const found = await tools['wsl-grep'].execute({ pattern: 'alpha', path: grepRoot }, {})
    check('the search says which engine ran', found.engine === 'rg' || found.engine === 'grep', String(found.engine))
    eq('every match in the tree is found', found.total, 5)
    eq('and they are grouped into the files that hold them', found.fileCount, 3)
    check('a path with a colon in it survives the trip',
      found.matches.some((m) => m.path.endsWith('colon:name.txt')), JSON.stringify(found.matches.map((m) => m.path)))
    check('a binary file is not searched',
      found.matches.every((m) => !m.path.endsWith('blob.dat')), JSON.stringify(found.matches.map((m) => m.path)))
    check('a non-ASCII line comes back intact',
      found.matches.some((m) => m.line === '// 中文 alpha'), JSON.stringify(found.matches.map((m) => m.line)))
    eq('a match carries the line it was found on',
      found.matches.find((m) => m.line === 'alphabet')?.lineNumber, 3)
    check('a relative target is echoed without a leading ./',
      found.matches.every((m) => !m.path.startsWith('./')), JSON.stringify(found.matches.map((m) => m.path)))

    const grepText = tools['wsl-grep'].output.render({}, found)[0].text
    check('the rendered result leads with the count', grepText.startsWith('Found 5 matches'), JSON.stringify(grepText.slice(0, 40)))
    check('and names each match by file and line', /a\.txt\nLine 1: alpha/.test(grepText), JSON.stringify(grepText.slice(0, 240)))

    const narrowed = await tools['wsl-grep'].execute({ pattern: 'alpha', path: grepRoot, include: '*.ts' }, {})
    eq('include restricts the search to one glob', narrowed.total, 2)
    const nothing = await tools['wsl-grep'].execute({ pattern: 'zzz-not-here', path: grepRoot }, {})
    eq('a search that finds nothing succeeds with nothing', nothing.total, 0)
    eq('and says so in one line', tools['wsl-grep'].output.render({}, nothing)[0].text, 'No matches found')
    await rejects('a missing path is an error, not an empty result',
      () => tools['wsl-grep'].execute({ pattern: 'alpha', path: `${grepRoot}/nope` }, {}), /no such file or directory/)
    await rejects('a comma-separated include is refused',
      () => tools['wsl-grep'].execute({ pattern: 'alpha', path: grepRoot, include: 'a,b' }, {}), /comma-separated/)
    await rejects('an empty pattern is refused',
      () => tools['wsl-grep'].execute({ pattern: '', path: grepRoot }, {}), /non-empty string/)

    // GNU grep exits 2 as soon as ONE file it walked could not be read, while still
    // having found everything in the files it could read — `/etc` is nothing but
    // that case. Reading the status as failure discarded a correct answer, so the
    // script buffers the body and only calls it an error when the body is empty too.
    const unreadableRoot = `${grepRoot}/unreadable`
    await tools['wsl-write'].execute({ path: `${unreadableRoot}/open.txt`, content: 'needle in the open\n' }, {})
    await tools['wsl-write'].execute({ path: `${unreadableRoot}/closed.txt`, content: 'needle behind a door\n' }, {})
    await tools.wsl.execute({ description: 'Make one file unreadable', command: `chmod 000 ${unreadableRoot}/closed.txt` }, {})
    const partiallyReadable = await tools['wsl-grep'].execute({ pattern: 'needle', path: unreadableRoot }, {})
    eq('a file it cannot read does not throw away the matches it could', partiallyReadable.total, 1)
    await tools.wsl.execute({ description: 'Put the mode back', command: `chmod 644 ${unreadableRoot}/closed.txt` }, {})

    // `\d` on the engine the distribution actually has: Ubuntu ships no `rg`, so this
    // runs the GNU grep fallback, where `\d` is a literal `d` — before the translation
    // it matched "ddd" and never a number, with exit 0.
    await tools['wsl-write'].execute({ path: `${grepRoot}/numbers.txt`, content: 'id 42\nid abc\n' }, {})
    const digits = await tools['wsl-grep'].execute({ pattern: 'id \\d+', path: `${grepRoot}/numbers.txt` }, {})
    eq('a digit class matches the number under either engine', digits.total, 1)
    eq('and the match is the numeric line', digits.matches[0]?.line, 'id 42')

    // A write through a symlink must change the target, not replace the link:
    // renaming over the link would leave the target untouched and silently turn the
    // link into a regular file.
    const linkTarget = `${fsRoot}/link-target.txt`
    const linkPath = `${fsRoot}/link.txt`
    await tools['wsl-write'].execute({ path: linkTarget, content: 'old content\n' }, {})
    await tools.wsl.execute({ command: `ln -s ${linkTarget} ${linkPath}`, description: 'make a symlink' })
    const viaLink = await tools['wsl-write'].execute({ path: linkPath, content: 'new through the link\n' }, {})
    eq('a write through a symlink reports the resolved path', viaLink.path, linkTarget)
    eq('and the target receives the content',
      readText(await tools['wsl-read'].execute({ path: linkTarget }, {})), 'new through the link')
    eq('while the link is still a link',
      (await tools.wsl.execute({
        command: `test -L ${linkPath} && echo yes || echo no`, description: 'is the link still a link',
      })).stdout.trim(),
      'yes')

    // A single line longer than the read window cannot be paged by line. Dropping the
    // partial line used to answer "Showing lines 1-0 … Use offset=1", which invites a
    // retry loop; naming the limit is the fix.
    await tools['wsl-write'].execute({ path: `${fsRoot}/one-long-line.json`, content: 'x'.repeat(1_200_000) }, {})
    await rejects('a line longer than the read window is refused with a way forward',
      () => tools['wsl-read'].execute({ path: `${fsRoot}/one-long-line.json` }, {}), /longer than the .*read window/)

    // The panel switch is the authorisation for root in the file tools too, and a
    // refusal must never be a silent downgrade to the user account: a caller that
    // asked for root and got a permission error would look for the cause in the
    // wrong place.
    for (const [name, args] of [
      ['wsl-read', { path: samplePath }],
      ['wsl-write', { path: `${fsRoot}/root-off.txt`, content: 'x' }],
      ['wsl-edit', { path: samplePath, oldString: 'replaced', newString: 'again' }],
      ['wsl-grep', { pattern: 'alpha', path: fsRoot }],
    ]) {
      await rejects(`${name}: asRoot is refused while the panel switch is off`,
        () => tools[name].execute({ ...args, asRoot: true }, {}), /管理员模式/)
      await rejects(`${name}: a non-boolean asRoot is refused`,
        () => tools[name].execute({ ...args, asRoot: 'yes' }, {}), /must be a boolean/)
    }
    eq('a refused root write left no file behind',
      (await tools.wsl.execute({
        command: `test -e ${fsRoot}/root-off.txt && echo yes || echo no`, description: 'check the refusal',
      })).stdout.trim(),
      'no')

    const rootTools = makeCtx(shim, { jobs, settings: { allowRoot: true } })
    // The temporary a write creates belongs to the process that made it, so a root
    // edit would hand a user's file to root. The owner is copied across with the mode.
    const ownedPath = `${fsRoot}/owned.txt`
    await tools['wsl-write'].execute({ path: ownedPath, content: 'alpha\nbeta\n' }, {})
    const ownerBefore = (await tools.wsl.execute({
      command: `stat -c '%U %a' ${ownedPath}`, description: 'owner before the edit',
    })).stdout.trim()
    const rootEdited = await rootTools['wsl-edit'].execute({
      path: ownedPath, oldString: 'beta', newString: 'gamma', asRoot: true,
    }, {})
    eq('a root edit reports that it ran as root', rootEdited.asRoot, true)
    eq('a root edit leaves the owner and mode alone',
      (await tools.wsl.execute({ command: `stat -c '%U %a' ${ownedPath}`, description: 'owner after the edit' })).stdout.trim(),
      ownerBefore)
    eq('and the change itself landed',
      readText(await tools['wsl-read'].execute({ path: ownedPath }, {})), 'alpha\ngamma')
    check('the model-facing text says the call was privileged',
      tools['wsl-edit'].output.render({}, rootEdited)[0].text.includes(', as root'),
      tools['wsl-edit'].output.render({}, rootEdited)[0].text)

    // The case the switch exists for: a file the user cannot open at all. It has to be
    // refused with the reason rather than returned as an empty file — the header line
    // carries the byte count and is printed before the read, so without the guard
    // "unreadable" and "empty" would look the same.
    const lockedPath = `${fsRoot}/locked.txt`
    await rootTools.wsl.execute({
      command: `printf 'secret\\n' > ${lockedPath} && chmod 600 ${lockedPath} && chown root:root ${lockedPath}`,
      description: 'create a root-only file',
      asRoot: true,
    })
    await rejects('an unreadable file is refused with the reason, not as an empty file',
      () => tools['wsl-read'].execute({ path: lockedPath }, {}), /permission denied/)
    eq('the same read as root returns the contents',
      readText(await rootTools['wsl-read'].execute({ path: lockedPath, asRoot: true }, {})), 'secret')
    await rejects('an edit of an unreadable file says it could not read it',
      () => tools['wsl-edit'].execute({ path: lockedPath, oldString: 'secret', newString: 'x' }, {}),
      /permission denied/)
  } finally {
    await tools.wsl.execute({
      command: `rm -rf ${fsRoot} ~/dsh-fs-smoke`, description: 'remove the file-tool scratch space', allowDangerous: true,
    })
  }
  check('the file tools leave no scratch space behind',
    (await tools.wsl.execute({
      command: `test -e ${fsRoot} || echo gone; test -e ~/dsh-fs-smoke || echo gone2`,
      description: 'confirm the scratch space is gone',
    })).stdout.trim(),
    'gone\ngone2')

  // The model pays for description + parameters in EVERY request, so the budget
  // is a real limit. It is asserted, not aspirational: a future edit that
  // re-bloats the catalog fails here instead of quietly costing tokens forever.
  // The numbers are a ratchet just above today's size, not a target.
  //
  // The total moved from 3800 to 5600 when `wsl-doctor` and `wsl-bootstrap` were
  // added (three tools became five). The per-tool limit did NOT move: `wsl` gained
  // `asRoot` and still fits under 2500 because its prose was tightened to pay for
  // it. A future tool has to justify its own cost the same way.
  //
  // The sixth tool (`wsl-term`) is always mounted now — it has no switch, because opening a
  // terminal in the sidebar is the consent it needs — so its cost is in the DEFAULT total,
  // not only in the all-on one. Its description also carries the one-shot-versus-terminal
  // protocol, which is prose the model needs to choose correctly: 5600 -> 6600 for the
  // default mount, 7300 -> 7700 with the installer on. Still tight enough that the next
  // paragraph of prose has to be paid for by trimming something.
  // The seventh, eighth and ninth tools (`wsl-read`, `wsl-write`, `wsl-edit`) are the file
  // tools the platform's own cannot be, because a distribution's home is a 9p share whose
  // atomic-write rename fails. 7100 -> 10300 for the default mount, 8200 -> 11400 with the
  // installer on. Each is under the per-tool ceiling on its own, and each description is
  // short on purpose: it has to say what the tool does that `wsl` cannot, and nothing else.
  // The tenth (`wsl-grep`) pays for itself differently: it is the only file tool whose
  // answer depends on what the distribution has installed, so its description has to carry
  // the one thing a caller cannot discover from the result — that the pattern must be valid
  // in BOTH `rg` and `grep -E`. Measured 11147 / 12202; the ceilings below are that rounded
  // up, which is the whole ratchet: 300 chars of headroom, not a target.
  // The three file tools then grew an `asRoot` switch, which is the one way to reach a file
  // the user cannot open: 11147 -> 11647 and 12202 -> 12702, so the ceilings move with them.
  // A switch is a parameter and a parameter is billed on every request whether it is used
  // or not, which is why the descriptions say what the switch is FOR in one clause instead
  // of listing everything root can do.
  // The host asserts a SUPPORTED SUBSET of JSON Schema when a tool registers, and one
  // rule in it is not obvious: `type` may not be an array
  // (`packages/core/tools/src/json-schema.ts:305`, "type arrays are not supported").
  // A violation here is invisible: the plugin catches the registration throw, every
  // other tool mounts, and the rejected one only surfaces later as `unknown tool` at
  // call time. `wsl-write` shipped exactly that way — a nullable `before` field — so
  // the rule is checked rather than trusted.
  console.log('\nmodel-facing schemas: the host subset')
  const typeArrays = (node, at) => {
    if (node === null || typeof node !== 'object') return []
    const found = Array.isArray(node.type) ? [`${at}.type is an array`] : []
    for (const [key, value] of Object.entries(node)) {
      // Data-valued keywords may legitimately hold anything; only shape keywords are walked.
      if (key === 'enum' || key === 'default' || key === 'examples' || key === 'const') continue
      if (value === null || typeof value !== 'object') continue
      if (Array.isArray(value)) value.forEach((item, index) => { found.push(...typeArrays(item, `${at}.${key}[${index}]`)) })
      else found.push(...typeArrays(value, `${at}.${key}`))
    }
    return found
  }
  for (const [name, tool] of Object.entries(optInTools)) {
    check(`${name}: parameters declare no type arrays (the host rejects them)`,
      typeArrays(tool.parameters, 'parameters').length === 0,
      typeArrays(tool.parameters, 'parameters').join(', ') || 'none')
    check(`${name}: output schema declares no type arrays (the host rejects them)`,
      typeArrays(tool.output.schema, 'schema').length === 0,
      typeArrays(tool.output.schema, 'schema').join(', ') || 'none')
  }
  check('the walker finds a nullable type where it is one',
    typeArrays({ type: 'object', properties: { before: { type: ['string', 'null'] } } }, 'schema').length === 1,
    JSON.stringify(typeArrays({ type: 'object', properties: { before: { type: ['string', 'null'] } } }, 'schema')))
  console.log('\nmodel-facing catalog budget')
  let catalog = 0
  for (const [name, tool] of Object.entries(tools)) {
    const cost = tool.description.length + JSON.stringify(tool.parameters).length
    catalog += cost
    check(`${name}: catalog cost within budget`, cost <= 2_700, `${cost} chars (description ${tool.description.length} + parameters ${JSON.stringify(tool.parameters).length})`)
  }
  check('total catalog cost within budget', catalog <= 11_900, `${catalog} chars (~${Math.round(catalog / 4)} tokens)`)
  // The installer is absent from the default mount, so its cost is measured on a mount that
  // switches it on: a tool that does not exist costs nothing, but an enabled one has to fit
  // the same ceiling as the others.
  let optInCatalog = 0
  for (const [name, tool] of Object.entries(optInTools)) {
    const cost = tool.description.length + JSON.stringify(tool.parameters).length
    optInCatalog += cost
    check(`${name}: catalog cost within budget with every switch on`, cost <= 2_700, `${cost} chars (description ${tool.description.length} + parameters ${JSON.stringify(tool.parameters).length})`)
  }
  check('total catalog cost with every tool switched on within budget', optInCatalog <= 13_000, `${optInCatalog} chars (~${Math.round(optInCatalog / 4)} tokens)`)
  // The installer's own description is the only place the model learns that a
  // second call with `dryRun: false` is what installs, so that phrase is load-bearing.
  check('the installer says a second call is what installs',
    optInTools['wsl-bootstrap'] === undefined || optInTools['wsl-bootstrap'].description.includes('dryRun: false'),
    optInTools['wsl-bootstrap']?.description ?? '(not mounted)')
  // The terminal tool's description is where the model learns when to reach for a terminal
  // at all (as opposed to a fresh shell), that it may open one, that the user's view goes
  // read-only while it works, and that a terminal it opened is closed when the subtask ends.
  check('the terminal tool carries its protocol and its limits',
    tools['wsl-term'] === undefined
    || (tools['wsl-term'].description.includes('plain `wsl` tool is better')
      && tools['wsl-term'].description.includes('dangerous-command guard')
      && (tools['wsl-term'].description.includes('one is opened here')
        ? (tools['wsl-term'].description.includes('read-only')
          && tools['wsl-term'].description.includes('`close` it when the subtask is done'))
        : tools['wsl-term'].description.includes('offers no terminal this tool can drive'))),
    tools['wsl-term']?.description ?? '(not mounted)')

  // The bundle patch must stay minimal: installing a tool plugin must not decide
  // which shell someone's terminals open. Pointing the desktop sidebar terminal at
  // WSL is opt-in and ships as extras/terminal-wsl.patch.yml, so assert both
  // halves — that this file leaves the terminal alone, and that the opt-in works.
  console.log('\nbundle manifest and patch entry')
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const patchRel = manifest.dsh?.bundle?.patch
  check('package.json declares a bundle patch', typeof patchRel === 'string', String(patchRel))
  const patchFile = resolve(packageRoot, patchRel ?? '')
  check('the declared patch file exists', patchRel !== undefined && existsSync(patchFile), patchFile)
  const patchText = readFileSync(patchFile, 'utf8')
  check(
    'the bundle patch does not choose the terminal shell',
    !patchText.includes('terminal-controller'),
    'pointing the sidebar terminal at WSL belongs in extras/, not in the bundle patch',
  )
  check('the patch inserts exactly one row', (patchText.match(/^\s*- id:/gm) ?? []).length === 1)
  const entryName = /^\s*name:\s*'([^']+)'\s*$/m.exec(patchText)?.[1]
  check(
    'the patch entry name is folder-independent',
    typeof entryName === 'string' && entryName.startsWith('./'),
    `${entryName} — a bare package name would couple this file to the install folder`,
  )
  check(
    'the patch entry resolves to a real file',
    typeof entryName === 'string' && entryName.startsWith('./') && existsSync(resolve(dirname(patchFile), entryName)),
    String(entryName),
  )

  // What a DOWNLOADED copy contains. `files` decides the tarball, so a document the
  // panel or a README points at has to be in it — SUPPORT.md was referenced from both
  // READMEs and from the panel's guide while missing from the tarball, so a user
  // following the link hit nothing. A listed entry that does not exist is the mirror
  // image: it silently drops content from the release.
  console.log('\npm-packaged files')
  const shipped = Array.isArray(manifest.files) ? manifest.files : []
  for (const required of ['index.js', 'lib', 'cordis.patch.yml', 'README.md', 'README.zh-CN.md', 'SUPPORT.md', 'extras', 'LICENSE']) {
    check(`the tarball ships ${required}`, shipped.includes(required), JSON.stringify(shipped))
  }
  for (const entry of shipped) {
    check(`the listed entry ${entry} exists`, existsSync(resolve(packageRoot, entry)), entry)
  }
  // The client half is loaded by path from the manifest, so that path must ship too.
  const clientEntry = manifest.dsh?.client
  check('the manifest declares a client half', clientEntry !== undefined && clientEntry !== null,
    JSON.stringify(manifest.dsh))
  check('the client bundle the manifest points at ships',
    shipped.includes('lib') && existsSync(resolve(packageRoot, 'lib/client.js')),
    JSON.stringify(shipped))

  // Every repository-relative target the docs point at has to exist, because a preview
  // filename changes with every redesign and a missed reference is invisible until a user
  // clicks it. The preview image itself is deliberately NOT in the tarball: `npm pack`
  // also produces the asset the market installs, and the catalog renders screenshots from
  // this repository over raw GitHub — so shipping the PNGs would only slow installs down.
  console.log('\nrepository assets the docs reference')
  const referenced = new Set()
  for (const doc of ['README.md', 'README.zh-CN.md']) {
    const text = readFileSync(join(packageRoot, doc), 'utf8')
    // Every markdown link/image target, not just images: a renamed file is a broken link
    // wherever it appears. Remote targets (a badge, a website) and in-page anchors are not
    // this repository's files and are skipped rather than required to exist.
    for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)/g)) {
      const target = match[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      if (target.startsWith('#')) continue
      referenced.add(target)
    }
  }
  const shots = JSON.parse(readFileSync(join(packageRoot, 'screenshots.json'), 'utf8'))
  for (const shot of shots) referenced.add(shot)
  check('the docs and screenshots.json point at at least one asset', referenced.size > 0, String(referenced.size))
  check('screenshots.json ships (the catalog reads it)', shipped.includes('screenshots.json'), JSON.stringify(shipped))
  for (const reference of referenced) {
    check(`the referenced asset exists: ${reference}`, existsSync(resolve(packageRoot, reference)), reference)
  }

  // The two halves talk over strings neither can type-check: route paths, the config row id,
  // and the info payload's key names. Each side's own suite asserts ITS literals, so a
  // rename on one side would keep both green while the panel silently degrades. Compare the
  // sources directly instead of trusting the pair of hand-written literals.
  console.log('\nclient/host wire contract')
  const hostSource = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  const clientSource = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8')
  const patchSource = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  for (const route of ['/dsh-wsl-tool/info', '/dsh-wsl-tool/terminal-cwd']) {
    check(`both halves know the route ${route}`,
      hostSource.includes(route) && clientSource.includes(route), route)
  }
  check('both halves agree on the config row id',
    patchSource.includes('- id: tool-wsl') && clientSource.includes('tool-wsl'),
    `patch=${patchSource.includes('- id: tool-wsl')} client=${clientSource.includes('tool-wsl')}`)
  for (const key of ['defaultDistro', 'kernel', 'capabilities', 'commandTimeoutMs', 'version', 'repository']) {
    check(`both halves name the payload field ${key}`,
      hostSource.includes(key) && clientSource.includes(key), key)
  }

  // The DSH floor the MARKET reads. dsh-market fetches `<name>/latest` from the
  // registry and compares `engines.dsh` (or `dsh.engines.dsh`) against the host
  // version, so this field IS the entry's compatibility badge. The prerelease in
  // the floor is load-bearing: `>=0.1.7` evaluates to FALSE on `0.1.7-rc.2`, the
  // release the README says this plugin is verified against, and the market would
  // then report the plugin as incompatible with its own verified host. DSH core
  // ignores `engines` — it evaluates `peerDependencies` on `@deepseek-ai/dsh*` —
  // so declaring it cannot get the plugin disabled.
  eq('the manifest declares the DSH floor the market reads', manifest.engines?.dsh, '>=0.2.1-rc.2')


  // The optional half: it must address a real composed row by id, must not switch
  // that row off (that would take the terminal feature away rather than adjust it),
  // and must point at a shell that exists.
  console.log('\nbuilding the Config schema cannot take the module down')
  {
    // A profile can carry an incompatible `@deepseek-ai/schemastery`. The builder used to be
    // driven at module scope, outside the try that guards the import, so that threw during import
    // and every tool disappeared — instead of the intended "no panel, tools still work".
    const broken = { object() { throw new Error('incompatible builder') } }
    check('a builder that cannot build yields no Config instead of throwing',
      buildConfig(broken) === undefined)
    check('no builder at all yields no Config',
      buildConfig(null) === undefined && buildConfig(undefined) === undefined)
    const chainable = () => {
      const node = {
        default: () => node,
        description: () => node,
        volatile: () => node,
      }
      return node
    }
    const usable = {
      boolean: chainable,
      string: chainable,
      number: chainable,
      // A real builder returns the schema from the top-level `.description(...)`; the stub returns
      // a sentinel, so the test can see the whole chain was walked.
      object: () => {
        const node = chainable()
        node.description = () => 'a schema'
        return node
      },
    }
    check('and a usable builder still produces the schema', buildConfig(usable) === 'a schema')
  }

  console.log('\noptional sidebar-terminal patch')
  check('the manifest ships the extras directory', (manifest.files ?? []).includes('extras'), JSON.stringify(manifest.files))
  const extrasFile = resolve(packageRoot, 'extras/terminal-wsl.patch.yml')
  check('the optional patch exists', existsSync(extrasFile), 'extras/terminal-wsl.patch.yml')
  const extras = existsSync(extrasFile) ? readFileSync(extrasFile, 'utf8') : ''
  check(
    'it targets the sidebar terminal row',
    /^\s*- id:\s*terminal-controller\s*$/m.test(extras),
    'a wrong id would silently do nothing',
  )
  check(
    'it never disables the row it targets',
    !/^\s*disabled:/.test(extras),
    'disabling terminal-controller would remove the whole sidebar terminal',
  )
  const shellPath = /^\s*path:\s*'([^']+)'\s*$/m.exec(extras)?.[1]
  check('it names the WSL launcher', typeof shellPath === 'string' && /wsl\.exe$/i.test(shellPath), String(shellPath))
  check(
    'its shell exists on a Windows host',
    process.platform !== 'win32' || (typeof shellPath === 'string' && existsSync(shellPath)),
    String(shellPath),
  )
  check(
    'it does not pin a distribution',
    !/^\s*args:.*-d/m.test(extras),
    'pinning one would break machines with a different default distro',
  )
}

// --- terminal bridge (host half) -------------------------------------------

/** Wait a few macrotasks: enough for a route handler to reach its hold or a transport to flush. */
function tickMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One terminal the app's sidebar owns, shaped as the host controller publishes it. */
function browserTerminalOf(id, sessionId = 'session-1') {
  return {
    id, title: 'WSL', shell: { name: 'bash', path: '/bin/bash', args: ['-i'] },
    cwd: '/mnt/d/proj', cols: 120, rows: 30, state: 'running', exitCode: null, sessionId,
  }
}

/**
 * A DSH 0.2.1 host: `terminalController` has only list/create/close (no `follow`), and
 * `subprocess` can still spawn a PTY. The bridge is built exactly like `index.js` builds it,
 * so these checks exercise the same wiring the plugin ships.
 */
function makeBridgeHarness({ terminals = [], timings, withPty = true } = {}) {
  const calls = { created: [], closed: [], spawned: [] }
  const routes = []
  const live = terminals.map((info) => ({ ...info }))
  const terminalController = {
    list(sessionId) {
      return live
        .filter((info) => info.sessionId === undefined || info.sessionId === sessionId)
        .map((info) => ({ ...info }))
    },
    async create(agent, request) {
      const info = { ...browserTerminalOf(request.id, agent.id), cols: request.cols, rows: request.rows }
      live.push(info)
      calls.created.push(info)
      return { ...info }
    },
    async close(agent, id) {
      calls.closed.push(String(id))
      const index = live.findIndex((info) => info.id === id)
      if (index >= 0) live.splice(index, 1)
    },
  }
  const subprocess = {
    resolveExecutable: async (name) => `C:/Windows/System32/${name}`,
    async spawnTerminal(spec) {
      calls.spawned.push(spec)
      return makeBridgePtyHandle()
    },
  }
  const webServer = { register(route) { routes.push(route); return () => {} } }
  const ctx = {
    get: (name) => (name === 'terminalController' ? terminalController
      : name === 'subprocess' && withPty ? subprocess : undefined),
    inject: (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('webServer')) {
        callback({ webServer, effect: (fn) => { fn() } })
      }
    },
  }
  const transport = timings === undefined
    ? createTerminalTransport({ ctx, config: CONFIG })
    : createBridgeTransport({ ctx, config: CONFIG, controller: terminalController, pty: null, timings })
  return { ctx, transport, routes, calls, live, terminalController }
}

/** A PTY handle that answers helper calls the way a real shell does, for the fallback path. */
function makeBridgePtyHandle() {
  let finished = false
  let exitResolve
  const done = new Promise((resolve) => { exitResolve = resolve })
  const queue = []
  const waiters = []
  const push = (text) => {
    const value = Buffer.from(String(text), 'utf8')
    const waiter = waiters.shift()
    if (waiter) waiter({ value, done: false })
    else queue.push(value)
  }
  const output = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
          if (finished) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiters.push(resolve))
        },
      }
    },
  }
  return {
    output,
    done,
    write(data) {
      const text = String(data)
      const nonce = new RegExp(`${HELPER_NAME} ([0-9a-f]+) '`).exec(text)?.[1] ?? null
      if (nonce === null) {
        if (text.includes(`${HELPER_NAME}()`)) push(`${text.replace(/^\u0015/, '').split('\r')[0]}\r\n`)
        return
      }
      push(`${START_PREFIX}${nonce}\r\n`)
      push('pty fallback output\r\n')
      push(`${END_PREFIX}${nonce}:0\r\n`)
    },
    async terminate() { finished = true; exitResolve({ exitCode: 0 }) },
    async resize() {},
    async inspectActivity() { return { state: 'idle', revision: 0 } },
  }
}

/** Start one poll; it resolves when the host answers (a command batch, or the hold timeout). */
function startBridgePoll(host, clientId) {
  const route = host.routes.find((entry) => entry.path === '/dsh-wsl-tool/term-bridge/poll')
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('the bridge poll did not answer within 2000 ms'))
    }, 2_000)
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(event, callback) {
        if (event === 'data') callback(Buffer.from(JSON.stringify({ clientId }), 'utf8'))
        if (event === 'end') callback()
        return this
      },
    }
    const response = {
      writeHead() {},
      end(text) { settle(text === undefined || text === '' ? { ok: false } : JSON.parse(text)) },
    }
    Promise.resolve(route.handler(request, response)).catch((error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Post a batch of bridge events the way the client half does. */
function postBridgeEvents(host, clientId, events) {
  const route = host.routes.find((entry) => entry.path === '/dsh-wsl-tool/term-bridge/events')
  return callRoute(route, 'POST', JSON.stringify({ clientId, events }))
}

/** The browser half, reduced to what the host sees: a poller and the frames it reports. */
function makeBridgePage(host, { clientId = 'window-a', screen = 'user@host:~/proj$ ' } = {}) {
  const page = {
    clientId,
    attachmentId: null,
    writes: [],
    detaches: 0,
    inventories: 0,
    poll() { return startBridgePoll(host, clientId) },
    send(events) { return postBridgeEvents(host, clientId, events) },
    async handle(command) {
      if (command.kind === 'attach') {
        page.attachmentId = command.attachmentId
        const info = host.live.find((entry) => entry.id === command.terminalId)
        await page.send([
          { type: 'result', commandId: command.id, ok: true },
          { type: 'snapshot', attachmentId: command.attachmentId, screen, info, writable: true },
        ])
        return
      }
      if (command.kind === 'write') {
        page.writes.push(command.data)
        const nonce = new RegExp(`${HELPER_NAME} ([0-9a-f]+) '`).exec(command.data)?.[1] ?? null
        const events = [{ type: 'result', commandId: command.id, ok: true }]
        if (nonce !== null) {
          events.push({ type: 'output', attachmentId: command.attachmentId, data: `${START_PREFIX}${nonce}\r\n` })
          events.push({ type: 'output', attachmentId: command.attachmentId, data: 'bridge says hi\r\n' })
          events.push({ type: 'output', attachmentId: command.attachmentId, data: `${END_PREFIX}${nonce}:0\r\n` })
        }
        await page.send(events)
        return
      }
      if (command.kind === 'detach') {
        page.detaches += 1
        await page.send([{ type: 'result', commandId: command.id, ok: true }])
        return
      }
      if (command.kind === 'inventory') {
        page.inventories += 1
        await page.send([{
          type: 'inventory',
          commandId: command.id,
          terminals: host.live.map((info) => ({ ...info })),
        }])
      }
    },
  }
  return page
}

/**
 * Poll and answer until one tool call settles.
 *
 * A poll that loses the race to the settling call is left held; the transport unrefs its own
 * hold timer, so it cannot keep the process alive.
 */
async function driveBridge(page, running) {
  let outcome = null
  const finished = running.then(
    (value) => { outcome = { value }; return outcome },
    (error) => { outcome = { error }; return outcome },
  )
  while (outcome === null) {
    const next = await Promise.race([finished, page.poll().then((batch) => ({ batch }))])
    if (outcome !== null) break
    for (const command of next.batch?.commands ?? []) await page.handle(command)
  }
  await finished
  if (outcome.error !== undefined) throw outcome.error
  return outcome.value
}

/**
 * Drive a page until it has handled the `attach` command, returning that command.
 *
 * A collaborative call asks the page for its terminal inventory first, so the attach is no
 * longer necessarily in the first batch; this helper keeps the tests about the attach itself.
 */
async function driveToAttach(page, firstBatch) {
  let batch = firstBatch
  for (let round = 0; round < 6; round += 1) {
    for (const command of batch?.commands ?? []) {
      await page.handle(command)
      if (command.kind === 'attach') return command
    }
    batch = await page.poll()
  }
  return null
}

async function bridgeUnitTests() {
  console.log('\nterminal bridge')

  // Routes, request policy, and the liveness rule: two routes, JSON-only, POST-only.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    eq('the bridge publishes exactly two routes', host.routes.length, 2)
    eq('the bridge routes are namespaced and exact',
      host.routes.map((entry) => `${entry.kind}:${entry.path}`).join(','),
      'exact:/dsh-wsl-tool/term-bridge/poll,exact:/dsh-wsl-tool/term-bridge/events')
    const poll = host.routes.find((entry) => entry.path.endsWith('/poll'))
    const events = host.routes.find((entry) => entry.path.endsWith('/events'))
    eq('the poll route refuses GET', (await callRoute(poll, 'GET')).code, 405)
    eq('the poll route refuses a non-JSON content type',
      (await callRoute(poll, 'POST', JSON.stringify({ clientId: 'x' }), { 'content-type': 'text/plain' })).code, 415)
    eq('the poll route needs a clientId', (await callRoute(poll, 'POST', JSON.stringify({}))).code, 400)
    eq('the events route refuses a malformed body', (await callRoute(events, 'POST', '{nope')).code, 400)
    eq('the events route refuses GET', (await callRoute(events, 'GET')).code, 405)
    eq('events from an unknown window are accepted and ignored',
      (await callRoute(events, 'POST', JSON.stringify({ clientId: 'nobody', events: [{ type: 'snapshot' }] }))).code, 200)
    eq('with no window polling, the transport reports the private-shell kind', host.transport.kind, 'pty')
    eq('and its status says no page is holding the bridge', host.transport.status().client, false)
    eq('an undrivable browser terminal is not listed without a page', host.transport.list('session-1').length, 0)
    // A window that is closed cannot answer an inventory, so the collaboration list is EMPTY
    // rather than "the host controller still remembers some terminals": returning them made the
    // tool's automatic choice land in a terminal it could never drive.
    eq('with no page there are no collaboration targets at all',
      (await host.transport.userTerminals('session-1')).length, 0)
  }

  // The happy path: an EXPLICIT id names the user's terminal, so the bridge drives it once.
  // Automatic selection never does that (owner decision, 2026-10-23); the explicit form exists
  // so a user can ask for it, and it must never close that terminal.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    eq('a polling window makes the transport the bridge', host.transport.kind, 'bridge')
    eq('and the status route can see that page', host.transport.status().client, true)
    const subtasks = createSubtaskLog()
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, subtasks, transport: host.transport })
    const running = tool.execute(
      { action: 'run', command: 'echo bridge', subtask: '桥接', id: 'user-term' },
      { agent: { id: 'session-1' } },
    )
    const first = await warm
    eq('the tool hands the page an attach command', first.commands?.[0]?.kind, 'attach')
    eq('and names the terminal the caller named', first.commands?.[0]?.terminalId, 'user-term')
    for (const command of first.commands ?? []) await page.handle(command)
    eq('one bridge attachment is in flight', host.transport.status().attachments, 1)
    const result = await driveBridge(page, running)
    check('a run over the bridge returns the terminal output and its exit code',
      result.summary.includes('bridge says hi') && result.summary.includes('exit code: 0'), result.summary)
    check('the header says the terminal belongs to the user and its id was named',
      result.summary.includes('this call named its id') && result.summary.includes('/mnt/d/proj'),
      result.summary.slice(0, 320))
    check('and it carries the handover warning the user needs',
      result.summary.includes('接管输入'), result.summary.slice(0, 320))
    eq('no terminal was created for an existing one', host.calls.created.length, 0)
    eq('the tool never closes the user terminal', host.calls.closed.length, 0)
    check('the subtask record marks the shell as NOT opened by the tool',
      subtasks.list('session-1').entries[0]?.terminalCreated === false,
      JSON.stringify(subtasks.list('session-1').entries[0]?.terminalCreated))
    const finished = await tool.execute(
      { action: 'subtask-done', subtask: '桥接', result: 'done', keepTerminal: false },
      { agent: { id: 'session-1' } },
    )
    check('subtask-done leaves the user terminal alone even when asked to close',
      finished.summary.includes('left alone (the user opened it)'), finished.summary)
    eq('and it issued no close for it', host.calls.closed.length, 0)
    check('the helper is defined once, then the short call line is typed',
      page.writes.length === 2
      && page.writes[0].includes(`${HELPER_NAME}()`)
      && /__dsh_term_run [0-9a-f]{8} 'echo bridge'/.test(page.writes[1]),
      JSON.stringify(page.writes.map((write) => write.slice(0, 40))))
    eq('the tool detaches after the call, releasing the keyboard', page.detaches, 1)
  }

  // An explicit `close` naming a user terminal is refused: that shell belongs to the user.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    await rejects('close refuses a terminal this tool did not open',
      () => tool.execute({ action: 'close', id: 'user-term' }, { agent: { id: 'session-1' } }),
      /not opened by this tool/)
    eq('and no close reached the controller', host.calls.closed.length, 0)
  }

  // An explicit id naming a terminal that exists but cannot be driven right now (no page is
  // polling) is answered BEFORE attaching: the transport's `describe` carries `drivable: false`
  // and a note, and that note is the actionable answer — `follow()` would only report a generic
  // "window not answering" after the call's wait.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    eq('the transport marks the terminal as undrivable without a page',
      host.transport.describe('session-1', 'user-term')?.drivable, false)
    await rejects('an explicit id on an undrivable terminal says why, before attaching',
      () => tool.execute({ action: 'read', id: 'user-term', timeoutMs: 200 }, { agent: { id: 'session-1' } }),
      /这个终端当前不可驱动.*DSH window is not open/)
  }

  // Ad-hoc commands ARE collaborative: without a `subtask`, the newest terminal the user has
  // open is used, so the command is visible there — and the tool never closes it.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    const subtasks = createSubtaskLog()
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, subtasks, transport: host.transport })
    const running = tool.execute({ action: 'run', command: 'echo collab' }, { agent: { id: 'session-1' } })
    const first = await warm
    // The page is asked for its terminal inventory before the attach can be queued.
    const attach = await driveToAttach(page, first)
    eq('an ad-hoc run attaches to the terminal the user has open', attach?.terminalId, 'user-term')
    const result = await driveBridge(page, running)
    check('and the command runs there, visibly', result.summary.includes('bridge says hi'), result.summary.slice(-200))
    check('the header says the call is collaborative',
      result.summary.includes('this call is collaborative'), result.summary.slice(0, 340))
    eq('no private shell was opened for it', host.calls.spawned.length, 0)
    eq('and no subtask record was created', subtasks.list('session-1').total, 0)
    eq('and the user terminal was not closed', host.calls.closed.length, 0)
  }

  // The same page, but the run names a `subtask`: tracked work goes to a private shell this
  // tool manages, never into the user's terminal.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const page = makeBridgePage(host)
    const warm = page.poll()
    warm.catch(() => {})
    await tickMs(5)
    const subtasks = createSubtaskLog()
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, subtasks, transport: host.transport })
    const run = await tool.execute({ action: 'run', command: 'pwd', subtask: '私有子任务' }, { agent: { id: 'session-1' } })
    check('a subtask run uses a private shell instead of the user terminal',
      run.summary.includes('pty fallback output') && run.summary.includes('does not appear in the sidebar'),
      run.summary.slice(0, 340))
    check('the user terminal is untouched', !run.summary.includes('user-term'), run.summary.slice(0, 340))
    eq('one private shell was opened', host.calls.spawned.length, 1)
    check('and the subtask was recorded on it',
      subtasks.list('session-1').entries[0]?.terminalId === 'dsh-agent',
      JSON.stringify(subtasks.list('session-1').entries[0]?.terminalId))
  }

  // The page's inventory is authoritative for what the user sees: a sidebar terminal that the
  // host controller's ownership table no longer knew (measured after a recomposition) is still
  // a collaboration target.
  {
    const host = makeBridgeHarness({ terminals: [] })
    const page = makeBridgePage(host)
    const original = page.handle
    page.handle = async (command) => {
      if (command.kind === 'inventory') {
        page.inventories += 1
        await page.send([{ type: 'inventory', commandId: command.id, terminals: [browserTerminalOf('page-only', 'session-1')] }])
        return
      }
      await original(command)
    }
    const warm = page.poll()
    await tickMs(5)
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const listedRunning = tool.execute({ action: 'list' }, { agent: { id: 'session-1' } })
    const batch = await warm
    for (const command of batch.commands ?? []) await page.handle(command)
    const listed = await listedRunning
    check('the page inventory is listed even when the host list is empty',
      listed.summary.includes('page-only'), listed.summary)
    warm.catch(() => {})
  }
  // A terminal the tool opened is not a collaboration target, whichever list reports it.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')], withPty: false })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    const created = await host.transport.create({ id: 'session-1' }, { id: 'dsh-agent', cols: 80, rows: 24 })
    eq('the tool-created terminal exists for the controller too', created.id, 'dsh-agent')
    const usersRunning = host.transport.userTerminals('session-1')
    const batch = await warm
    for (const command of batch.commands ?? []) await page.handle(command)
    const users = await usersRunning
    eq('a terminal the tool created is not offered as the user\'s',
      users.map((info) => info.id).join(','), 'user-term')
    warm.catch(() => {})
  }

  // A terminal whose prompt is away — another command owns its foreground, and a streaming
  // `dsh` reply is exactly that — is never typed into: the keystrokes would queue and fire the
  // moment that command exits, corrupting the user's shell.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const page = makeBridgePage(host, { screen: 'xiny@XINY9:/home$ dsh "问题"\r\n⏱ 思考中… 2.1s' })
    const warm = page.poll()
    await tickMs(5)
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const running = tool.execute({ action: 'run', command: 'echo hi', timeoutMs: 450 }, { agent: { id: 'session-1' } })
    const first = await warm
    for (const command of first.commands ?? []) await page.handle(command)
    const run = await driveBridge(page, running)
    check('a busy terminal is not typed into', run.summary.includes('no prompt this tool recognises'),
      run.summary.slice(-420))
    check('the refusal names the dsh case and the way out',
      run.summary.includes('streaming `dsh` reply') && run.summary.includes('private shell'), run.summary.slice(-420))
    eq('and no keystrokes reached it', page.writes.length, 0)
  }

  // `>` is a fish prompt, but it is ALSO a Python REPL (`>>>`) and a heredoc continuation (`> `).
  // In a terminal the USER opened those are running programs, not a shell: the helper must not be
  // typed into them (in a heredoc it would land in the file the user is writing).
  for (const screen of ['>>> ', '> ']) {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const page = makeBridgePage(host, { screen })
    const warm = page.poll()
    await tickMs(5)
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const running = tool.execute({ action: 'run', command: 'echo hi', timeoutMs: 450 }, { agent: { id: 'session-1' } })
    const first = await warm
    for (const command of first.commands ?? []) await page.handle(command)
    const run = await driveBridge(page, running)
    check(`a bare ${JSON.stringify(screen)} prompt is not treated as a shell`,
      run.summary.includes('no prompt this tool recognises'), run.summary.slice(-420))
    eq(`and nothing is typed into ${JSON.stringify(screen)}`, page.writes.length, 0)
  }

  // No page at all: the bridge reports `pty`, and an ad-hoc run must fall back to the private
  // shell instead of picking the user's (undrivable) sidebar terminal out of the host list.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    eq('with no page the transport is the private shell', host.transport.kind, 'pty')
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const run = await tool.execute({ action: 'run', command: 'pwd' }, { agent: { id: 'session-1' } })
    check('an ad-hoc run with no page uses the private shell',
      run.summary.includes('pty fallback output') && !run.summary.includes('user-term'), run.summary.slice(0, 300))
    eq('and it really opened one', host.calls.spawned.length, 1)
    eq('and the user terminal was not attached to', host.calls.closed.length, 0)
  }

  // Raw keystrokes/Ctrl-C are never auto-aimed at a terminal the user opened: an explicit id
  // is the consent, because neither action can be taken back once it lands. That rule is about a
  // terminal the bridge can really drive — i.e. one a live page reports — so this harness keeps a
  // page polling while the two refusals are proven.
  {
    for (const [label, args] of [
      ['input without an id refuses to aim raw keys at the user terminal', { action: 'input', data: 'x' }],
      ['interrupt without an id is refused the same way', { action: 'interrupt' }],
    ]) {
      const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
      const page = makeBridgePage(host)
      const warm = page.poll()
      await tickMs(5)
      const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
      const outcome = tool.execute(args, { agent: { id: 'session-1' } })
        .then(() => null, (error) => String(error?.message ?? error))
      const first = await warm
      for (const command of first.commands ?? []) await page.handle(command)
      const failure = await outcome
      check(label, /explicit `id`/.test(String(failure)), String(failure))
    }
  }

  // `read` over the bridge: the snapshot is the screen, and the call still detaches.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const running = tool.execute({ action: 'read', id: 'user-term', timeoutMs: 200 }, { agent: { id: 'session-1' } })
    const first = await warm
    for (const command of first.commands ?? []) await page.handle(command)
    const read = await driveBridge(page, running)
    check('a read over the bridge returns the screen', read.summary.includes('user@host:~/proj'), read.summary.slice(-220))
    eq('a read does not type anything', page.writes.length, 0)
  }

  // A page that cannot attach reports why; the tool carries the sentence through.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const running = tool.execute({ action: 'read', id: 'user-term', timeoutMs: 500 }, { agent: { id: 'session-1' } })
    const first = await warm
    const attach = first.commands?.find((command) => command.kind === 'attach')
    await page.send([
      { type: 'result', commandId: attach.id, ok: true },
      { type: 'error', attachmentId: attach.attachmentId, message: 'the terminal tab was closed' },
    ])
    await rejects('a page that loses the terminal fails the call with its reason',
      () => running, /terminal tab was closed/)
  }

  // Input control is gone (the user clicked 接管输入): the write is refused, not silently dropped.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const running = tool.execute(
      { action: 'run', command: 'echo x', subtask: '只读', id: 'user-term' },
      { agent: { id: 'session-1' } },
    )
    const first = await warm
    for (const command of first.commands ?? []) await page.handle(command)
    const second = await page.poll()
    for (const command of second.commands ?? []) {
      if (command.kind === 'write') {
        await page.send([{
          type: 'result',
          commandId: command.id,
          ok: false,
          error: 'the terminal is read-only (the user took keyboard control)',
        }])
      }
    }
    await rejects('a read-only terminal surfaces as a refused write', () => running, /read-only/)
  }

  // Detaching an attachment must settle its in-flight write instead of leaving the `await`
  // pending until the 20 s write timeout — a dropped promise is also how an unhandled rejection
  // escapes later. This is the transport contract the tool's `finally` relies on.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    const controller = new AbortController()
    const frames = host.transport.follow({ id: 'session-1' }, 'user-term', 'att-detach', controller.signal)
    const iterator = frames[Symbol.asyncIterator]()
    const attachBatch = await warm
    for (const command of attachBatch.commands ?? []) await page.handle(command)
    const snapshot = await iterator.next()
    check('the attachment starts with its snapshot', snapshot.value?.type === 'snapshot')
    const write = host.transport.write({ id: 'session-1' }, 'user-term', 'att-detach', 'echo dropped')
    // The page receives the write and never acknowledges it; the caller detaches instead.
    await page.poll()
    const started = Date.now()
    await iterator.return()
    const outcome = await Promise.race([
      write.then(() => 'resolved', (error) => `rejected: ${String(error?.message ?? error)}`),
      tickMs(1_000).then(() => 'hung'),
    ])
    check('detaching rejects a write the page never acknowledged',
      String(outcome).startsWith('rejected') && Date.now() - started < 1_000, String(outcome))
  }

  // A closed window: the poll heartbeat stops and the call does not wait out its deadline.
  {
    const host = makeBridgeHarness({
      terminals: [browserTerminalOf('user-term')],
      timings: { clientTtlMs: 120, lostCheckMs: 20, attachTimeoutMs: 3_000, writeTimeoutMs: 3_000, pollHoldMs: 400 },
      withPty: false,
    })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    eq('a short-lived timing override still makes the transport the bridge', host.transport.kind, 'bridge')
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const running = tool.execute({ action: 'read', id: 'user-term', timeoutMs: 3_000 }, { agent: { id: 'session-1' } })
    await warm
    // No attach result and no further polls: the window is gone as far as the host can tell.
    await rejects('a window that stops answering fails the call instead of hanging it',
      () => running, /stopped answering the terminal bridge/)
  }

  // A second window waits instead of fighting the serving one: a live bridge keeps its
  // attachments, and the newcomer is answered empty.
  {
    const host = makeBridgeHarness({
      terminals: [browserTerminalOf('user-term')],
      timings: { clientTtlMs: 15_000, lostCheckMs: 1_000, attachTimeoutMs: 3_000, writeTimeoutMs: 3_000, pollHoldMs: 120 },
      withPty: false,
    })
    const firstPage = makeBridgePage(host, { clientId: 'window-a' })
    const warm = firstPage.poll()
    await tickMs(5)
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const running = tool.execute({ action: 'read', timeoutMs: 500 }, { agent: { id: 'session-1' } })
    const batch = await warm
    const attach = await driveToAttach(firstPage, batch)
    eq('the attachment was opened through the first window', attach?.terminalId, 'user-term')
    const secondPage = makeBridgePage(host, { clientId: 'window-b' })
    const secondBatch = await secondPage.poll()
    eq('a second window waits instead of stealing a live bridge', secondBatch.commands?.length, 0)
    const read = await running
    check('the first window keeps serving the attachment',
      read.summary.includes('user@host:~/proj'), read.summary.slice(-200))
  }

  // When the serving window goes quiet, the next window inherits the bridge and the stale
  // attachment fails instead of being driven by a page that is no longer there.
  {
    const host = makeBridgeHarness({
      terminals: [browserTerminalOf('user-term')],
      timings: { clientTtlMs: 120, lostCheckMs: 10_000, attachTimeoutMs: 3_000, writeTimeoutMs: 3_000, pollHoldMs: 100 },
      withPty: false,
    })
    const firstPage = makeBridgePage(host, { clientId: 'window-a' })
    const warm = firstPage.poll()
    await tickMs(5)
    const frames = host.transport.follow(
      { id: 'session-1' }, 'user-term', 'attach-stale', new AbortController().signal,
    )
    const iterator = frames[Symbol.asyncIterator]()
    const batch = await warm
    for (const command of batch.commands ?? []) await firstPage.handle(command)
    const first = await iterator.next()
    check('the first attachment streams its snapshot', first.value?.type === 'snapshot',
      JSON.stringify(first.value).slice(0, 140))
    await tickMs(180)
    const secondPage = makeBridgePage(host, { clientId: 'window-b' })
    secondPage.poll().catch(() => {})
    await rejects('a stale attachment fails when the next window takes over',
      async () => { await iterator.next() }, /another DSH window took over/)
    try { await iterator.return() } catch {}
  }

  // With no page at all, the same transport creates and drives its own PTY.
  {
    const host = makeBridgeHarness({ terminals: [] })
    eq('with no page polling, the transport is the private shell', host.transport.kind, 'pty')
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const run = await tool.execute({ action: 'run', command: 'pwd', subtask: '兜底' }, { agent: { id: 'session-1' } })
    check('the fallback opens a private PTY and reports its output',
      run.summary.includes('pty fallback output') && run.summary.includes('exit code: 0'), run.summary)
    check('the fallback says the shell is not in the sidebar',
      run.summary.includes('does not appear in the sidebar'), run.summary.slice(0, 260))
    eq('and it really spawned one shell', host.calls.spawned.length, 1)
  }

  // A browser terminal exists but no page is alive to drive it: the tool must fall back to the
  // private shell instead of picking an undrivable terminal (measured on the first restarted
  // build — the page had been hot-reloaded away and `run` failed instead of using the PTY).
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const run = await tool.execute({ action: 'run', command: 'pwd', subtask: '无页面兜底' }, { agent: { id: 'session-1' } })
    check('without a page the tool opens its own shell rather than an undrivable terminal',
      run.summary.includes('pty fallback output') && !run.summary.includes('user-term'), run.summary.slice(0, 300))
    eq('and that fallback really spawned a shell', host.calls.spawned.length, 1)
    eq('and it did not touch the browser terminal', host.calls.closed.length, 0)
  }

  // Automatic selection never touches a terminal the user opened, even with a page alive: the
  // tool keeps the private shell it already owns and leaves the user's terminal alone.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('browser-term')] })
    await host.transport.create({ id: 'session-1' }, { id: 'dsh-agent', cols: 120, rows: 30 })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const run = await tool.execute({ action: 'run', command: 'pwd', subtask: '不碰用户终端' }, { agent: { id: 'session-1' } })
    warm.catch(() => {})
    check('an automatically chosen shell is this tool\'s own private shell',
      run.summary.includes('pty fallback output') && run.summary.includes('does not appear in the sidebar'),
      run.summary.slice(0, 300))
    check('the user terminal was not attached to', !run.summary.includes('browser-term'), run.summary.slice(0, 300))
    eq('and no second shell was spawned', host.calls.spawned.length, 1)
  }

  // Ownership decides what may be closed and what `list` shows: the tool's own shells only.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('browser-term')] })
    await host.transport.create({ id: 'session-1' }, { id: 'dsh-agent', cols: 120, rows: 30 })
    eq('a shell this tool opened is owned', host.transport.owns('session-1', 'dsh-agent'), true)
    eq('a terminal the user opened is not', host.transport.owns('session-1', 'browser-term'), false)
    eq('list shows only the tool\'s own shells',
      host.transport.list('session-1').map((info) => String(info.id)).join(','), 'dsh-agent')
    eq('describing the user terminal still works for explicit calls',
      host.transport.describe('session-1', 'browser-term')?.id, 'browser-term')
    eq('the private shell is worded as a PTY', host.transport.kindOf('session-1', 'dsh-agent'), 'pty')
    eq('the user terminal is worded as bridge-driven', host.transport.kindOf('session-1', 'browser-term'), 'bridge')
  }

  // A shell opened while the window was closed stays drivable after it reopens, and remains the
  // only thing `list` shows: the user's browser terminal never joins that list.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('browser-term')] })
    await host.transport.create({ id: 'session-1' }, { id: 'dsh-agent', cols: 120, rows: 30 })
    eq('a closed window still gets a private shell', host.calls.spawned.length, 1)
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    eq('the reopened window turns the transport back into the bridge', host.transport.kind, 'bridge')
    eq('one list holds only the fallback shell',
      host.transport.list('session-1').map((info) => String(info.id)).join(','), 'dsh-agent')
    // The page is alive but the call is over: the held poll is expected to time out, and its
    // rejection is handled so it cannot surface as an unhandled one.
    warm.catch(() => {})
  }

  // `create` prefers the private PTY; only a host without a PTY provider creates a browser
  // terminal through the controller — and that one is recorded as the tool's own.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('browser-term')] })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    const info = await host.transport.create({ id: 'session-1' }, { id: 'dsh-agent', cols: 120, rows: 30 })
    check('a private shell is preferred for the tool\'s own work',
      info.id === 'dsh-agent' && host.calls.spawned.length === 1 && host.calls.created.length === 0,
      `spawned=${host.calls.spawned.length} created=${host.calls.created.length}`)
    warm.catch(() => {})
  }
  {
    const host = makeBridgeHarness({ terminals: [], withPty: false })
    const page = makeBridgePage(host)
    const warm = page.poll()
    await tickMs(5)
    const info = await host.transport.create({ id: 'session-1' }, { id: 'dsh-agent', cols: 80, rows: 24 })
    eq('without a PTY provider a live bridge creates through the host controller', info.id, 'dsh-agent')
    eq('the controller recorded the creation', host.calls.created.length, 1)
    eq('and the created terminal is recorded as this tool\'s own',
      host.transport.owns('session-1', 'dsh-agent'), true)
    warm.catch(() => {})
  }

  // A follow with no window is a readable refusal, never a `follow is not a function` crash.
  {
    const host = makeBridgeHarness({ terminals: [browserTerminalOf('user-term')] })
    await rejects('a follow with no window explains that no page is open',
      async () => Promise.resolve(host.transport.follow(
        { id: 'session-1' }, 'user-term', 'att-x', new AbortController().signal,
      )), /not answering the terminal bridge/)
  }

  // The bridge wording is what the model reads, and the catalog budget is measured on the
  // REAL mount (index.js hands the tool its transport), so the budget must be checked on this
  // variant too — the fallback wording the other checks see is shorter.
  {
    const host = makeBridgeHarness({ terminals: [] })
    const tool = createWslTermTool({ ctx: host.ctx, config: CONFIG, transport: host.transport })
    const cost = tool.description.length + JSON.stringify(tool.parameters).length
    check('the bridge wording fits the model-facing catalog budget', cost <= 2_700, `${cost} chars`)
    check('the bridge wording separates collaborative commands from tracked subtasks',
      tool.description.includes('WITHOUT a `subtask`')
      && tool.description.includes('runs in the terminal YOU have open')
      && tool.description.includes('read-only')
      && tool.description.includes('`close` it when the subtask is done'),
      tool.description.slice(-360))
  }

  // The plugin itself publishes the two routes when the host is a 0.2.1 build, and the subtask
  // route turns the terminals the USER opened into records beside the subtasks (collapsed dock).
  {
    const shim = makeShim(mkdtempSync(join(tmpdir(), 'dsh-wsl-bridge-')))
    const shared = [browserTerminalOf('shared-term', 'session-1')]
    const tools = makeCtx(shim, {
      terminalController: {
        list: (sessionId) => shared.filter((info) => info.sessionId === sessionId),
        create: async () => {},
        close: async () => {},
      },
    })
    eq('the plugin publishes the bridge routes alongside its own', tools.routes.length, 10)
    check('the bridge routes are the two the client half polls',
      tools.routes.filter((entry) => entry.path.startsWith('/dsh-wsl-tool/term-bridge/')).length === 2,
      JSON.stringify(tools.routes.map((entry) => entry.path)))
    const subtaskRoute = tools.routes.find((entry) => entry.path === '/dsh-wsl-tool/subtasks')
    check('the subtask route is namespaced', subtaskRoute !== undefined,
      JSON.stringify(tools.routes.map((entry) => entry.path)))
    // The self-info route is how a person (or a script) checks, after a restart, whether the
    // bridge half is really mounted and whether a page is polling right now.
    const infoRoute = tools.routes.find((entry) => entry.path === '/dsh-wsl-tool/info')
    const answered = {
      writeHead(code, headers) { this.code = code; this.headers = headers },
      end(text) { this.body = text },
    }
    await infoRoute.handler({ method: 'GET' }, answered)
    const info = JSON.parse(answered.body)
    eq('the self-info route reports the bridge build', info.terminal?.bridgeCapable, true)
    eq('and reports that no page is driving it yet', info.terminal?.bridge?.client, false)
    check('and reports counts only, never ids',
      JSON.stringify(Object.keys(info.terminal ?? {}).sort()) === '["bridge","bridgeCapable","kind"]'
      && JSON.stringify(Object.keys(info.terminal?.bridge ?? {}).sort()) === '["attachments","client","pending"]',
      JSON.stringify(info.terminal))
    // The user's own terminals are a PAGE fact: only a live page can answer `userTerminals`, which
    // is the same rule that makes an ad-hoc command fall back to the private shell when the window
    // is closed. So the dock's check keeps a page polling for its whole length.
    const page = makeBridgePage({ routes: tools.routes, live: shared })
    let polling = true
    const pump = (async () => {
      while (polling) {
        const batch = await page.poll()
        for (const command of batch.commands ?? []) await page.handle(command)
      }
    })().catch(() => {})
    await tickMs(10)
    const readSubtasks = async (sessionId) => {
      const response = {
        writeHead() {},
        end(text) { this.body = text },
      }
      const query = sessionId === undefined ? '' : `?session=${encodeURIComponent(sessionId)}`
      await subtaskRoute.handler({ method: 'GET', url: `/dsh-wsl-tool/subtasks${query}` }, response)
      return JSON.parse(response.body)
    }
    // The user's terminal is listed as a record of its own once the dock asks for its session.
    const inventoriesBefore = page.inventories
    let payload = await readSubtasks('session-1')
    eq('the dock request answers only the session it asked about',
      Object.keys(payload.sessions).join(','), 'session-1')
    eq('and one request costs exactly one inventory round trip', page.inventories - inventoriesBefore, 1)
    const record = payload.sessions['session-1']?.entries?.[0]
    check('a terminal the user opened is listed beside the subtasks',
      String(record?.title ?? '').startsWith('用户建立的终端'), JSON.stringify(record))
    eq('and it is marked as a user terminal', record?.userTerminal, true)
    eq('and it shows as in use while the terminal runs', record?.status, 'running')
    eq('and it does not count as a running subtask', payload.sessions['session-1']?.running, 0)
    // Polling again must not re-create or rewrite anything while the shell is unchanged: the row
    // used to be refreshed (and re-sorted above real subtasks) on every 2 s poll.
    const secondPoll = await readSubtasks('session-1')
    eq('a second poll returns the same single record',
      (secondPoll.sessions['session-1']?.entries ?? []).length, 1)
    // Closing it (the user closes the tab) ends that record; the tool never closes it itself.
    shared.length = 0
    // The bridge caches the page's inventory for a second (the dock asks every 2 s), so a change
    // is observed only after that TTL: waiting it out is what a real window would do too.
    await tickMs(1_100)
    payload = await readSubtasks('session-1')
    const ended = payload.sessions['session-1']?.entries?.[0]
    eq('after the user closes it the record reads as ended', ended?.status, 'done')
    eq('and it is marked closed', ended?.terminal, 'closed')
    // The app re-creates a tab with a new id but the same shell title. That must be a NEW
    // record: the closed one keeps its ended state, and nothing is rewritten in place.
    shared.push(browserTerminalOf('shared-term-2', 'session-1'))
    await tickMs(1_100)
    payload = await readSubtasks('session-1')
    const entries = payload.sessions['session-1']?.entries ?? []
    eq('a re-created terminal gets a second record', entries.length, 2)
    // Order between two records made in the same millisecond is not a contract: find them.
    const recreated = entries.find((entry) => entry.terminalId === 'shared-term-2')
    const closed = entries.find((entry) => entry.terminalId === 'shared-term')
    eq('the new record is the running one', recreated?.status, 'running')
    check('and its title is numbered, not reused',
      recreated?.title === '用户建立的终端「WSL」 #2', recreated?.title)
    eq('while the closed one still reads as ended', closed?.status, 'done')
    eq('and it still points at the old terminal', closed?.terminalId, 'shared-term')
    // A request without `?session` still answers every logged conversation (the browser always
    // names one; this keeps the route usable from a script).
    const unfiltered = await readSubtasks(undefined)
    check('a request without ?session still returns the logged session',
      'session-1' in unfiltered.sessions, JSON.stringify(Object.keys(unfiltered.sessions)))
    polling = false
    await pump
  }
}

/**
 * DSH 0.2.1-rc.3 mounts the web-app rows (and `terminalController`) AFTER a profile plugin's
 * `apply`. The plugin used to resolve the terminal transport once at apply, silently froze the
 * private-PTY fallback for the whole run, and kept reporting `terminal: pty` in `/info` while the
 * browser bridge (terminal history, user-terminal collaboration) was unavailable.
 *
 * These checks drive the lazy handle directly, then the whole plugin through a fake ctx whose
 * `get('terminalController')` appears later and whose `inject` callback is kept for the test.
 */
async function lazyTransportTests() {
  console.log('\nterminal transport: lazy resolution and late upgrade')

  /** The host subprocess seam: `spawn` for the runner's probes, `spawnTerminal` for the PTY. */
  const makeFakeSubprocess = () => {
    const empty = () => ({ readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) })
    return {
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() {},
          collected: { stdout: empty(), stderr: empty() },
        }
      },
      resolveExecutable: async (name) => `C:/Windows/System32/${name}`,
      async spawnTerminal() { return makeBridgePtyHandle() },
    }
  }
  /** The host's `terminalController` once it mounts: the three calls the bridge requires. */
  const makeFakeController = () => {
    const calls = { list: [], create: [], close: [] }
    return {
      calls,
      list(sessionId) {
        calls.list.push(sessionId)
        return [{ id: 'user-term', title: 'WSL', sessionId }]
      },
      async create(agent, request) {
        calls.create.push({ agentId: agent?.id, id: request?.id })
        return { id: request?.id, title: 'WSL', state: 'running', cols: 80, rows: 24 }
      },
      async close(agent, id) {
        calls.close.push({ agentId: agent?.id, id })
      },
    }
  }
  /**
   * A fake plugin context whose terminal service can appear later.
   *
   * `inject(['terminalController', …])` callbacks are KEPT so the test decides when the service
   * "mounts"; the bridge's own `inject(['webServer'])` is answered at once so it can publish its
   * two routes.
   */
  const makeLateCtx = ({ withPty = true } = {}) => {
    const state = { controller: undefined }
    const tools = {}
    const routes = []
    const injected = []
    const registered = []
    const effects = []
    const webServer = { register(route) { routes.push(route); return () => {} } }
    const effect = (fn) => { effects.push(fn); return () => {} }
    const subprocess = makeFakeSubprocess()
    const ctx = {
      tools: {
        register(tool) {
          tools[tool.name] = tool
          registered.push(tool.name)
          return () => { if (tools[tool.name] === tool) delete tools[tool.name] }
        },
      },
      subprocess,
      get(name) {
        if (name === 'terminalController') return state.controller
        if (name === 'subprocess') return withPty ? subprocess : undefined
        return undefined
      },
      on() { return () => {} },
      inject(deps, callback) {
        const list = Array.isArray(deps) ? deps : []
        if (list.includes('terminalController')) {
          injected.push(callback)
          return
        }
        try {
          callback({ webServer, effect })
        } catch {
          // A host whose web server cannot serve the routes keeps the PTY fallback.
        }
      },
      effect,
    }
    return { ctx, tools, state, injected, routes, registered, webServer, effect, subprocess }
  }
  const readInfo = async (routes) => {
    const response = await callRoute(routes.find((route) => route.path === '/dsh-wsl-tool/info'), 'GET')
    return JSON.parse(response.body)
  }
  const termRegistrations = (host) => host.registered.filter((name) => name === 'wsl-term').length

  // 1) The PTY first, then the controller arrives: the stable handle upgrades and follows it.
  {
    const late = makeLateCtx()
    const lazy = createLazyTerminalTransport({ ctx: late.ctx, config: CONFIG })
    eq('a host without a terminal controller starts on the private shell', lazy.kind, 'pty')
    eq('and is not bridge-capable yet', lazy.bridgeCapable, false)
    const controller = makeFakeController()
    late.state.controller = controller
    eq('upgrade reports that the bridge took over', await lazy.upgrade(), true)
    eq('and the handle is now bridge-capable', lazy.bridgeCapable, true)
    // The bridge reports `kind: 'bridge'` once a page is really polling: drive one poll.
    const page = makeBridgePage({ routes: late.routes, live: [] })
    const warm = page.poll()
    await tickMs(5)
    eq('and once a page polls it reports the bridge generation', lazy.kind, 'bridge')
    warm.catch(() => {})
    lazy.describe('s', 'gone')
    eq('describe now goes through the new controller', controller.calls.list[0], 's')
  }

  // 2) No controller ever appears: the upgrade refuses and the PTY stays.
  {
    const late = makeLateCtx()
    const lazy = createLazyTerminalTransport({ ctx: late.ctx, config: CONFIG })
    eq('an upgrade with nothing to upgrade to reports false', await lazy.upgrade(), false)
    eq('and the handle keeps serving the private shell', lazy.kind, 'pty')
  }

  // 3) A host with no terminal service at all: every call is inert or says what is missing.
  {
    const bare = makeLateCtx({ withPty: false })
    const lazy = createLazyTerminalTransport({ ctx: bare.ctx, config: CONFIG })
    eq('a host with neither a controller nor a PTY has no generation', lazy.kind, null)
    eq('and is not bridge-capable', lazy.bridgeCapable, false)
    eq('its list is empty', JSON.stringify(lazy.list('s')), '[]')
    eq('its user-terminal list is empty', JSON.stringify(lazy.userTerminals('s')), '[]')
    eq('its status is null', lazy.status(), null)
    eq('its describe is null', lazy.describe('s', 'x'), null)
    await rejects('create without a transport says so', () => lazy.create({ id: 's' }, { id: 't' }),
      /no terminal transport/)
    await rejects('follow without a transport says so', () => lazy.follow({ id: 's' }, 't', 'a', new AbortController().signal),
      /no terminal transport/)
  }

  // 4) The whole plugin: apply runs BEFORE the controller is mounted (the rc.3 ordering).
  {
    const late = makeLateCtx()
    apply(late.ctx, {})
    const infoBefore = await readInfo(late.routes)
    eq('before the controller mounts the info route reports the private shell', infoBefore.terminal?.kind, 'pty')
    eq('and reports the build as not bridge-capable', infoBefore.terminal?.bridgeCapable, false)
    const oldTerm = late.tools['wsl-term']
    check('the terminal tool words itself as the private-shell variant',
      typeof oldTerm?.description === 'string' && oldTerm.description.includes('does not let a plugin join'),
      String(oldTerm?.description).slice(-200))
    const before = termRegistrations(late)
    // The host now mounts its web-app rows; `terminalController` becomes available.
    late.state.controller = makeFakeController()
    for (const callback of late.injected) callback({ webServer: late.webServer, effect: late.effect })
    eq('the terminal tool is re-registered after the upgrade', termRegistrations(late), before + 1)
    const newTerm = late.tools['wsl-term']
    check('the re-registered instance is a new object', newTerm !== oldTerm)
    check('and its description offers the browser terminal',
      typeof newTerm?.description === 'string'
      && newTerm.description.includes('接管输入') && newTerm.description.includes('runs in the terminal YOU have open'),
      String(newTerm?.description).slice(-260))
    eq('the info route now reports a bridge-capable build',
      (await readInfo(late.routes)).terminal?.bridgeCapable, true)
    const page = makeBridgePage({ routes: late.routes, live: [] })
    const warm = page.poll()
    await tickMs(5)
    eq('and the generation is the browser bridge once a page polls',
      (await readInfo(late.routes)).terminal?.kind, 'bridge')
    warm.catch(() => {})
  }

  // 5) A host that already had the controller at apply: nothing is re-registered.
  {
    const ready = makeLateCtx()
    ready.state.controller = makeFakeController()
    apply(ready.ctx, {})
    const termBefore = ready.tools['wsl-term']
    const before = termRegistrations(ready)
    eq('a host that already has the controller starts bridge-capable',
      (await readInfo(ready.routes)).terminal?.bridgeCapable, true)
    for (let round = 0; round < 2; round += 1) {
      for (const callback of ready.injected) callback({ webServer: ready.webServer, effect: ready.effect })
    }
    eq('a later injection of the same services does not re-register the tool', termRegistrations(ready), before)
    check('and the terminal tool instance is unchanged', ready.tools['wsl-term'] === termBefore)
  }

  // 6) `/info` with no resolved generation omits the terminal block entirely.
  {
    const bare = makeLateCtx({ withPty: false })
    apply(bare.ctx, {})
    eq('a host with no terminal service reports no terminal block',
      (await readInfo(bare.routes)).terminal, null)
    check('and the terminal tool says it cannot drive anything',
      String(bare.tools['wsl-term']?.description ?? '').includes('no terminal this tool can drive'),
      String(bare.tools['wsl-term']?.description ?? '').slice(-160))
  }
}


/**
 * Drive `lib/channel.js` against fake host services: a real HTTP server on loopback, the
 * real state file and the real frame protocol. What cannot be faked here is the DSH client
 * itself, so the checks assert the contract the shim relies on — auth, frame order, base64
 * chunks, the end line — rather than what the GUI paints.
 */
async function channelUnitTests() {
  eq('an unset channel session means the host picks the conversation', channelSessionOf({}), '')
  eq('a blank channel session stays unset', channelSessionOf({ channelSession: '   ' }), '')
  eq('a configured channel session is trimmed', channelSessionOf({ channelSession: '  work  ' }), 'work')

  const headerRecord = sessionRecordOf({ header: { id: 'a', cwd: 'D:\\x', createdAt: 5 } })
  eq('a session record reads the header',
    `${headerRecord.id}|${headerRecord.cwd}|${String(headerRecord.createdAt)}`, 'a|D:\\x|5')
  eq('a session record reads the nested session', sessionRecordOf({ session: { id: 'b' } }).id, 'b')
  eq('an unreadable session record becomes empty', sessionRecordOf({ nope: 1 }).id, '')
  eq('titles read from a Map', titlesOf(new Map([['a', 'T']])).get('a'), 'T')
  eq('titles read from an array', titlesOf([{ id: 'a', title: 'T' }]).get('a'), 'T')
  eq('titles read from an object', titlesOf({ a: { title: 'T' } }).get('a'), 'T')
  eq('firstUserLine reads the first user sentence as a label', firstUserLine([
    { type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'system prompt' }] } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '  帮我看看当前目录  ' }] } },
  ]), '帮我看看当前目录')
  eq('firstUserLine skips injected instructions when nothing else is there', firstUserLine([
    { type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'system prompt' }] } },
  ]), '')
  eq('firstUserLine shortens a long first message', firstUserLine([
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(60) }] } },
  ]), 'x'.repeat(28) + '…')
  eq('titles read a title snapshot object (the real value shape)',
    titlesOf([{ sessionId: 'a', status: 'fulfilled', value: { session: { id: 'a' }, title: { title: 'T3' } } }]).get('a'), 'T3')
  eq('titles read from settled results (the real sessionQuery shape)',
    titlesOf([{ sessionId: 'a', status: 'fulfilled', value: { session: { id: 'a' }, title: { title: 'T2' } } }, { status: 'rejected', reason: new Error('x') }]).get('a'), 'T2')
  const forkedRecord = sessionRecordOf({ header: { id: 'f', parentSession: 'p', origin: 'subagent' } })
  eq('a session record exposes the fork fields the picker filters on', `${String(forkedRecord.parentSession)}|${String(forkedRecord.origin)}`, 'p|subagent')

  const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-channel-'))
  const listeners = new Map()
  const calls = []
  /** Every `sessionController.cancel` the channel issued (a terminal Ctrl+C must issue one). */
  const cancelCalls = []
  // One-shot script for the next `prompt` call, so a test can emit exactly the events its
  // scenario is about (multi-step usage, a stream-only usage, ...). Null = the default answer.
  let promptScript = null
  /** Refuse the next `prompt` admission once (see the cancel-settle checks). */
  let rejectNextPrompt = null
  /** Hold the next `prompt` admission until the test settles it (see the abort check). */
  let deferNextPrompt = null
  const sessions = new Map([
    ['session-a', { id: 'session-a', cwd: 'D:\\work', createdAt: 3 }],
    ['wsl', { id: 'wsl', cwd: 'D:\\work', createdAt: 2 }],
  ])
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  let balanceReply = {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '12.5' }],
    bonusWallets: [{ currency: 'CNY', balance: '2' }],
  }
  const balanceClients = []
  const services = {
    sessionController: {
      async prompt(request, signal) {
        calls.push(['prompt', request, signal])
        // Scenario seams for the cancel-settle checks: refuse the next admission once (the
        // cancelled turn is still finishing), or hold it until the test settles it by hand.
        if (rejectNextPrompt !== null) {
          const error = rejectNextPrompt
          rejectNextPrompt = null
          throw error
        }
        if (deferNextPrompt !== null) {
          const deferred = deferNextPrompt
          deferNextPrompt = null
          return new Promise((resolve, reject) => {
            deferred.resolve = resolve
            deferred.reject = reject
          })
        }
        const id = request.sessionId
        if (typeof promptScript === 'function') {
          promptScript(emit, id)
          return { accepted: true }
        }
        setTimeout(() => {
          emit('agent/assistant-stream', { agent: { session: { id } }, frame: { type: 'start' } })
          emit('agent/assistant-stream', { agent: { session: { id } }, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'why' } } })
          emit('agent/assistant-stream', { agent: { session: { id } }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'he' } } })
          emit('agent/assistant-stream', { agent: { session: { id } }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'llo' } } })
        }, 5)
        setTimeout(() => {
          emit('session/event', { id }, { type: 'step/start', data: { turn: 1, step: 1 } })
          emit('session/event', { id }, {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'hello' }] }, usage: { inputTokens: 9, outputTokens: 2 } },
          })
          emit('session/event', { id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        }, 25)
        return { accepted: true }
      },
      /** The GUI's own stop path; a terminal Ctrl+C must go through exactly this. */
      async cancel(request) {
        cancelCalls.push(request)
      },
      async list() {
        return {
          items: [...sessions.values()].map((session) => ({
            sessionId: session.id,
            updatedAt: session.createdAt ?? 1,
            cwd: session.cwd,
          })),
        }
      },
      async create(request) {
        calls.push(['create', request])
        const id = request.sessionId ?? 'minted'
        sessions.set(id, { id, cwd: request.cwd })
        return { sessionId: id }
      },
    },
    sessionQuery: {
      async listSessions() { return [...sessions.values()] },
      async readTitleSnapshots(ids) { return new Map(ids.map((id) => [id, `title of ${id}`])) },
    },
    workspaceController: {
      async archiveSession(request) { calls.push(['archive', request]); return {} },
    },
    deepseekAccount: {
      async getBalance(client) {
        balanceClients.push(client)
        return balanceReply
      },
    },
    agents: {
      get(id) {
        if (id === 'open-1') return { id }
        if (id === 'session-busy') return { id, status: 'running' }
        // The terminal-history scenarios target this conversation; it must have a live agent
        // (the bridge needs one to attach), while `session-a` stays archiveable below.
        if (id === 'history-session') return { id }
        // The cancel-settle scenarios need an agent that KEEPS reporting `running` while the
        // just-cancelled turn tears down — that is the state that used to swallow the prompt.
        if (id === 'session-cancel') return { id, status: 'running' }
        return undefined
      },
    },
  }
  const ctx = {
    get(name) { return services[name] },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name)?.delete(fn)
    },
  }
  const wslCalls = []
  const wsl = async (argv) => {
    wslCalls.push(argv)
    // Answer the route probe with nothing: a fake address would force a bind to an interface
    // CI does not have, and the fallback path is what must be proven here.
    if (argv.join(' ').includes(' route ')) return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '/home/xiny/.local/bin/dsh\n', stderr: '' }
  }
  const config = { channelEnabled: true, channelSession: 'wsl' }
  const channel = createChannel({ ctx, config, wsl, env: { USERPROFILE: home } })
  const { port, host } = await channel.start()
  // The state file lives under the profile's local app data, not in the plugin checkout.
  const stateFile = channel.stateFile
  const call = (method, path, body, headers = {}) => new Promise((done, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', fail)
    if (body !== undefined) request.write(body)
    request.end()
  })
  try {
    check('the channel binds a real port', port > 0, String(port))
    check('the channel asks WSL for the host address',
      wslCalls.some((argv) => argv.join(' ').includes(' route ')), JSON.stringify(wslCalls))
    eq('it falls back to every interface when WSL cannot answer', host, '0.0.0.0')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    eq('the state file advertises the port', state.port, port)
    eq('the state file advertises the session', state.sessionId, 'wsl')
    eq('the state file carries a 64-char token', state.token.length, 64)
    eq('the token is this channel instance\'s', state.token, channel.token)

    /** Number of ctx event listeners the channel currently holds (every event name). */
    const listenerCount = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
    /**
     * Start a `/say` and destroy the response socket as soon as it is acknowledged — exactly what
     * Ctrl+C does in a terminal. The request dies; the turn would otherwise keep running in the
     * client conversation, which is why the host has to be told to cancel it.
     */
    const disconnectSay = (target) => new Promise((resolve, reject) => {
      let destroyed = false
      const guard = setTimeout(() => reject(new Error('the /say stream never acknowledged')), 2_000)
      if (typeof guard.unref === 'function') guard.unref()
      const request = httpRequest({
        host: '127.0.0.1', port, method: 'POST', path: '/say',
        headers: { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token, 'x-dsh-wsl-session': target },
      }, (response) => {
        let buffer = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          buffer += chunk
          if (destroyed || !buffer.includes('~ack')) return
          destroyed = true
          clearTimeout(guard)
          response.destroy()
          resolve()
        })
        response.on('error', () => {})
      })
      request.on('error', () => {})
      request.write('ctrl-c')
      request.end()
    })

    // `/state` authenticates like every other route: the shim holds the token before it probes,
    // and an unauthenticated status line would hand the port/session to anything on 127.0.0.1.
    const stateDenied = await call('GET', '/state')
    eq('the state route needs the channel token', stateDenied.status, 401)
    const stateLine = await call('GET', '/state', undefined, { 'x-dsh-wsl-token': state.token })
    check('the state route answers the shim with the token',
      stateLine.status === 200
      && stateLine.body.includes('enabled=1') && stateLine.body.includes(`port=${String(port)}`),
      `[${stateLine.status}] ${stateLine.body}`)

    const denied = await call('POST', '/say', 'hi', { 'content-type': 'text/plain' })
    eq('a request without the token is refused', denied.status, 401)
    const wrong = await call('POST', '/say', 'hi', { 'content-type': 'text/plain', 'x-dsh-wsl-token': 'x'.repeat(64) })
    eq('a request with a wrong token is refused', wrong.status, 401)

    const said = await call('POST', '/say', 'hi', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('the say route answers 200', said.status, 200)
    const frames = said.body.split('\n').filter((line) => line !== '')
    eq('the first frame acknowledges the request', frames[0], '~ack')
    check('the turn reports when reasoning started', /^~r \d+$/.test(frames.find((line) => line.startsWith('~r')) ?? ''), said.body)
    check('the turn reports when text started', /^~t \d+$/.test(frames.find((line) => line.startsWith('~t')) ?? ''), said.body)
    const chunkText = frames.filter((line) => line.startsWith('~a '))
      .map((line) => Buffer.from(line.slice(3), 'base64').toString('utf8')).join('')
    eq('answer chunks come back as raw text', chunkText, 'hello')
    check('the reasoning text is not streamed to the terminal', !frames.some((line) => line.startsWith('~s ')), said.body)
    check('one step frame is sent', frames.some((line) => line.startsWith('~step ')), said.body)
    const endFrame = frames.find((line) => line.startsWith('~e ')) ?? ''
    const end = endFrame.split(' ')
    eq('the end frame reports success', end[1], '1')
    eq('the end frame counts the steps', end[3], '1')
    eq('the end frame carries the usage', `${end[4]}/${end[5]}`, '9/2')
    eq('the end frame names the reason', Buffer.from(end.slice(6).join(' '), 'base64').toString('utf8'), 'completed')
    const prompted = calls.find((entry) => entry[0] === 'prompt')
    eq('the prompt goes through the client session controller', prompted?.[1]?.sessionId, 'wsl')
    eq('the prompt is forwarded verbatim behind the terminal marker', prompted?.[1]?.content?.[0]?.text, SAY_PREFIX + 'hi')
    check('the terminal marker is the documented one', SAY_PREFIX.length > 0 && SAY_PREFIX !== ' ', SAY_PREFIX)
    eq('an idle conversation starts a normal turn', prompted?.[1]?.mode, 'queue')
    check('the prompt carries a request id', typeof prompted?.[1]?.requestId === 'string' && prompted[1].requestId !== '')

    // A busy conversation is steered: the line joins the live turn instead of waiting behind
    // it, which is what makes the terminal a usable second surface for the same chat.
    const steeredSay = await call('POST', '/say', 'in line', {
      'content-type': 'text/plain',
      'x-dsh-wsl-token': state.token,
      'x-dsh-wsl-session': 'session-busy',
    })
    eq('a steered answer still streams back', steeredSay.status, 200)
    eq('a busy conversation steers instead of queueing',
      calls.filter((entry) => entry[0] === 'prompt').at(-1)?.[1]?.mode, 'steer')
    eq('the steered line still reaches the controller',
      calls.filter((entry) => entry[0] === 'prompt').length, 2)

    // Self-lock: a tool call inside session X asks the terminal to send a prompt to X. The
    // prompt would join X's live turn, whose end waits for this command — refuse with the
    // reason instead of hanging until the deadline.
    const selfLock = await call('POST', '/say', 'hello self', {
      'content-type': 'text/plain',
      'x-dsh-wsl-token': state.token,
      'x-dsh-wsl-session': 'session-busy',
      'x-dsh-wsl-caller': 'session-busy',
    })
    eq('a prompt aimed back at the waiting session is refused', selfLock.status, 409)
    check('and the refusal says why, instead of hanging',
      /无法执行/.test(selfLock.body) && /自锁/.test(selfLock.body), selfLock.body)
    eq('and nothing reached the controller', calls.filter((entry) => entry[0] === 'prompt').length, 2)
    // A caller that is a DIFFERENT conversation (or no caller header at all) still works.
    const callerElsewhere = await call('POST', '/say', 'from another session', {
      'content-type': 'text/plain',
      'x-dsh-wsl-token': state.token,
      'x-dsh-wsl-session': 'session-busy',
      'x-dsh-wsl-caller': 'session-a',
    })
    eq('a prompt from another session still streams', callerElsewhere.status, 200)

    // Multi-step turns: every `assistant/message` carries THAT step's usage, so the end frame
    // must report the SUM over the turn. The live `usage` chunk is only the current step's
    // progress (and the fallback when no message-level usage arrives). The measured regression:
    // a long task ended with `in 187 / out 42 tok` while the turn had spent far more.
    {
      const endUsage = (body) => {
        const end = (body.split('\n').find((line) => line.startsWith('~e ')) ?? '').split(' ')
        return { ok: end[1], steps: end[3], usage: `${end[4]}/${end[5]}` }
      }
      promptScript = (emit, id) => {
        setTimeout(() => {
          emit('session/event', { id }, { type: 'step/start', data: { turn: 1, step: 1 } })
          emit('session/event', { id }, {
            type: 'assistant/message',
            data: { message: { content: [] }, usage: { inputTokens: 20, outputTokens: 3 } },
          })
          emit('session/event', { id }, { type: 'step/start', data: { turn: 1, step: 2 } })
          emit('session/event', { id }, {
            type: 'assistant/message',
            data: { message: { content: [] }, usage: { inputTokens: 10, outputTokens: 2 } },
          })
          emit('session/event', { id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        }, 5)
      }
      const multi = await call('POST', '/say', 'two steps', {
        'content-type': 'text/plain', 'x-dsh-wsl-token': state.token, 'x-dsh-wsl-session': 'session-a',
      })
      const multiEnd = endUsage(multi.body)
      eq('a two-step turn sums both steps\' usage in the end frame', multiEnd.usage, '30/5')
      eq('and the end frame counts both steps', multiEnd.steps, '2')
      // Control: no message-level usage at all. The streamed usage chunk is the fallback, and it
      // must be reported instead of a zero that reads like a free turn.
      promptScript = (emit, id) => {
        setTimeout(() => {
          emit('agent/assistant-stream', {
            agent: { session: { id } },
            frame: { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } } },
          })
          emit('session/event', { id }, { type: 'step/start', data: { turn: 1, step: 1 } })
          emit('session/event', { id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        }, 5)
      }
      const streamOnly = await call('POST', '/say', 'stream usage only', {
        'content-type': 'text/plain', 'x-dsh-wsl-token': state.token, 'x-dsh-wsl-session': 'session-a',
      })
      const streamEnd = endUsage(streamOnly.body)
      eq('without step usage the streamed usage is the fallback', streamEnd.usage, '7/3')
      check('and it is not reported as a free turn', streamEnd.usage !== '0/0', streamEnd.usage)
      promptScript = null
    }

    // Ctrl+C in the terminal kills the stream, but the turn itself keeps running inside the
    // client conversation. The host's own `sessionController.cancel` (the GUI stop button's
    // path) is what stops it — exactly once, for exactly that conversation, and with the
    // prompt's AbortSignal already aborted. The stream must also leave no listeners or
    // heartbeat interval behind, or every interruption would leak one of each.
    {
      const beforeListeners = listenerCount()
      const beforeCancel = cancelCalls.length
      const intervals = { created: 0, cleared: 0 }
      const liveIntervals = new Set()
      const realSetInterval = globalThis.setInterval
      const realClearInterval = globalThis.clearInterval
      globalThis.setInterval = (callback, ms, ...args) => {
        const handle = realSetInterval(callback, ms, ...args)
        intervals.created += 1
        liveIntervals.add(handle)
        return handle
      }
      globalThis.clearInterval = (handle) => {
        if (liveIntervals.delete(handle)) intervals.cleared += 1
        return realClearInterval(handle)
      }
      try {
        promptScript = () => { /* accepted; this turn is expected to keep running */ }
        await disconnectSay('session-a')
        await tickMs(120)
        eq('a client disconnect cancels the running turn exactly once', cancelCalls.length - beforeCancel, 1)
        eq('and the cancel names the conversation the turn belongs to',
          cancelCalls.at(-1)?.sessionId, 'session-a')
        const promptSignal = calls.filter((entry) => entry[0] === 'prompt').at(-1)?.[2]
        eq('and the prompt signal was aborted with the stream', promptSignal?.aborted, true)
        eq('and the stream left no event listeners behind', listenerCount(), beforeListeners)
        eq('and its heartbeat interval was cleared', intervals.created - intervals.cleared, 0)
      } finally {
        globalThis.setInterval = realSetInterval
        globalThis.clearInterval = realClearInterval
        promptScript = null
      }
    }
    // Control: a turn that ends on its own closes the response for a different reason, and that
    // must not be reported to the host as a cancellation.
    {
      const beforeCancel = cancelCalls.length
      const normal = await call('POST', '/say', 'finishes normally', {
        'content-type': 'text/plain', 'x-dsh-wsl-token': state.token, 'x-dsh-wsl-session': 'session-a',
      })
      eq('a normally finished turn is not cancelled', cancelCalls.length, beforeCancel)
      check('and it still reports its end frame', normal.body.includes('~e 1'), normal.body.slice(-90))
    }
    // A host whose controller has no `cancel` at all: the disconnect path must stay quiet (no
    // throw, no unhandled rejection), and the channel must keep serving the next turn.
    {
      promptScript = () => { /* leave this turn running */ }
      const savedCancel = services.sessionController.cancel
      delete services.sessionController.cancel
      const unhandled = []
      const onUnhandled = (reason) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        await disconnectSay('session-a')
        await tickMs(120)
        eq('a controller without cancel does not throw or leak', unhandled.length, 0)
        promptScript = null
        const after = await call('POST', '/say', 'still works', {
          'content-type': 'text/plain', 'x-dsh-wsl-token': state.token, 'x-dsh-wsl-session': 'session-a',
        })
        check('and the next turn still streams', after.body.includes('~e 1'), after.body.slice(-90))
      } finally {
        services.sessionController.cancel = savedCancel
        process.off('unhandledRejection', onUnhandled)
        promptScript = null
      }
    }

    // `dsh insert`: the supported way to put a message into a conversation without waiting for
    // its turn — including the conversation that is running this very command.
    const inserted = await call('POST', '/insert', 'note for later', {
      'content-type': 'text/plain',
      'x-dsh-wsl-token': state.token,
      'x-dsh-wsl-session': 'session-a',
    })
    eq('insert answers at once', inserted.status, 200)
    eq('insert reports where the prompt went', inserted.body.trim(), 'ok\tqueued\tsession-a')
    check('insert does not stream a turn', !inserted.body.includes('~ack'), inserted.body)
    eq('an idle conversation is queued',
      calls.filter((entry) => entry[0] === 'prompt').at(-1)?.[1]?.mode, 'queue')
    eq('the inserted text is marked like the terminal prompts',
      calls.filter((entry) => entry[0] === 'prompt').at(-1)?.[1]?.content?.[0]?.text, SAY_PREFIX + 'note for later')
    check('insert hands the controller a real AbortSignal',
      calls.filter((entry) => entry[0] === 'prompt').at(-1)?.[2] instanceof AbortSignal,
      String(calls.filter((entry) => entry[0] === 'prompt').at(-1)?.[2]))
    const selfInsert = await call('POST', '/insert', 'to the waiting one', {
      'content-type': 'text/plain',
      'x-dsh-wsl-token': state.token,
      'x-dsh-wsl-session': 'session-busy',
      'x-dsh-wsl-caller': 'session-busy',
    })
    eq('insert is allowed even when the caller IS the target (that is its purpose)', selfInsert.status, 200)
    eq('and steers into the live turn', selfInsert.body.trim(), 'ok\tinserted\tsession-busy')
    eq('the steered insert uses steer mode',
      calls.filter((entry) => entry[0] === 'prompt').at(-1)?.[1]?.mode, 'steer')
    const insertDenied = await call('POST', '/insert', 'x', { 'content-type': 'text/plain' })
    eq('insert requires the channel token too', insertDenied.status, 401)

    const listed = await call('POST', '/list', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    check('the list route returns tab-separated sessions',
      listed.body.includes('session-a\t') && listed.body.includes('title of session-a'), listed.body)
    check('the list route marks the current session', /wsl\t[^\n]*\t2\t\*/.test(listed.body), listed.body)
    // `dsh use X` switches the CLI; the marker must follow the header, not the panel value.
    const cliListed = await call('POST', '/list', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token, 'x-dsh-wsl-session': 'session-a' })
    const cliLines = cliListed.body.split('\n')
    check('the CLI current session is marked', cliLines.some((line) => line.startsWith('session-a\t') && line.endsWith('*')), cliListed.body)
    check('the panel landing is not marked when the CLI switched', !cliLines.some((line) => line.startsWith('wsl\t') && line.endsWith('*')), cliListed.body)

    // The wallet is read host-side with the account service's own client identity headers;
    // a signed-out or failed read is reported as such, never formatted as a zero balance.
    const wallet = await call('POST', '/balance', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('the balance route formats the wallet', wallet.body.trim(), 'ok\t余额 ¥12.50（赠金 ¥2.00）')
    check('it carries the client identity the account service expects',
      typeof balanceClients[0]?.version === 'string' && balanceClients[0].version !== ''
      && balanceClients[0]?.locale === 'zh-CN'
      && typeof balanceClients[0]?.timezoneOffsetSeconds === 'number',
      JSON.stringify(balanceClients[0]))
    balanceReply = null
    const signedOut = await call('POST', '/balance', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a signed-out account is reported, not shown as zero', signedOut.body.trim(), 'ok\t未登录')
    balanceReply = { status: 'failed' }
    const failedRead = await call('POST', '/balance', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a failed read is not a zero balance either', failedRead.body.trim(), 'ok\t暂不可用')
    balanceReply = { status: 'ready', value: [{ currency: 'USD', balance: '0.004' }], bonusWallets: [] }
    const subCent = await call('POST', '/balance', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a sub-cent balance reads as <0.01', subCent.body.trim(), 'ok\t余额 <$0.01')
    balanceReply = { status: 'ready', value: [{ currency: 'CNY', balance: '1.6' }], bonusWallets: [{ currency: 'CNY', balance: '0' }] }
    const spentBonus = await call('POST', '/balance', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a spent bonus wallet is not printed as a fraction of a cent', spentBonus.body.trim(), 'ok\t余额 ¥1.60')
    const balanceDenied = await call('POST', '/balance', '', { 'content-type': 'text/plain' })
    eq('the balance route needs the channel token', balanceDenied.status, 401)
    // An empty/unreadable wallet is "unavailable", never a zero balance — the one thing the
    // terminal line must not do is claim ¥0.00 for an account it could not read.
    balanceReply = { status: 'ready', value: [], bonusWallets: [] }
    const emptyWallet = await call('POST', '/balance', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('an empty wallet is unavailable, not zero', emptyWallet.body.trim(), 'ok\t暂不可用')
    balanceReply = { status: 'ready', value: [{ currency: 'CNY', balance: null }], bonusWallets: [] }
    const nullWallet = await call('POST', '/balance', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a null balance is unavailable too', nullWallet.body.trim(), 'ok\t暂不可用')
    balanceReply = { status: 'ready', value: [{ currency: 'CNY', balance: '0' }], bonusWallets: [] }
    const zeroWallet = await call('POST', '/balance', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a real zero balance is printed as zero', zeroWallet.body.trim(), 'ok\t余额 ¥0.00')

    // A signed-in account with a large history: the picker (and `dsh list`) stays within the
    // documented twelve-row cap, and the configured session stays visible even when it is not
    // among the newest rows.
    for (let index = 0; index < 20; index += 1) {
      sessions.set(`extra-${String(index)}`, { id: `extra-${String(index)}`, cwd: 'D:\\work', createdAt: 1_000 + index })
    }
    const many = await call('POST', '/list', '', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    const manyRows = many.body.split('\n').filter((line) => line.trim() !== '')
    check('the session list is capped at twelve rows', manyRows.length <= 12, String(manyRows.length))
    check('and the configured session stays visible under the cap',
      manyRows.some((line) => line.startsWith('wsl\t')), many.body.slice(0, 200))
    for (const id of [...sessions.keys()].filter((key) => String(key).startsWith('extra-'))) sessions.delete(id)

    // An id travels through the line protocol, the TSV list and the per-terminal current file:
    // control characters and whitespace would split all three, so they are refused up front.
    const badNew = await call('POST', '/new', 'a\tb', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a session id with a control character is refused', badNew.status, 400)
    const badRm = await call('POST', '/rm', 'a\tb', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('the archive route refuses it the same way', badRm.status, 400)

    const created = await call('POST', '/new', 'brand-new', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a new session is created', created.body.trim(), 'ok\tbrand-new')
    const createCall = calls.find((entry) => entry[0] === 'create')
    eq('the new session takes the newest session\'s directory', createCall?.[1]?.cwd, 'D:\\work')

    const openRm = await call('POST', '/rm', 'open-1', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a session open in DSH is not archived', openRm.status, 409)
    const closedRm = await call('POST', '/rm', 'session-a', { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token })
    eq('a closed session is archived', closedRm.body.trim(), 'ok\tsession-a')
    eq('the archive goes through the workspace controller',
      calls.filter((entry) => entry[0] === 'archive').length, 1)

    const installed = await channel.install()
    eq('install succeeds with a working wsl runner', installed.ok, true)
    const shim = readFileSync(join(dirname(channel.stateFile), 'dsh.sh'), 'utf8')
    check('the installed shim has its config path filled in',
      shim.includes('/mnt/') && !shim.includes('__CHANNEL_CONFIG__'), 'the placeholder survived')
    check('the installed shim points at the state file', shim.includes('/dsh-wsl/channel.json') && !shim.includes('.dsh/dsh-wsl/channel.json'), shim.slice(0, 400))
    check('the install command copies and marks the shim executable',
      (wslCalls[wslCalls.length - 1] ?? []).join(' ').includes('install -m 0755'), JSON.stringify(wslCalls[wslCalls.length - 1]))
    check('the installed shim forwards the caller session, so self-lock can be diagnosed',
      shim.includes('x-dsh-wsl-caller') && shim.includes('DSH_WSL_CALLER_SESSION'),
      shim.slice(-1200))
    // The old `dsh insert` and `dsh screen` commands are gone: the first is replaced by pressing
    // Enter while a turn streams (the same `/insert` route, driven by the terminal reader), and
    // the second was only ever for the model, which reads the terminal with its own tool.
    check('the user-facing CLI has no insert or screen command',
      !shim.includes('cmd_insert') && !shim.includes('cmd_screen')
      && !shim.includes('dsh insert "') && !shim.includes('dsh screen [-n'),
      shim.slice(0, 900))
    // A turn in flight holds the terminal, but not the person: one Enter holds the answer back
    // so the compose line is typed on a quiet terminal, the second delivers it as an insert.
    // Pipes and tool shells must never be read from, and the switch lets a person turn the
    // reader off.
    check('a running turn can be steered from the same terminal',
      shim.includes('回车暂停输出并插话') && shim.includes('start_steer_reader')
      && shim.includes('[ -t 0 ]') && /post insert "\$steer_text"/.test(shim)
      && shim.includes('DSH_WSL_NO_STEER'),
      shim.slice(shim.indexOf('start_steer_reader'), shim.indexOf('start_steer_reader') + 900))
    // The compose handshake: the reader owns the pause flag, the frame loop buffers only while
    // it exists, and every way out of the turn releases it so the held answer is never lost.
    check('a compose line holds the answer back and releases it on every exit',
      shim.includes('插入内容（回车发送；空行取消）') && shim.includes('已取消插入')
      && shim.includes('pause_flag') && shim.includes('pause_text+=')
      && shim.includes('resume_output')
      && /'~e '\*\)[\s\S]{0,400}resume_output/.test(shim)
      && /'err'\*\) stop_reason; resume_output/.test(shim),
      shim.slice(shim.indexOf('start_steer_reader'), shim.indexOf('start_steer_reader') + 2400))
    check('the steer reader is stopped on every exit path',
      /cleanup_say\(\)[\s\S]{0,160}stop_steer_reader/.test(shim) && shim.includes('已插入当前对话'),
      shim.slice(-1400))
    check('the installed shim resolves its transport once per channel start, not per command',
      shim.includes('TRANSPORT_FILE') && shim.includes('--connect-timeout 0.25'),
      shim.slice(0, 500))
    // The balance line changed: it is prefetched in the background with its own SHORT budget, it
    // is never retried, its temp file is removed on every path (success, failure, Ctrl-C), and the
    // end-of-turn arm prints it without holding the prompt open beyond ~0.6 s.
    check('the installed shim prefetches the balance with its own short budget',
      shim.includes('prefetch_balance')
      && /--max-time 3[^\n]*--data-raw ''[^\n]*\$BASE\/balance/.test(shim)
      && shim.slice(shim.indexOf("'~ack')")).includes('prefetch_balance'),
      shim.slice(-1600))
    check('the balance prefetch is never retried and is cleaned up on every exit path',
      !/prefetch_balance[\s\S]{0,300}--retry/.test(shim)
      && (shim.match(/rm -f "\$balance_file"/g) ?? []).length >= 2
      && /trap '[^']*cleanup_balance/.test(shim),
      shim.slice(-1600))
    check('the installed shim prints the balance after a finished turn',
      shim.slice(shim.indexOf("'~e '*)")).includes('report_balance')
      && shim.includes('账户余额'), shim.slice(-1600))
    check('the installed shim names a large landing conversation as the cost of a slow turn',
      shim.includes('等待模型') && shim.includes('上下文较大'), shim.slice(-900))
    check('the installed shim shows the thinking clock as minutes and seconds',
      shim.includes('分%02d秒') && shim.includes('思考中'), shim.slice(-900))
    // The clock/status contract the terminal reader depends on: a live thinking clock, an
    // honest summary when the text starts, a throttled step line, and a completion line that
    // formats minutes and seconds (and not a raw millisecond count).
    check('the shim owns the thinking clock and status-line words',
      shim.includes('⏱ 思考') && shim.includes('开始输出')
      && shim.includes('⏱ 已用') && shim.includes('第 %d 步'),
      shim.slice(-2000))
    check('the completion line formats minutes and seconds',
      shim.includes('分${sec}秒') && shim.includes('✓ 完成') && shim.includes('format_duration_ms'),
      shim.slice(-2000))
    // Zero-fork tick: bash's $EPOCHREALTIME plus a FIFO-held descriptor gives `read -t` something
    // to wait on, so a 0.2 s tick spawns neither `date` nor `sleep`. The millisecond `date` form
    // is what used to fork on every tick and froze the clock when the model started talking.
    check('the clock ticks without forking date or sleep per tick',
      shim.includes('EPOCHREALTIME') && shim.includes('read -r -t 0.2 -u 8')
      && shim.includes('mkfifo') && !shim.includes('date +%s%3N'),
      shim.slice(-2000))
    // A failed turn must wipe the live status line before printing its error, or the terminal is
    // left with a stale `… 思考中` prefix glued to the failure text.
    {
      const xArm = shim.slice(shim.indexOf("'~x '*"))
      const errArm = shim.slice(shim.indexOf("'err'*)"))
      check('a failed turn erases the live status line before it complains',
        shim.includes("printf '\\r\\033[2K'")
        && xArm.indexOf('stop_reason') >= 0 && xArm.indexOf('stop_reason') < xArm.indexOf('dsh: %s')
        && /^'err'\*\) stop_reason/.test(errArm),
        `${JSON.stringify(xArm.slice(0, 90))} | ${JSON.stringify(errArm.slice(0, 60))}`)
    }
    // Ctrl+C / SIGTERM in the terminal is its own outcome: the shim says the turn was stopped
    // (rather than "the connection dropped") and exits with the signal's conventional code. A
    // plain connection loss keeps its own wording, because that one is a different problem.
    {
      const interruptFn = shim.slice(shim.indexOf('on_interrupt()'))
      check('an interrupted terminal says the turn was stopped, not dropped',
        shim.includes('已在终端中断') && shim.includes('客户端本轮也已停止')
        && /trap 'on_interrupt 130' INT/.test(shim) && /trap 'on_interrupt 143' TERM/.test(shim),
        shim.slice(-1200))
      check('the interrupt path cleans up before it exits with the signal code',
        interruptFn.indexOf('stop_reason') >= 0
        && interruptFn.indexOf('stop_reason') < interruptFn.indexOf('已在终端中断')
        && interruptFn.includes('cleanup_balance') && /exit "\$1"/.test(interruptFn),
        interruptFn.slice(0, 260))
      check('a plain dropped connection keeps its own wording',
        shim.includes('连接在回合结束前断开'), shim.slice(-400))
    }

    const refuseInstall = await createChannel({ ctx, config: { channelEnabled: false } }).install()
    eq('install without a wsl runner is refused', refuseInstall.ok, false)

    // The terminal's own screen history travels with a terminal-sent prompt: a person typing at
    // a shell has context in front of them, and the client conversation is where the answer goes.
    // The transport is fixed at channel creation, so these scenarios use a second channel over a
    // fake transport; it shares the fake host services, so the prompt it produces lands in
    // `calls` like every other one.
    {
      const historyHome = mkdtempSync(join(tmpdir(), 'dsh-wsl-history-'))
      const historyBehavior = {
        screens: new Map(),
        userTerminalsError: null,
        followError: null,
        calls: { userTerminals: 0, follow: 0 },
      }
      const historyTransport = {
        async userTerminals() {
          historyBehavior.calls.userTerminals += 1
          if (historyBehavior.userTerminalsError !== null) throw historyBehavior.userTerminalsError
          return [...historyBehavior.screens.keys()].map((id) => ({ id, title: 'WSL' }))
        },
        follow(_agent, terminalId, _attachmentId, _signal) {
          historyBehavior.calls.follow += 1
          if (historyBehavior.followError !== null) throw historyBehavior.followError
          const screen = historyBehavior.screens.get(terminalId) ?? ''
          return (async function* historyFrames() {
            yield { type: 'snapshot', sequence: 0, screen }
          })()
        },
      }
      let historyNow = Date.now()
      const historyChannel = createChannel({
        ctx, config, wsl, transport: historyTransport, env: { USERPROFILE: historyHome }, now: () => historyNow,
      })
      const { port: historyPort } = await historyChannel.start()
      const sayOnHistory = (text, extraHeaders = {}) => new Promise((resolve, reject) => {
        const request = httpRequest({
          host: '127.0.0.1', port: historyPort, method: 'POST', path: '/say',
          headers: {
            'content-type': 'text/plain',
            'x-dsh-wsl-token': historyChannel.token,
            'x-dsh-wsl-session': 'history-session',
            ...extraHeaders,
          },
        }, (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        request.on('error', reject)
        request.write(text)
        request.end()
      })
      // The Enter-insert route a person uses mid-turn: same terminal, different route.
      const insertOnHistory = (text, extraHeaders = {}) => new Promise((resolve, reject) => {
        const request = httpRequest({
          host: '127.0.0.1', port: historyPort, method: 'POST', path: '/insert',
          headers: {
            'content-type': 'text/plain',
            'x-dsh-wsl-token': historyChannel.token,
            'x-dsh-wsl-session': 'history-session',
            ...extraHeaders,
          },
        }, (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        request.on('error', reject)
        request.write(text)
        request.end()
      })
      const lastPromptText = () => calls.filter((entry) => entry[0] === 'prompt').at(-1)?.[1]?.content?.[0]?.text ?? ''
      try {
        const message = '解释一下这个报错'
        const contextOf = () => historyChannel.terminalContextFor('history-session')
        const contextHeader = '【终端历史】以下是这个终端在我回复这条消息之前的屏幕内容（只读快照，最多 100 行；'
          + '如需更多可调用 wsl-term 的 read 动作，id=user-term）：\n'
        const expectedContext = (body) => `${contextHeader}${body}\n【终端历史结束】`
        const screen = [
          'xiny@XINY9:~$ git status --short',
          ' M lib/tools/wsl.js',
          'xiny@XINY9:~$ git log --oneline -3',
          'abc1234 fix: something',
          `xiny@XINY9:~$ dsh "${message}"`,
        ].join('\r\n')
        historyBehavior.screens.set('user-term', screen)
        const withContext = await sayOnHistory(message)
        const promptText = lastPromptText()
        // The conversation message is exactly what the person typed; the screen went to the
        // MODEL's hidden context instead.
        eq('the conversation message is exactly what the person typed',
          promptText, `${SAY_PREFIX}${message}`)
        check('the conversation carries no history text at all',
          !promptText.includes('【终端历史') && !promptText.includes('id=user-term')
          && !promptText.includes('git status --short'), promptText)
        const context = contextOf()
        check('the terminal screen is captured for the model context',
          context.includes('【终端历史】') && context.includes('【终端历史结束】'), context.slice(0, 160))
        check('the context carries the old commands and the terminal id',
          context.includes('git status --short') && context.includes('abc1234 fix: something')
          && context.includes('id=user-term') && context.includes('最多 100 行'), context.slice(0, 420))
        check('and the turn still completes', withContext.body.includes('~e 1'), withContext.body.slice(-90))

        // The assembly hook consumes it: a second request must not see the first message's screen.
        historyChannel.consumeTerminalContext('history-session')
        eq('consuming the context clears it', contextOf(), '')

        // Consecutive prompts replace the capture; they never stack two screens in one context.
        await sayOnHistory(message)
        const firstContext = contextOf()
        await sayOnHistory(message)
        const secondContext = contextOf()
        eq('a second prompt replaces the captured context', secondContext, firstContext)
        eq('and only one screen is held', (secondContext.match(/【终端历史】/g) ?? []).length, 1)

        // No transport at all (a build without one): exactly the old prompt shape.
        await call('POST', '/say', message, {
          'content-type': 'text/plain', 'x-dsh-wsl-token': state.token, 'x-dsh-wsl-session': 'history-session',
        })
        eq('without a transport the prompt is exactly the old shape', lastPromptText(), `${SAY_PREFIX}${message}`)

        // A screen that is missing the typed command (a different tab, a cleared screen).
        historyChannel.consumeTerminalContext('history-session')
        historyBehavior.screens.clear()
        historyBehavior.screens.set('user-term', 'xiny@XINY9:~$ ls -la\r\ntotal 0\r\n')
        await sayOnHistory(message)
        eq('a screen without the typed command adds no context', contextOf(), '')
        eq('and the prompt stays exactly the message', lastPromptText(), `${SAY_PREFIX}${message}`)

        // A failing terminal list / attach is silent context loss, never a failed prompt.
        historyChannel.consumeTerminalContext('history-session')
        historyBehavior.screens.clear()
        historyBehavior.screens.set('user-term', `xiny@XINY9:~$ dsh "${message}"`)
        historyBehavior.userTerminalsError = new Error('no page is polling')
        const failingList = await sayOnHistory(message)
        eq('a failing terminal list still sends the prompt unchanged', lastPromptText(), `${SAY_PREFIX}${message}`)
        eq('and captures no context', contextOf(), '')
        check('and the turn itself is unaffected', failingList.body.includes('~e 1'), failingList.body.slice(-90))
        historyBehavior.userTerminalsError = null
        historyBehavior.followError = new Error('the attach was refused')
        await sayOnHistory(message)
        eq('a failing attach still sends the prompt unchanged', lastPromptText(), `${SAY_PREFIX}${message}`)
        eq('and captures no context either', contextOf(), '')
        historyBehavior.followError = null

        // A tool-invoked prompt is not typed at a screen, so it never captures one.
        historyChannel.consumeTerminalContext('history-session')
        const readsBefore = historyBehavior.calls.userTerminals
        await sayOnHistory(message, { 'x-dsh-wsl-caller': 'session-other' })
        eq('a tool-invoked prompt keeps the plain message', lastPromptText(), `${SAY_PREFIX}${message}`)
        eq('and the transport is not consulted for it', historyBehavior.calls.userTerminals, readsBefore)
        eq('and no context is captured', contextOf(), '')

        // A long screen is bounded: the newest 100 lines, cut at the echoed command's line start.
        const longScreen = [
          ...Array.from({ length: 150 }, (_, index) => `out-${String(index + 1).padStart(3, '0')} ${'x'.repeat(20)}`),
          `xiny@XINY9:~$ dsh "${message}"`,
        ].join('\n')
        historyBehavior.screens.clear()
        historyBehavior.screens.set('user-term', longScreen)
        const longSay = await sayOnHistory(message)
        const longContext = contextOf()
        check('a 150-line screen keeps the newest 100 lines in the context',
          longContext.includes('out-150') && !longContext.includes('out-001'), longContext.slice(0, 200))
        eq('and exactly 100 screen lines travel',
          (longContext.match(/^out-\d{3} /gm) ?? []).length, 100)
        check('the echoed dsh command line is not part of the context',
          !longContext.includes('dsh "'), longContext.slice(-160))
        eq('while the prompt is still just the message', lastPromptText(), `${SAY_PREFIX}${message}`)
        check('and that turn still completes', longSay.body.includes('~e 1'), longSay.body.slice(-90))

        // The Enter-insert route is a person typing at the same terminal: it captures the screen
        // too, so a message typed mid-turn still reaches the model with its context.
        historyChannel.consumeTerminalContext('history-session')
        historyBehavior.screens.clear()
        historyBehavior.screens.set('user-term', [
          'xiny@XINY9:~$ git status --short',
          ' M lib/channel.js',
          '插入内容（回车发送；空行取消）：先改这个报错',
        ].join('\r\n'))
        const inserted = await insertOnHistory('先改这个报错')
        eq('insert still answers at once', inserted.status, 200)
        eq('and the inserted text stays the typed text', lastPromptText(), `${SAY_PREFIX}先改这个报错`)
        const insertContext = contextOf()
        check('an Enter-insert captures the screen as hidden context',
          insertContext.includes('【终端历史】') && insertContext.includes('git status --short')
          && !insertContext.includes('插入内容'), insertContext.slice(0, 260))
        eq('and the diagnostics name the insert route', historyChannel.historyState().route, 'insert')

        // Short prompts are the common case at a shell ("继续"), and they still capture: two
        // characters is enough to find the line the person typed.
        historyChannel.consumeTerminalContext('history-session')
        historyBehavior.screens.clear()
        historyBehavior.screens.set('user-term', [
          'xiny@XINY9:~$ git log --oneline -3',
          'abc1234 fix: something',
          '插入内容（回车发送；空行取消）：继续',
        ].join('\r\n'))
        await insertOnHistory('继续')
        check('a two-character insert still captures the screen',
          contextOf().includes('abc1234 fix: something'), contextOf().slice(0, 220))

        // A tool-invoked insert is not typed at a screen, so it captures nothing and does not
        // disturb the terminal the person is looking at.
        historyChannel.consumeTerminalContext('history-session')
        const listCallsBeforeToolInsert = historyBehavior.calls.userTerminals
        await insertOnHistory('工具插话', { 'x-dsh-wsl-caller': 'history-session' })
        eq('a tool-invoked insert captures no context', contextOf(), '')
        eq('and never asks the transport for a screen',
          historyBehavior.calls.userTerminals, listCallsBeforeToolInsert)

        // The panel can say which step said no: an attach failure and a screen without the
        // typed command are different problems and must read differently.
        historyBehavior.screens.set('user-term', `xiny@XINY9:~$ dsh "${message}"`)
        await sayOnHistory(message)
        const okState = historyChannel.historyState()
        eq('a capture is reported as ok', okState.reason, 'ok')
        eq('with the route that asked for it', okState.route, 'say')
        eq('and the terminal it came from', okState.terminalId, 'user-term')
        eq('and how many terminals it looked at', okState.candidates, 1)
        eq('a capture waits for the request that will use it', okState.pending, 1)
        check('and the counters move', okState.attempts >= okState.captured && okState.captured >= 1,
          JSON.stringify(okState))
        historyChannel.consumeTerminalContext('history-session')
        eq('consuming it leaves nothing pending', historyChannel.historyState().pending, 0)
        historyBehavior.followError = new Error('the attach was refused')
        await sayOnHistory(message)
        eq('a refused attach is named as one', historyChannel.historyState().reason, 'attach-failed')
        historyBehavior.followError = null
        historyBehavior.screens.set('user-term', 'xiny@XINY9:~$ ls -la\r\ntotal 0\r\n')
        await sayOnHistory(message)
        eq('a screen without the typed command is named as no match',
          historyChannel.historyState().reason, 'no-match')

        // The one-shot is advanced in TWO assemblies, not one: the agent loop assembles a step
        // and then refreshes the context right before the request. Dropping the entry on the
        // first assembly emptied the provider before the request that needed it (live bug,
        // 2026-10-25: capture ok, `pending` 0, no history in the request).
        historyChannel.consumeTerminalContext('history-session')
        historyBehavior.screens.set('user-term', `xiny@XINY9:~$ git status --short\r\ndsh "${message}"`)
        await sayOnHistory(message)
        eq('a fresh capture starts unserved', historyChannel.historyState().served, false)
        eq('the first assembly marks it served instead of dropping it',
          historyChannel.rotateTerminalContext('history-session'), false)
        const servedContext = contextOf()
        check('so the refresh that builds the request still carries it',
          servedContext.includes('git status --short'), servedContext.slice(0, 140))
        eq('the next assembly drops it', historyChannel.rotateTerminalContext('history-session'), true)
        eq('and later steps of the turn see no history', contextOf(), '')
        eq('rotating a session with no capture is a no-op',
          historyChannel.rotateTerminalContext('history-session'), false)

        // A captured screen expires: five minutes later it must not follow an unrelated request.
        historyNow += 5 * 60 * 1000 + 1
        eq('a captured screen expires after five minutes', contextOf(), '')
      } finally {
        await historyChannel.stop()
        try { rmSync(historyHome, { recursive: true, force: true }) } catch {}
      }
    }

    // The captured screen reaches the MODEL, not the transcript: `index.js` registers a hidden
    // `systemPrompt.context` that reads it for the calling session, plus an assembly hook that
    // consumes it once the request is built. This is the wiring check for that registration.
    {
      const empty = () => ({ readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) })
      const subprocess = {
        spawn() {
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            terminate() {},
            collected: { stdout: empty(), stderr: empty() },
          }
        },
        resolveExecutable: async (name) => `C:/Windows/System32/${name}`,
        async spawnTerminal() { return makeBridgePtyHandle() },
      }
      const makeHost = ({ withSystemPrompt = true, withContextOrder = true } = {}) => {
        const tools = {}
        const contexts = []
        const assembleHandlers = []
        const orderRequests = []
        const systemPrompt = {
          context(spec) { contexts.push(spec) },
          ...(withContextOrder ? { getContextOrder(name) { orderRequests.push(name); return 200 } } : {}),
        }
        const webServer = { register() { return () => {} } }
        const ctx = {
          tools: {
            register(tool) {
              tools[tool.name] = tool
              return () => { if (tools[tool.name] === tool) delete tools[tool.name] }
            },
          },
          subprocess,
          get(name) {
            if (name === 'systemPrompt' && withSystemPrompt) return systemPrompt
            if (name === 'subprocess') return subprocess
            return undefined
          },
          on(name, callback) {
            if (name === 'system-prompt/assemble') assembleHandlers.push(callback)
            return () => {}
          },
          inject(deps, callback) {
            const list = Array.isArray(deps) ? deps : []
            if (list.includes('systemPrompt')) {
              if (withSystemPrompt) callback({ systemPrompt })
              return
            }
            if (list.includes('webServer')) callback({ webServer, effect: () => () => {} })
          },
          effect() { return () => {} },
        }
        return { ctx, tools, contexts, assembleHandlers, orderRequests }
      }

      const host = makeHost()
      apply(host.ctx, {})
      eq('the plugin registers one hidden terminal-history context', host.contexts.length, 1)
      eq('it is named for this plugin', host.contexts[0]?.name, 'dsh-wsl:terminal-history')
      eq('it sits just after the harness-source context', host.contexts[0]?.order, 225)
      eq('and is not interpolated (terminal text is data)',
        host.contexts[0]?.interpolate, false)
      eq('with no captured screen its text is empty',
        host.contexts[0]?.text({ agent: { session: { id: 'no-context' } } }), '')
      eq('it asks the host where HARNESS_SOURCE sits', host.orderRequests[0], 'HARNESS_SOURCE')
      eq('the assembly hook is registered', host.assembleHandlers.length, 1)
      const assembled = await host.assembleHandlers[0](undefined, { agent: { session: { id: 'no-context' } } }, async () => 'assembled')
      eq('the assembly hook passes the assembly through', assembled, 'assembled')

      // A host whose systemPrompt has no ordering helper still gets the documented fallback.
      const plainHost = makeHost({ withContextOrder: false })
      apply(plainHost.ctx, {})
      eq('without a context order the fallback is 225', plainHost.contexts[0]?.order, 225)

      // And a host without `systemPrompt` at all must still mount.
      const bareHost = makeHost({ withSystemPrompt: false })
      let applyThrew = false
      try { apply(bareHost.ctx, {}) } catch { applyThrew = true }
      eq('a host without systemPrompt still mounts the plugin', applyThrew, false)
      eq('and registers no hidden context', bareHost.contexts.length, 0)
    }

    // Auto-installing the `dsh` shim: a missing or outdated file in the distro is repaired when
    // the channel comes up, without a panel click. Each scenario needs its own channel (the
    // throttle and the registered state live per instance) and its own fake `wsl`.
    {
      /** A fake `wsl.exe` runner that distinguishes the commands the channel issues. */
      const makeShimBox = () => {
        const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-autoshim-'))
        const calls = []
        const state = { installed: '', installCode: 0 }
        const wslFake = async (argv) => {
          calls.push(argv)
          const command = argv.join(' ')
          if (command.includes('cat "$HOME/.local/bin/dsh"')) {
            return { code: 0, stdout: state.installed, stderr: '' }
          }
          if (command.includes(' route ')) return { code: 0, stdout: '', stderr: '' }
          if (command.includes('install -m 0755')) {
            return state.installCode === 0
              ? { code: 0, stdout: '/home/xiny/.local/bin/dsh\n', stderr: '' }
              : { code: state.installCode, stdout: '', stderr: 'install failed' }
          }
          return { code: 0, stdout: '', stderr: '' }
        }
        return { home, calls, state, wslFake }
      }
      const openShimChannel = (box, overrides = {}) => createChannel({
        ctx,
        config: { channelEnabled: true, channelSession: 'wsl', autoInstallShim: true, ...overrides },
        wsl: box.wslFake,
        env: { USERPROFILE: box.home },
      })
      const shimCheckSeen = (box) => box.calls.some((argv) => argv.join(' ').includes('cat "$HOME/.local/bin/dsh"'))
      const installSeen = (box) => box.calls.some((argv) => argv.join(' ').includes('install -m 0755'))
      const waitFor = async (predicate, ms = 2_000) => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
          if (predicate()) return true
          await tickMs(10)
        }
        return predicate()
      }
      const cleanupShim = async (box, instance) => {
        try { await instance.stop() } catch { /* it may never have started */ }
        try { rmSync(box.home, { recursive: true, force: true }) } catch {}
      }

      // 1) missing -> installed, both when asked directly and from the channel's own start.
      {
        const box = makeShimBox()
        const auto = openShimChannel(box)
        try {
          const result = await auto.ensureShim()
          eq('a missing dsh shim is installed automatically', result.state, 'missing')
          eq('and the automatic result says it installed one', result.installed, true)
          check('the runner was asked to read the installed shim and then to install it',
            shimCheckSeen(box) && installSeen(box),
            JSON.stringify(box.calls.map((argv) => argv.join(' ').slice(0, 50))))
        } finally {
          await cleanupShim(box, auto)
        }
      }
      {
        const box = makeShimBox()
        const auto = openShimChannel(box)
        try {
          await auto.start()
          check('channel start heals a missing shim without a panel click',
            await waitFor(() => installSeen(box)),
            JSON.stringify(box.calls.map((argv) => argv.join(' ').slice(0, 50))))
        } finally {
          await cleanupShim(box, auto)
        }
      }

      // 2) stale -> replaced (the template changed since the last install).
      {
        const box = makeShimBox()
        box.state.installed = '#!/bin/bash\necho stale\n'
        const auto = openShimChannel(box)
        try {
          const result = await auto.ensureShim()
          eq('an outdated dsh shim is reported stale and replaced', result.state, 'stale')
          eq('and the replacement really installed', result.installed, true)
          check('the stale file was replaced', installSeen(box),
            JSON.stringify(box.calls.map((argv) => argv.join(' ').slice(0, 50))))
        } finally {
          await cleanupShim(box, auto)
        }
      }

      // 3) current -> nothing to do.
      {
        const box = makeShimBox()
        const first = openShimChannel(box)
        try {
          await first.install()
          const rendered = readFileSync(join(dirname(first.stateFile), 'dsh.sh'), 'utf8')
          await first.stop()
          box.state.installed = rendered
          box.calls.length = 0
          const current = openShimChannel(box)
          try {
            const result = await current.ensureShim()
            eq('a current shim is left alone', result.state, 'current')
            eq('and nothing was installed', result.installed, false)
            check('and no install command was issued', !installSeen(box),
              JSON.stringify(box.calls.map((argv) => argv.join(' ').slice(0, 50))))
          } finally {
            await current.stop()
          }
        } finally {
          try { await first.stop() } catch { /* already stopped */ }
          try { rmSync(box.home, { recursive: true, force: true }) } catch {}
        }
      }

      // 4) A failing install is a warning, never a thrown error.
      {
        const box = makeShimBox()
        box.state.installCode = 1
        const auto = openShimChannel(box)
        try {
          const result = await auto.ensureShim()
          eq('a failing shim install is reported instead of thrown', result.state, 'missing')
          eq('and the result says nothing was installed', result.installed, false)
          check('with the runner\'s reason attached', /install failed/.test(String(result.detail)),
            String(result.detail))
        } finally {
          await cleanupShim(box, auto)
        }
      }

      // 5) The switch off (or absent, which is how the old configs read) means no shim work at all.
      {
        const before = wslCalls.length
        const result = await channel.ensureShim()
        eq('auto-install is off when the switch is missing', result.state, 'disabled')
        eq('and nothing was installed', result.installed, false)
        eq('and no wsl command was run for the check', wslCalls.length - before, 0)
      }

      // 7) A disabled channel has nothing to install into.
      {
        const box = makeShimBox()
        const off = createChannel({
          ctx,
          config: { channelEnabled: false, autoInstallShim: true },
          wsl: box.wslFake,
          env: { USERPROFILE: box.home },
        })
        try {
          const result = await off.ensureShim()
          eq('a disabled channel skips the automatic shim work', result.state, 'skipped')
          eq('and runs no wsl command for it', box.calls.length, 0)
          check('and writes no shim file', !existsSync(join(dirname(off.stateFile), 'dsh.sh')))
        } finally {
          await cleanupShim(box, off)
        }
      }
    }

    // Ctrl+C then an immediate prompt: cancelling a turn is asynchronous, so the agent still
    // reports `running` while that turn tears down. Steering into it silently swallowed the new
    // prompt (the terminal showed `完成 0 步 in 0/out 0（aborted）`). The channel therefore queues
    // within a short window after a terminal cancel, and retries one rejected admission.
    {
      let fakeNow = 1_000_000
      const cancelHome = mkdtempSync(join(tmpdir(), 'dsh-wsl-cancel-'))
      const cancelChannel = createChannel({
        ctx, config, wsl, env: { USERPROFILE: cancelHome }, now: () => fakeNow,
      })
      const { port: cancelPort } = await cancelChannel.start()
      const promptCalls = () => calls.filter((entry) => entry[0] === 'prompt')
      const waitFor = async (predicate, ms = 2_000) => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
          if (predicate()) return true
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return predicate()
      }
      /** Start a /say and destroy its response once acknowledged: exactly a terminal Ctrl+C. */
      const cutSay = (target, text) => new Promise((resolve, reject) => {
        let destroyed = false
        const guard = setTimeout(() => reject(new Error('the /say stream never acknowledged')), 2_000)
        const request = httpRequest({
          host: '127.0.0.1', port: cancelPort, method: 'POST', path: '/say',
          headers: {
            'content-type': 'text/plain',
            'x-dsh-wsl-token': cancelChannel.token,
            'x-dsh-wsl-session': target,
          },
        }, (response) => {
          let buffer = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            buffer += chunk
            if (destroyed || !buffer.includes('~ack')) return
            destroyed = true
            clearTimeout(guard)
            response.destroy()
            resolve()
          })
          response.on('error', () => {})
        })
        request.on('error', () => {})
        request.write(text)
        request.end()
      })
      const sayOnCancel = (target, text) => new Promise((resolve, reject) => {
        const request = httpRequest({
          host: '127.0.0.1', port: cancelPort, method: 'POST', path: '/say',
          headers: {
            'content-type': 'text/plain',
            'x-dsh-wsl-token': cancelChannel.token,
            'x-dsh-wsl-session': target,
          },
        }, (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        request.on('error', reject)
        request.write(text)
        request.end()
      })
      try {
        const cancelledBefore = cancelCalls.length
        await cutSay('session-cancel', 'first turn')
        check('the Ctrl+C really asked the host to cancel',
          await waitFor(() => cancelCalls.length > cancelledBefore),
          JSON.stringify(cancelCalls.slice(cancelledBefore)))
        // Let the cut stream finish its own bookkeeping (prompt admission, cleanup) so the next
        // request is not answered 409 by a stream that is still on its way out.
        await new Promise((resolve) => setTimeout(resolve, 100))
        eq('and the fake agent still reports the cancelled turn running',
          services.agents.get('session-cancel').status, 'running')
        const beforeQueued = promptCalls().length
        const queued = await sayOnCancel('session-cancel', 'right after ctrl-c')
        const queuedCalls = promptCalls().slice(beforeQueued)
        eq('the queued prompt was admitted once', queuedCalls.length, 1)
        eq('a prompt right after Ctrl+C is queued, not steered',
          queuedCalls[0]?.[1]?.mode, 'queue')
        eq('and that turn streams normally', queued.status, 200)

        // A rejected admission inside the window is retried once, as a queue turn.
        rejectNextPrompt = new Error('the cancelled turn is still finishing')
        const beforeRetry = promptCalls().length
        const retried = await sayOnCancel('session-cancel', 'retry me')
        const retryCalls = promptCalls().slice(beforeRetry)
        eq('a rejected admission inside the window is admitted again', retryCalls.length, 2)
        eq('the retry uses queue mode', retryCalls[1]?.[1]?.mode, 'queue')
        check('and it is a new request',
          retryCalls[0]?.[1]?.requestId !== retryCalls[1]?.[1]?.requestId,
          `${String(retryCalls[0]?.[1]?.requestId)} vs ${String(retryCalls[1]?.[1]?.requestId)}`)
        check('and the terminal marker survives the retry',
          String(retryCalls[1]?.[1]?.content?.[0]?.text ?? '').startsWith(SAY_PREFIX),
          String(retryCalls[1]?.[1]?.content?.[0]?.text))
        check('the retried turn streams', String(retried.body).includes('~e 1'), String(retried.body).slice(-80))

        // If the caller is already gone (aborted), a rejected admission is NOT retried.
        deferNextPrompt = {}
        const deferred = deferNextPrompt
        const beforeAbort = promptCalls().length
        const abortedRequest = httpRequest({
          host: '127.0.0.1', port: cancelPort, method: 'POST', path: '/say',
          headers: {
            'content-type': 'text/plain',
            'x-dsh-wsl-token': cancelChannel.token,
            'x-dsh-wsl-session': 'session-cancel',
          },
        }, (response) => {
          response.setEncoding('utf8')
          response.on('data', () => {})
          response.on('error', () => {})
        })
        abortedRequest.on('error', () => {})
        abortedRequest.write('abort me')
        abortedRequest.end()
        check('the admission really started', await waitFor(() => promptCalls().length > beforeAbort))
        abortedRequest.destroy()
        await new Promise((resolve) => setTimeout(resolve, 20))
        deferred.reject(new Error('admission aborted'))
        await new Promise((resolve) => setTimeout(resolve, 700))
        eq('an aborted request does not retry the admission', promptCalls().length - beforeAbort, 1)

        // The window is PER SESSION: another conversation still steers while it is running.
        await sayOnCancel('session-busy', 'other conversation')
        eq('the cancel window does not demote another conversation to queue',
          promptCalls().at(-1)?.[1]?.mode, 'steer')

        // And after the window the cancelled conversation steers again.
        fakeNow += 4_000
        await sayOnCancel('session-cancel', 'later prompt')
        eq('after the settle window a running conversation steers again',
          promptCalls().at(-1)?.[1]?.mode, 'steer')
      } finally {
        rejectNextPrompt = null
        deferNextPrompt = null
        await cancelChannel.stop()
        try { rmSync(cancelHome, { recursive: true, force: true }) } catch {}
      }
    }

    // Last, because it tears the channel down: a plugin unmount / hot reload destroys in-flight
    // streams, but that is NOT a Ctrl+C — cancelling there would kill a turn the user is still
    // watching in the client. (The `finally` below stops the already-stopped channel; that is a
    // no-op by design.)
    {
      promptScript = () => { /* leave the turn open */ }
      const beforeCancel = cancelCalls.length
      await new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('the in-flight /say was never acknowledged')), 2_000)
        if (typeof guard.unref === 'function') guard.unref()
        const request = httpRequest({
          host: '127.0.0.1', port, method: 'POST', path: '/say',
          headers: { 'content-type': 'text/plain', 'x-dsh-wsl-token': state.token, 'x-dsh-wsl-session': 'session-a' },
        }, (response) => {
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            if (!String(chunk).includes('~ack')) return
            clearTimeout(guard)
            resolve()
          })
          response.on('error', () => {})
        })
        request.on('error', () => {})
        request.write('in flight')
        request.end()
      })
      await channel.stop()
      await tickMs(120)
      eq('a channel teardown does not cancel the running turn', cancelCalls.length, beforeCancel)
      promptScript = null
    }
  } finally {
    await channel.stop()
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }

  // What the picker (and `dsh list`) is allowed to show: top-level, unarchived, titled
  // conversations, newest first, plus the configured session even while it has no title.
  const registryForPicker = {
    archivedSessionIds: ['archived-1'],
    list: () => [{ title: '工作区', path: 'D:\\w', sessionIds: ['session-a', 'untitled-1', 'archived-1', 'sub-1', 'wsl'] }],
  }
  const queryForPicker = {
    async listSessions() {
      return [
        { header: { id: 'session-a', cwd: 'D:\\w', createdAt: 5 } },
        { header: { id: 'untitled-1', cwd: 'D:\\w', createdAt: 4 } },
        { header: { id: 'archived-1', cwd: 'D:\\w', createdAt: 3 } },
        { header: { id: 'sub-1', cwd: 'D:\\w', createdAt: 2, parentSession: 'session-a' } },
        { header: { id: 'wsl', cwd: 'D:\\w', createdAt: 1 } },
      ]
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => (id === 'session-a'
        ? { status: 'fulfilled', value: { session: { id }, title: '真正的会话' } }
        : { status: 'rejected', reason: new Error('no title') }))
    },
  }
  const filterCtx = {
    get(name) { return { sessionQuery: queryForPicker, workspaceRegistry: registryForPicker }[name] },
    on() { return () => {} },
  }
  const filtered = createChannel({ ctx: filterCtx, config: { channelEnabled: true, channelSession: 'wsl' }, env: { USERPROFILE: home } })
  const filteredPort = (await filtered.start()).port
  try {
    const listed = await new Promise((done, fail) => {
      const request = httpRequest({ host: '127.0.0.1', port: filteredPort, method: 'POST', path: '/list', headers: { 'content-type': 'text/plain', 'x-dsh-wsl-token': filtered.token } }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
      })
      request.on('error', fail)
      request.end()
    })
    check('the list shows a real conversation by its title', listed.includes('真正的会话') && listed.includes('session-a'), listed)
    check('sessions without a title are still listed', listed.includes('untitled-1'), listed)
    check('archived sessions stay out of the list', !listed.includes('archived-1'), listed)
    check('forked or subagent sessions stay out of the list', !listed.includes('sub-1'), listed)
    check('the configured session is marked in the list', /wsl\t[^\n]*\t\*/.test(listed), listed)
  } finally {
    await filtered.stop()
  }
  // The picker order must match the sidebar: the client controller lists by last activity
  // (updatedAt = max(createdAt, lastPromptAt)), so an old session used recently comes first.
  const orderedList = [
    { sessionId: 'session-new-but-cold', updatedAt: 500, cwd: 'D:\\w', projections: { values: { title: '新建但没再用' } } },
    { sessionId: 'session-old-used-now', updatedAt: 900, cwd: 'D:\\w', projections: { values: { title: '老会话刚用过' } } },
    { sessionId: 'session-sub', updatedAt: 950, parentSessionId: 'session-old-used-now', cwd: 'D:\\w' },
  ]
  const orderedCtx = {
    get(name) {
      return {
        sessionController: { async list() { return { items: orderedList } } },
        workspaceRegistry: { archivedSessionIds: [], list: () => [{ title: 'w', path: 'D:\\w', sessionIds: orderedList.map((item) => item.sessionId) }] },
      }[name]
    },
    on() { return () => {} },
  }
  const ordered = createChannel({ ctx: orderedCtx, config: { channelEnabled: true, channelSession: 'session-old-used-now' }, env: { USERPROFILE: home } })
  const orderedPort = (await ordered.start()).port
  try {
    const listed = await new Promise((done, fail) => {
      const request = httpRequest({ host: '127.0.0.1', port: orderedPort, method: 'POST', path: '/list', headers: { 'content-type': 'text/plain', 'x-dsh-wsl-token': ordered.token } }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
      })
      request.on('error', fail)
      request.end()
    })
    const lines = listed.split(/\r?\n/).filter((line) => line.includes('session-'))
    check('the picker orders like the sidebar: last activity first', lines[0]?.includes('session-old-used-now') === true, listed)
    check('and marks the current session', lines[0]?.split('\t').at(-1) === '*', listed)
    check('a subagent row never joins the picker', !listed.includes('session-sub'), listed)
    check('the title comes from the projection', listed.includes('老会话刚用过'), listed)
  } finally {
    await ordered.stop()
  }
  // A disabled channel answers, but refuses the turn; and a host without the session
  // controller reports that in words instead of throwing.
  const off = createChannel({ ctx, config: { channelEnabled: false }, env: { USERPROFILE: home } })
  const offPort = (await off.start()).port
  try {
    const disabled = await new Promise((done, fail) => {
      const request = httpRequest({ host: '127.0.0.1', port: offPort, method: 'POST', path: '/say', headers: { 'content-type': 'text/plain', 'x-dsh-wsl-token': off.token } }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      request.on('error', fail)
      request.write('hi')
      request.end()
    })
    eq('a disabled channel refuses the turn', disabled.status, 409)
  } finally {
    await off.stop()
  }
  const bare = createChannel({ ctx: { get: () => undefined, on: () => () => {} }, config: { channelEnabled: true }, env: { USERPROFILE: home } })
  const barePort = (await bare.start()).port
  try {
    const refused = await new Promise((done, fail) => {
      const request = httpRequest({ host: '127.0.0.1', port: barePort, method: 'POST', path: '/say', headers: { 'content-type': 'text/plain', 'x-dsh-wsl-token': bare.token } }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      request.on('error', fail)
      request.write('hi')
      request.end()
    })
    eq('a host without the session controller refuses in words', refused.status, 501)
    check('the refusal names what is missing', refused.body.includes('sessionController'), refused.body)
  } finally {
    await bare.stop()
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
}

// --- main ------------------------------------------------------------------

const modulesRoot = process.env.DSH_SUBPROCESS_LOCAL
const useReal = process.argv.includes('--real')
if (useReal && (modulesRoot === undefined || modulesRoot === '')) {
  console.log('skipped: --real needs DSH_SUBPROCESS_LOCAL pointing at a node_modules directory with @deepseek-ai/*')
  process.exit(0)
}

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-wsl-test-'))
const shim = useReal ? await makeRealBackend(modulesRoot) : makeShim(spillDir)
const jobs = makeJobs()
console.log(`backend: ${useReal ? `real DSH provider (${modulesRoot})` : 'local shim'}`)
try {
  // The diagnostics tool is opt-in, so the CONTROL mount asks for it explicitly (the tests
  // below exercise it); the default mount is checked without it.
  const tools = makeCtx(shim, { jobs, settings: { tools: { doctor: true } } })
  const defaultMount = makeCtx(shim, { jobs })
  check('the default mount registers the file tools, the read-only tools and the terminal tool, not the opt-in ones',
    Object.keys(defaultMount).sort().join(',') === 'wsl,wsl-edit,wsl-env,wsl-grep,wsl-path,wsl-read,wsl-term,wsl-write', Object.keys(defaultMount).join(','))
  await unitTests()
  await hunkUnitTests()
  await terminalUnitTests()
  await bridgeUnitTests()
  await lazyTransportTests()
  await channelUnitTests()
  await toolTests(tools, shim)
} finally {
  try { rmSync(spillDir, { recursive: true, force: true }) } catch {}
}

// The documented counts are hand-written, and they drifted on almost every commit while the
// terminal feature landed. The suite knows its own total, so it checks the docs instead of
// trusting them. Compared AFTER the totals are final, so it does not change the number it
// is checking, and it fails the run without pretending to be one more check.
{
  const total = passed + failures.length
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const documented = []
  for (const doc of ['README.md', 'README.zh-CN.md', 'SUPPORT.md']) {
    const text = readFileSync(join(repoRoot, doc), 'utf8')
    if (!text.includes(`${total} host checks`) && !text.includes(`${total} 项宿主检查`)) documented.push(doc)
  }
  if (documented.length > 0) {
    console.log(`\nthe docs do not document the ${total} host checks this run executed: ${documented.join(', ')}`)
    process.exitCode = 1
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(` - ${failure}`)
  process.exitCode = 1
}
