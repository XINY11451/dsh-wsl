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
import {
  appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply } from '../index.js'
import { resolveConfig } from '../lib/config.js'
import { pickSchemaBuilder } from '../lib/schema.js'
import { buildCdCommand, quotePath, shellQuote, windowsPathToWsl } from '../lib/paths.js'
import { destructiveReason } from '../lib/guard.js'
import { cleanStderr, formatResult, normalizeExitCode, streamFacts } from '../lib/result.js'
import { assertLauncherReachable, collectForwardEnv, resolveDistro, sessionCwdOf } from '../lib/runner.js'
import { capabilityLines, launcherSummary, parseFacts, workspaceLine } from '../lib/diagnostics.js'
import { parseDefaultDistro } from '../lib/tools/wsl-env.js'
import {
  parseFlowSequence, readTerminalCwd, reviewTerminalWrite, splitPatchLines, validateTerminalCwd,
  verifyTerminalRewrite, writeTerminalCwd,
} from '../lib/terminal-cwd.js'

// One resolved configuration stands in for the mount the host would create.
const CONFIG = resolveConfig({})
const MAX_OUT = CONFIG.maxOutputBytes
const render = (value) => formatResult(value, MAX_OUT)

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

function makeCtx(shim, { jobs, shellEnv, settings, profileContext } = {}) {
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
    tools: { register(tool) { tools[tool.name] = tool } },
    subprocess: shim,
    // Optional services: the plugin must work when these return undefined.
    get: (name) => (name === 'jobs' ? jobs
      : name === 'shellEnv' ? shellEnv
        : name === 'profileContext' ? profileContext
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
  check('a lost line is caught',
    /行数/.test(String(verifyTerminalRewrite(before, set.text.replace('\n', ''), '/mnt/d/project'))))
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
    }
  }

  console.log('\ndestructive guard')
  const bad = destructiveReason
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
  ]) {
    check(`refuses ${JSON.stringify(command)}`, bad(command) !== null)
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
  eq('a non-boolean switch falls back instead of failing the mount',
    resolveConfig({}, { backgroundJobs: 'no' }).backgroundJobs, true)
  eq('the tool switches default to all three on',
    Object.values(resolveConfig({}, {}).tools).join(','), 'true,true,true')
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
}

// --- tool-level tests ------------------------------------------------------

