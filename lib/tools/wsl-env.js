// The `wsl-env` tool: summarize the WSL environment so an agent knows what it
// is running on before it starts issuing commands.

import { CAPABILITY_PROBE, capabilityLines, launcherSummary, parseFacts, workspaceLine } from '../diagnostics.js'
import { sessionCwdOf } from '../runner.js'

/** The `*`-marked row of `wsl -l -v` is the default distribution. */
export function parseDefaultDistro(listOutput) {
  for (const line of String(listOutput).split(/\r?\n/)) {
    const match = /^\s*\*\s*(\S+)/.exec(line)
    if (match !== null) return match[1]
  }
  return null
}

export function createWslEnvTool({ config, runner }) {
  return {
    name: 'wsl-env',
    description:
      'Summarize the WSL environment: registered distributions, kernel and architecture, CPU count, ' +
      'memory and disk usage, and what the machine can actually do — WSL1 or WSL2, systemd, cgroup ' +
      'version, GPU passthrough, docker, mounted drives, and the /etc/wsl.conf + .wslconfig settings. ' +
      'Use it to decide what is available before running commands.',
    parameters: {
      type: 'object',
      properties: {
        distro: {
          type: 'string',
          description: 'WSL distribution to probe. Defaults to the system default distribution.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const resolved = runner.resolveDistro(args.distro)
      const label = resolved === null ? 'the default WSL distribution' : `distro "${resolved}"`
      const opts = { distro: args.distro, timeoutMs: config.internalTimeoutMs, exec }

      // The probes are independent, so run them concurrently: each wsl.exe
      // launch costs a WSL round trip, and sequential ones would dominate this
      // tool's latency. Measured: 5 parallel spawns cost the same as one.
      const [uname, caps, launcher, mem, disk, list] = await Promise.all([
        runner.runWsl('uname -srm && echo "nproc: $(nproc)"', opts),
        // Every capability fact that needs no separate launch travels in one
        // script, so the diagnostics stay free rather than costing 8 spawns.
        runner.runWsl(CAPABILITY_PROBE, opts),
        runner.spawnWsl(['wsl.exe', '--version'], config.internalTimeoutMs),
        runner.runWsl("free -h | awk 'NR==1 || NR==2'", opts),
        runner.runWsl('df -h / /home 2>/dev/null || df -h /', opts),
        runner.spawnWsl(['wsl.exe', '-l', '-v'], config.internalTimeoutMs),
      ])

      const failure = (name, result) => {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
        return `[${name} unavailable: ${detail.split(/\r?\n/)[0]}]`
      }

      // Nothing worked: report it instead of returning a summary that silently
      // omits the kernel, memory and disk the caller asked for.
      if (uname.exitCode !== 0) {
        const detail = uname.stderr.trim() || uname.stdout.trim() || `exit code ${uname.exitCode}`
        throw new Error(`wsl-env: could not probe ${label}: ${detail}`)
      }

      // Name the distribution actually used, so "system default" is never a
      // mystery the caller has to resolve with a second call.
      const name = resolved ?? parseDefaultDistro(list.stdout)
      const header = [
        name === null ? 'distro: (system default)' : `distro: ${name}${resolved === null ? ' (system default)' : ''}`,
        uname.stdout.trim(),
      ]
      // Capabilities degrade one line at a time: a probe that failed leaves its
      // line out instead of failing the whole summary.
      if (caps.exitCode === 0) header.push(...capabilityLines(parseFacts(caps.stdout)))
      else header.push(failure('capabilities', caps))
      const launcherLine = launcher.exitCode === 0 ? launcherSummary(launcher.stdout) : null
      if (launcherLine !== null) header.push(`launcher: ${launcherLine}`)
      // Where the session's own files live is the one fact here that changes what
      // the caller should choose to DO, so it is stated rather than implied — and
      // it is the CALLING SESSION's workspace, never the host's launch directory.
      const workspace = workspaceLine(sessionCwdOf(exec) ?? process.cwd())
      if (workspace !== null) header.push(workspace)

      const lines = [header.join('\n')]
      lines.push(mem.exitCode === 0 ? mem.stdout.trimEnd() : failure('memory', mem))
      lines.push(disk.exitCode === 0 ? disk.stdout.trimEnd() : failure('disk', disk))
      // `wsl -l -v` can exit 0 with nothing on stdout; a bare header would be
      // the only thing this section contributes, so report it as a failure.
      if (list.exitCode === 0 && list.stdout.trim() !== '') {
        lines.push('--- distributions ---\n' + list.stdout.trimEnd())
      } else if (list.exitCode === 0) {
        lines.push('[distribution list unavailable: wsl -l -v produced no output]')
      } else {
        lines.push(failure('distribution list', list))
      }

      return { summary: lines.filter((line) => line.length > 0).join('\n\n') }
    },
    presentCall: () => ({ card: 'text', title: 'wsl environment', description: 'inspect WSL environment' }),
  }
}
