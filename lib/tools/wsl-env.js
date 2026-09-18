// The `wsl-env` tool: summarize the WSL environment so an agent knows what it
// is running on before it starts issuing commands.

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
      'Summarize the WSL environment: registered distributions, kernel, CPU count, memory and disk ' +
      'usage. Useful for deciding what is available before running commands.',
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
    async execute(args) {
      const resolved = runner.resolveDistro(args.distro)
      const label = resolved === null ? 'the default WSL distribution' : `distro "${resolved}"`
      const opts = { distro: args.distro, timeoutMs: config.internalTimeoutMs }

      // The probes are independent, so run them concurrently: each wsl.exe
      // launch costs a WSL round trip, and four sequential ones dominate this
      // tool's latency. Measured: 163 ms in parallel against 134 ms for a
      // single call, so merging them into one bash invocation would save ~30 ms
      // and is not worth the lost per-probe error attribution.
      const [uname, mem, disk, list] = await Promise.all([
        runner.runWsl('uname -sr && echo "nproc: $(nproc)"', opts),
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
      const lines = [
        name === null ? 'distro: (system default)' : `distro: ${name}${resolved === null ? ' (system default)' : ''}`,
        uname.stdout.trim(),
      ]
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