async function toolTests(tools, shim) {
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
  await rejects('zero timeout is refused', () => tools.wsl.execute({ command: 'true', description: 'x', timeoutMs: 0 }), /positive number/)

  console.log('\nwsl: workdir')
  const tilde = await tools.wsl.execute({ command: 'pwd', description: 'home', workdir: '~/.' })
  eq('tilde workdir resolves', tilde.stdout.trim(), '/home/xiny')
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

  const wslOnlyTools = makeCtx(shim, { settings: { tools: { wsl: true, path: false, env: false } } })
  eq('a tool switch removes exactly that tool', Object.keys(wslOnlyTools).sort().join(','), 'wsl')
  const allOffTools = makeCtx(shim, { settings: { tools: { wsl: false, path: false, env: false } } })
  eq('all three switches off register nothing', Object.keys(allOffTools).length, 0)
  eq('the control mount registers all three', Object.keys(tools).sort().join(','), 'wsl,wsl-env,wsl-path')

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

  // The panel's 「复制插件信息」 gets the version from here, so a release never has to
  // edit a string in the client half: the Host half reads its own manifest.
  console.log('\nself-info route')
  eq('the plugin publishes exactly its two routes', tools.routes.length, 2)
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
  await tools.wsl.execute({ command: 'true', description: 'pinned', distro: 'Ubuntu-22.04' })
  const pinnedArgv = shim.calls.at(-1).argv
  eq('an explicit distro passes -d', pinnedArgv.slice(0, 4).join(' '), 'wsl.exe -d Ubuntu-22.04 -e')

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
  for (const [name, tool] of Object.entries(tools)) {
    const view = tool.presentCall({ command: 'echo hi', description: 'label', path: '/tmp', workdir: 'C:\\tmp' })
    check(`${name}: declares a card the UI knows`, ['generic', 'terminal', 'diff'].includes(view?.card), String(view?.card))
    check(`${name}: the card carries a title`, typeof view?.title === 'string' && view.title.length > 0, JSON.stringify(view?.title))
    const allowed = view?.card === 'terminal' ? TERMINAL_FIELDS : GENERIC_FIELDS
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
      eq('an explicit workdir still wins', overridden.stdout.trim(), '/home/xiny')
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
  check('the job output holds the command output', (settled.outcome.output ?? '').includes('from-the-job'), JSON.stringify(settled.outcome.output))
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

  const stderrJob = await tools.wsl.execute({
    command: 'echo oops 1>&2; exit 1', description: 'background stderr', runInBackground: true,
  })
  const stderrSettled = await jobs.settled(stderrJob.jobId)
  check('stderr is kept in the job output', (stderrSettled.outcome.output ?? '').includes('oops'), JSON.stringify(stderrSettled.outcome.output))

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
    !/\[exit code:/.test(cancelled.outcome.output ?? ''), JSON.stringify(cancelled.outcome.output))

  const timedJob = await tools.wsl.execute({
    command: 'sleep 5', description: 'background timeout', runInBackground: true, timeoutMs: 700,
  })
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

  console.log('\nwsl-path')
  const toLinux = await tools['wsl-path'].execute({ path: 'C:\\Program Files\\Git' })
  eq('windows -> linux', toLinux.converted, '/mnt/c/Program Files/Git')
  const toWindows = await tools['wsl-path'].execute({ path: '/home/xiny' })
  check('linux -> windows', /Ubuntu-22\.04/.test(toWindows.converted) && /home/.test(toWindows.converted), toWindows.converted)
  const forced = await tools['wsl-path'].execute({ path: '/tmp', direction: 'win' })
  check('forced direction', /tmp/.test(forced.converted), forced.converted)
  const tildePath = await tools['wsl-path'].execute({ path: '~' })
  check('tilde path is expanded before conversion', tildePath.converted !== '~' && /home/.test(tildePath.converted), tildePath.converted)
  await rejects('empty path is refused', () => tools['wsl-path'].execute({ path: '  ' }), /non-empty string/)

  console.log('\nwsl-env')
  const env = await tools['wsl-env'].execute({})
  check('reports the distro', env.summary.includes('distro: Ubuntu-22.04'), env.summary)
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

  // The model pays for description + parameters in EVERY request, so the budget
  // is a real limit. It is asserted, not aspirational: a future edit that
  // re-bloats the catalog fails here instead of quietly costing tokens forever.
  // The numbers are a ratchet just above today's size, not a target.
  console.log('\nmodel-facing catalog budget')
  let catalog = 0
  for (const [name, tool] of Object.entries(tools)) {
    const cost = tool.description.length + JSON.stringify(tool.parameters).length
    catalog += cost
    check(`${name}: catalog cost within budget`, cost <= 2_500, `${cost} chars (description ${tool.description.length} + parameters ${JSON.stringify(tool.parameters).length})`)
  }
  check('total catalog cost within budget', catalog <= 3_800, `${catalog} chars (~${Math.round(catalog / 4)} tokens)`)

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


  // The optional half: it must address a real composed row by id, must not switch
  // that row off (that would take the terminal feature away rather than adjust it),
  // and must point at a shell that exists.
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
  const tools = makeCtx(shim, { jobs })
  check('three tools are registered', Object.keys(tools).sort().join(',') === 'wsl,wsl-env,wsl-path', Object.keys(tools).join(','))
  await unitTests()
  await toolTests(tools, shim)
} finally {
  try { rmSync(spillDir, { recursive: true, force: true }) } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(` - ${failure}`)
  process.exitCode = 1
}
