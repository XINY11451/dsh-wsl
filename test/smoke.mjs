// Regression suite for dsh-wsl.
//
//   node test/smoke.mjs
//
// The plugin is exercised through its real entry points (`apply` -> the three
// tool objects), against the real WSL installation. Only `ctx.subprocess` is
// substituted, by a shim that reimplements the DSH seam faithfully enough to
// matter: bounded in-memory TAIL windows, a full-stream spill file, abort ->
// SIGTERM -> grace -> SIGKILL, and an `exit`/`close` split so a survivor on the
// other side of wsl.exe cannot hold `done` open forever.

import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, __internals } from '../index.js'

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

      if (spec.signal) {
        spec.signal.addEventListener('abort', () => {
          child.kill('SIGTERM')
          setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, spec.graceMs).unref?.()
        }, { once: true })
      }

      return { done, collected: { stdout, stderr } }
    },
  }
}

// node:fs helpers kept out of the collector closure for readability.
function statSafe(path) {
  try { return statSync(path).size } catch { return -1 }
}

function makeCtx(shim) {
  const tools = {}
  const ctx = {
    tools: { register(tool) { tools[tool.name] = tool } },
    subprocess: shim,
  }
  apply(ctx)
  return tools
}

// --- pure helpers ----------------------------------------------------------

async function unitTests() {
  console.log('\npath translation')
  const t = __internals.windowsPathToWsl
  eq('simple drive path', t('C:\\Users\\me\\a.txt'), '/mnt/c/Users/me/a.txt')
  eq('backslashes with a space', t('C:\\Program Files\\Git\\cmd'), '/mnt/c/Program Files/Git/cmd')
  eq('trailing segment after a space', t('C:\\Program Files'), '/mnt/c/Program Files')
  eq('space in a middle segment', t('C:\\Users\\35280\\My Documents'), '/mnt/c/Users/35280/My Documents')
  eq('forward slashes with a space', t('C:/Program Files/Git'), '/mnt/c/Program Files/Git')
  eq('lowercase drive, backslash', t('d:\\stuff'), '/mnt/d/stuff')
  eq('duplicated separator collapses', t('C:\\\\foo'), '/mnt/c/foo')
  eq('two paths in one command', t('ls C:\\a && ls D:\\b'), 'ls /mnt/c/a && ls /mnt/d/b')
  eq('stops before a shell operator', t('ls C:\\a && echo hi'), 'ls /mnt/c/a && echo hi')
  eq('URL is untouched', t('curl https://example.com/x'), 'curl https://example.com/x')
  eq('lowercase letter-slash is untouched', t("echo 'a:/b'"), "echo 'a:/b'")
  eq('quoted windows path', t('cat "C:\\Program Files\\a b.txt"'), 'cat "/mnt/c/Program Files/a b.txt"')
  eq('UNC wsl.localhost', t('ls \\\\wsl.localhost\\Ubuntu-22.04\\home\\xiny'), 'ls /home/xiny')
  eq('UNC wsl$', t('ls \\\\wsl$\\Ubuntu-22.04\\home'), 'ls /home')
  eq('bare UNC distro root', t('ls \\\\wsl.localhost\\Ubuntu-22.04'), 'ls /')
  eq('plain linux path untouched', t('/mnt/c/Users'), '/mnt/c/Users')

  console.log('\nworkdir quoting')
  const cd = __internals.buildCdCommand
  eq('bare tilde stays expandable', cd('~'), 'cd ~')
  eq('tilde with a space is split', cd('~/my dir'), "cd ~/'my dir'")
  eq('tilde with a plain subdir', cd('~/src'), "cd ~/'src'")
  eq('named tilde', cd('~user/x'), "cd ~user/'x'")
  eq('absolute path is quoted whole', cd('/mnt/c/Program Files'), "cd '/mnt/c/Program Files'")
  eq('single quote is escaped', cd("/tmp/it's here"), "cd '/tmp/it'\\''s here'")
  eq('tilde-only path stays bare', __internals.quotePath('~'), '~')
  eq('relative path is quoted', __internals.quotePath('relative dir'), "'relative dir'")

  console.log('\ndestructive guard')
  const bad = __internals.destructiveReason
  for (const command of [
    'rm -rf /tmp/x',
    'rm -fr /tmp/x',
    'rm -r -f /tmp/x',
    'rm -f -r /tmp/x',
    'rm -R --force /tmp/x',
    'rm --recursive --force /tmp/x',
    'sudo rm -r -f /tmp/x',
    'rm /tmp/x -rf',
    'bash -c "rm -rf /"',
    'xargs rm -rf',
    'find . -exec rm -rf {} +',
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
    'rm -r somedir',
    'rm --force file.txt',
    'dd if=/dev/zero of=/tmp/file bs=1M count=1',
    'ls /dev/sda',
    'mkfsdir=/tmp/x',
    'echo rebooted',
    'grep -r foo .',
  ]) {
    check(`allows ${JSON.stringify(command)}`, bad(command) === null, `reason: ${bad(command)}`)
  }

  console.log('\nstderr cleaning and exit codes')
  const clean = __internals.cleanStderr
  const noisy = [
    'wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。',
    'your 131072x1 screen size is bogus. expect trouble',
    'real output',
  ].join('\n')
  eq('noise lines are dropped', clean(noisy), 'real output')
  eq('exit code sentinel normalizes', __internals.normalizeExitCode(0xFFFFFFFF), -1)
  eq('normal exit code is preserved', __internals.normalizeExitCode(7), 7)

  console.log('\nvalidation')
  check('distro rejects shell syntax', (() => {
    try { __internals.resolveDistro('a; rm -rf /'); return false } catch { return true }
  })())
  eq('distro default', __internals.resolveDistro(undefined), 'Ubuntu-22.04')

  const empty = __internals.streamFacts(undefined)
  eq('missing stream is empty', empty.text, '')
  eq('missing stream is not lossy', empty.lossy, false)
}

