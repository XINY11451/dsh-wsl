// Verifies dsh-wsl against the REAL DSH subprocess provider instead of the
// shim used by `smoke.mjs`. The seam facts this plugin depends on — that
// `readFrom(0)` returns the whole-stream total in `nextOffset`, that the spill
// file holds the complete stream, and that a timeout really kills the Linux
// side of wsl.exe — can only be checked here.
//
//   DSH_SUBPROCESS_LOCAL=<node_modules dir with @deepseek-ai/*> node test/real-seam.mjs
//
// The suite is skipped (exit 0) when that directory is not configured, so it
// never breaks a checkout without a DSH installation next to it.

import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const modulesRoot = process.env.DSH_SUBPROCESS_LOCAL
if (modulesRoot === undefined || modulesRoot === '') {
  console.log('skipped: set DSH_SUBPROCESS_LOCAL to a node_modules directory containing @deepseek-ai/*')
  process.exit(0)
}

const load = (relative) => import(pathToFileURL(`${modulesRoot}/${relative}`).href)
const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
const { default: LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local/lib/index.js')
const { apply } = await import(new URL('../index.js', import.meta.url).href)

const runtime = new LocalSubprocessRuntime(new Context())
const tools = {}
apply({ tools: { register: (tool) => { tools[tool.name] = tool } }, subprocess: runtime })

let failed = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed += 1
}

const small = await tools.wsl.execute({ command: 'echo hello', description: 'echo' })
check('small output is complete', small.stdout.trim() === 'hello' && small.truncated === false)
check('small stream total is exact', small.stdoutTotalBytes === 6, String(small.stdoutTotalBytes))

const big = await tools.wsl.execute({ command: 'seq 1 200000', description: 'big' })
check('large output is reported lossy', big.truncated === true)
check('nextOffset is the whole-stream total', big.stdoutTotalBytes === 1_288_895, String(big.stdoutTotalBytes))
check('kept + dropped === total', big.stdoutTotalBytes === big.stdoutDroppedBytes + Buffer.byteLength(big.stdout, 'utf8'))
check('spill file is intact and complete', statSync(big.stdoutSpillPath).size === big.stdoutTotalBytes)
check('spill file starts at the head of the stream', readFileSync(big.stdoutSpillPath, 'utf8').startsWith('1\n2\n3\n'))

const timedOut = await tools.wsl.execute({ command: 'sleep 60', description: 'slow', timeoutMs: 1200 })
check('timeout is classified', timedOut.timedOut === true)
const orphan = await tools.wsl.execute({ command: 'pgrep -x sleep || echo NO_ORPHAN', description: 'orphan check' })
check('provider kills the Linux side too', orphan.stdout.includes('NO_ORPHAN'), JSON.stringify(orphan.stdout.trim()))

const pathTool = await tools['wsl-path'].execute({ path: 'C:\\Program Files\\Git' })
check('wsl-path translates a spaced path', pathTool.converted === '/mnt/c/Program Files/Git', pathTool.converted)
const tildePath = await tools['wsl-path'].execute({ path: '~' })
check('wsl-path expands a tilde', tildePath.converted !== '~' && tildePath.converted.includes('home'), tildePath.converted)

const env = await tools['wsl-env'].execute({})
check('wsl-env reports the environment', env.summary.includes('nproc:') && env.summary.includes('--- distributions ---'))

const spaced = await tools.wsl.execute({ command: 'pwd', description: 'spaced', workdir: 'C:\\Program Files' })
check('spaced workdir resolves', spaced.stdout.trim() === '/mnt/c/Program Files', JSON.stringify(spaced.stdout.trim()))

const longCommand = await tools.wsl.execute({ command: `echo ${'x'.repeat(31_000)}`, description: 'long' })
check('an over-limit command still runs (stdin relay)', longCommand.stdout.trim().length === 31_000, String(longCommand.stdout.trim().length))

const verbatim = await tools.wsl.execute({ command: "echo 'C:\\Users\\me'", description: 'verbatim', translatePaths: false })
check('translatePaths:false reaches Linux verbatim', verbatim.stdout.trim() === 'C:\\Users\\me', verbatim.stdout.trim())
const translated = await tools.wsl.execute({ command: "echo 'C:\\Users\\me'", description: 'translated' })
check('default translation still applies', translated.stdout.trim() === '/mnt/c/Users/me', translated.stdout.trim())

try {
  await tools.wsl.execute({ command: 'true', description: 'missing distro', distro: 'NoSuchDistro' })
  check('an unknown distro throws a clear error', false, 'no error was raised')
} catch (error) {
  check('an unknown distro throws a clear error', /not registered/.test(error.message), error.message)
}

console.log(failed === 0 ? '\nREAL SEAM: all checks passed' : `\nREAL SEAM: ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
