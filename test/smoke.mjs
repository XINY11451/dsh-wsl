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
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply } from '../index.js'
import { resolveConfig } from '../lib/config.js'
import { buildCdCommand, quotePath, shellQuote, windowsPathToWsl } from '../lib/paths.js'
import { destructiveReason } from '../lib/guard.js'
import { cleanStderr, formatResult, normalizeExitCode, streamFacts } from '../lib/result.js'
import { assertLauncherReachable, resolveDistro } from '../lib/runner.js'
import { capabilityLines, launcherSummary, parseFacts, workspaceLine } from '../lib/diagnostics.js'
import { parseDefaultDistro } from '../lib/tools/wsl-env.js'

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

function makeCtx(shim, { jobs } = {}) {
  const tools = {}
  const ctx = {
    tools: { register(tool) { tools[tool.name] = tool } },
    subprocess: shim,
    // Optional service: the plugin must also work when this returns undefined.
    get: (name) => (name === 'jobs' ? jobs : undefined),
  }
  apply(ctx)
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
  eq('the default workdir is the Linux home', resolveConfig({}).defaultWorkdir, '~')
  eq('workdir "home" spells the tilde', resolveConfig({ DSH_WSL_WORKDIR: 'home' }).defaultWorkdir, '~')
  eq('workdir "session" means the process cwd', resolveConfig({ DSH_WSL_WORKDIR: 'session' }).defaultWorkdir, null)
  eq('any other workdir is an explicit default path',
    resolveConfig({ DSH_WSL_WORKDIR: 'D:\\proj' }).defaultWorkdir, 'D:\\proj')

  // A per-call deadline is capped like the platform shell tools cap theirs.
  eq('the timeout ceiling has a default', resolveConfig({}).maxCommandTimeoutMs, 86_400_000)
  eq('DSH_WSL_MAX_TIMEOUT_MS overrides the ceiling', resolveConfig({ DSH_WSL_MAX_TIMEOUT_MS: '60000' }).maxCommandTimeoutMs, 60_000)
  eq('a silly ceiling falls back', resolveConfig({ DSH_WSL_MAX_TIMEOUT_MS: '0' }).maxCommandTimeoutMs, 86_400_000)
  eq('the default deadline obeys the ceiling',
    resolveConfig({ DSH_WSL_TIMEOUT_MS: '90000000', DSH_WSL_MAX_TIMEOUT_MS: '60000' }).commandTimeoutMs, 60_000)

  // Host shell facts reach the Linux side, because WSL drops Windows env vars.
  const forwards = resolveConfig({
    DSH_SESSION_ID: 'session-abc', DSH_SHELL: '1', DSH_HOME: 'C:\\Users\\me\\.dsh', DSH_WEB_URL: 'http://127.0.0.1:3080',
  }).forwardEnv
  eq('the session id is forwarded', forwards.DSH_SESSION_ID, 'session-abc')
  eq('DSH_SHELL is forwarded', forwards.DSH_SHELL, '1')
  eq('DSH_HOME is forwarded as its /mnt view', forwards.DSH_HOME, '/mnt/c/Users/me/.dsh')
  check('DSH_WEB_URL is NOT forwarded (unreachable from WSL in NAT mode)',
    !('DSH_WEB_URL' in forwards), JSON.stringify(forwards))
  eq('an absent host variable is not invented', 'DSH_SESSION_ID' in resolveConfig({}).forwardEnv, false)
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
  const previousSessionId = process.env.DSH_SESSION_ID
  process.env.DSH_SESSION_ID = 'session-smoke-test'
  try {
    // `apply()` reads the environment at mount — exactly what a restart does.
    const forwardingTools = makeCtx(shim, { jobs })
    const seen = await forwardingTools.wsl.execute({ command: 'printenv DSH_SESSION_ID', description: 'forwarded env' })
    eq('the host session id reaches the Linux side', seen.stdout.trim(), 'session-smoke-test')
    const overridden = await forwardingTools.wsl.execute({
      command: 'printenv DSH_SESSION_ID', description: 'explicit wins', env: { DSH_SESSION_ID: 'explicit-wins' },
    })
    eq('an explicit env entry overrides the forwarded one', overridden.stdout.trim(), 'explicit-wins')
  } finally {
    if (previousSessionId === undefined) delete process.env.DSH_SESSION_ID
    else process.env.DSH_SESSION_ID = previousSessionId
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
    const sessionPwd = await sessionTools.wsl.execute({ command: 'pwd', description: 'session cwd' })
    eq('the default workdir follows the session cwd', sessionPwd.stdout.trim(), windowsPathToWsl(process.cwd()))
    const overridden = await sessionTools.wsl.execute({ command: 'pwd', description: 'explicit wins', workdir: '~/.' })
    eq('an explicit workdir still wins', overridden.stdout.trim(), '/home/xiny')
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
