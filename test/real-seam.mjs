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
const { assertSupportedJsonSchema, validateJsonSchemaValue, ToolRuntime } = await load('@deepseek-ai/dsh-tools/lib/index.js')
const { apply } = await import(new URL('../index.js', import.meta.url).href)

const runtime = new LocalSubprocessRuntime(new Context())
const tools = {}
apply({ tools: { register: (tool) => { tools[tool.name] = tool } }, subprocess: runtime })

let failed = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed += 1
}

// Register into the REAL ToolRuntime: this runs the host's own
// register() path (scoped layer insert + the schema assertion), which no
// hand-written fake registry can vouch for. The constructor reads
// ctx.systemPrompt, so stub only that.
try {
  const registryCtx = new Context()
  registryCtx.provide?.('systemPrompt', { tools() {}, section() { return () => {} } })
  const registry = new ToolRuntime(registryCtx)
  apply({ tools: registry, subprocess: runtime })
  check('the plugin registers in the real DSH ToolRuntime', true)
} catch (error) {
  check('the plugin registers in the real DSH ToolRuntime', false, error.message)
}

// A background command must land in the REAL job registry, because the whole
// point is that the model drives it with the `job_output`/`job_kill` tools it
// already has. A fake registry cannot show that, and the registry refuses to
// serve an owner until `tool-jobs` attaches its controller — so this composes
// that controller for real rather than stubbing the check away.
{
  const { default: LocalJobRegistry } = await load('@deepseek-ai/dsh-jobs-local/lib/index.js')
  const jobsModule = await load('@deepseek-ai/dsh-tool-jobs/lib/index.js')

  const jobsCtx = new Context()
  // Only what those two plugins touch on a bare context: the model-facing tool
  // registry (which this test ignores) and the prompt-section registrar.
  jobsCtx.provide?.('tools', { register() {} })
  jobsCtx.provide?.('systemPrompt', { tools() {}, section() { return () => {} } })
  const jobs = new LocalJobRegistry(jobsCtx, {})
  // `tool-jobs` attaches the controller the registry demands and THEN wires
  // prompt sections, which need more of the real composition than a bare
  // context has. The controller attaches first, so a stub failure after that
  // point is not this plugin's concern — and that it attached is proven below,
  // because the registry refuses to serve an owner without one.
  try {
    jobsModule.apply(jobsCtx, { waitTimeoutMs: 30_000 })
  } catch {
    // Prompt-section wiring needs the full host composition; deliberately ignored.
  }

  // Control: the same call on a registry with NO controller must be refused,
  // which is what makes the successful start below meaningful rather than vacuous.
  try {
    new LocalJobRegistry(new Context(), {}).start({
      kind: 'wsl', label: 'control', run: () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' }) }),
    })
    check('the registry refuses a job with no controller (control)', false, 'it was accepted')
  } catch (error) {
    check('the registry refuses a job with no controller (control)', /no job controller/.test(error.message))
  }

  const toolSet = {}
  apply({
    tools: { register: (tool) => { toolSet[tool.name] = tool } },
    subprocess: runtime,
    get: (name) => (name === 'jobs' ? jobs : undefined),
  })
  try {
    const started = await toolSet.wsl.execute({
      command: 'echo real-job-output', description: 'real background job', runInBackground: true,
    })
    check('a background start returns a wsl-<n> job id', /^wsl-\d+$/.test(started.jobId ?? ''), String(started.jobId))

    const snapshot = jobs.get(started.jobId)
    check('the real registry knows the job', snapshot?.kind === 'wsl', String(snapshot?.kind))
    check('the real registry carries the label', /^wsl: /.test(snapshot?.label ?? ''), String(snapshot?.label))

    const final = await jobs.wait(started.jobId, 30_000)
    check('the job completes in the real registry', final?.status === 'completed', String(final?.status))
    check('the real registry carries the exit detail', /exit code 0/.test(final?.detail ?? ''), String(final?.detail))
    const read = jobs.read(started.jobId)
    check('the real registry returns the job output',
      JSON.stringify(read ?? '').includes('real-job-output'), JSON.stringify(read).slice(0, 160))

    // Cancel through the registry, exactly as `job_kill` would.
    const longOne = await toolSet.wsl.execute({
      command: 'sleep 60', description: 'real background cancel', runInBackground: true,
    })
    jobs.kill(longOne.jobId, undefined, 'test cancel')
    const killed = await jobs.wait(longOne.jobId, 30_000)
    check('a registry kill stops the job', killed?.status === 'killed', String(killed?.status))
  } catch (error) {
    check('background jobs work in the real registry', false, error.message)
  }
}

// ToolRuntime.register() asserts output.schema at PLUGIN LOAD time, so a schema
// outside DSH's supported subset would break registration on the next restart
// rather than fail a call. The parameters schema is projected into the model's
// tool catalog, so it has to stay inside the same subset.
for (const [name, tool] of Object.entries(tools)) {
  try {
    assertSupportedJsonSchema(tool.output.schema)
    assertSupportedJsonSchema(tool.parameters)
    check(`${name}: schemas accepted by DSH's own validator`, true)
  } catch (error) {
    check(`${name}: schemas accepted by DSH's own validator`, false, error.message)
  }
}

const shape = { ...(await tools.wsl.execute({ command: 'echo shape', description: 'shape' })) }
check('a returned value satisfies output.schema', validateJsonSchemaValue(tools.wsl.output.schema, shape, '').length === 0)
check('an unexpected result field is rejected', validateJsonSchemaValue(tools.wsl.output.schema, { ...shape, extra: 1 }, '').length > 0)

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