// --- tool-level tests ------------------------------------------------------

async function toolTests(tools, shim) {
  console.log('\nwsl: stdout / exit codes')
  const ok = await tools.wsl.execute({ command: 'echo hello', description: 'echo' })
  eq('exit code 0', ok.exitCode, 0)
  eq('stdout captured', ok.stdout.trim(), 'hello')
  eq('not marked timed out', ok.timedOut, false)
  eq('not truncated', ok.truncated, false)
  check('no markers rendered', __internals.formatResult(ok) === 'hello\n', JSON.stringify(__internals.formatResult(ok)))

  const failing = await tools.wsl.execute({ command: 'echo out; echo err 1>&2; exit 7', description: 'fail' })
  eq('exit code 7', failing.exitCode, 7)
  check('markers rendered', __internals.formatResult(failing, {}) === 'out\n[stderr]\nerr\n[exit code: 7]', JSON.stringify(__internals.formatResult(failing, {})))

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
  const allowed = await tools.wsl.execute({
    command: 'rm -r -f /tmp/dsh-wsl-guard-notexist; echo survived',
    description: 'allowed delete',
    allowDangerous: true,
  })
  eq('allowDangerous executes the command', allowed.stdout.trim(), 'survived')

  console.log('\nwsl: timeout')
  const timedOut = await tools.wsl.execute({ command: 'sleep 5', description: 'slow', timeoutMs: 900 })
  eq('timeout is reported as a fact', timedOut.timedOut, true)
  check('timeout marker rendered', /\[timed out after 900ms; the command was killed\]/.test(__internals.formatResult(timedOut, { timeoutMs: 900 })), JSON.stringify(__internals.formatResult(timedOut, { timeoutMs: 900 })))
  check('timeout does not report a bare exit code', !/\[exit code:/.test(__internals.formatResult(timedOut, { timeoutMs: 900 })))

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
  const rendered = __internals.formatResult(big, {})
  check('truncation marker names the spill file', rendered.includes('full stream:') && rendered.includes('bytes'), rendered.split('\n').pop())

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
  check('reports cpu count', /nproc: \d+/.test(env.summary), env.summary)
  check('reports distributions', env.summary.includes('--- distributions ---'), env.summary)
  await rejects('unknown distro is reported, not swallowed', () => tools['wsl-env'].execute({ distro: 'NoSuchDistro' }), /not registered/)
  await rejects('unknown distro on wsl is reported', () => tools.wsl.execute({ command: 'true', description: 'x', distro: 'NoSuchDistro' }), /not registered/)
}

// --- main ------------------------------------------------------------------

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-wsl-test-'))
const shim = makeShim(spillDir)
try {
  const tools = makeCtx(shim)
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
