// The `wsl-doctor` tool: compare what a project needs with what the WSL
// distribution actually has.
//
// This is the read-only half of the pair; `wsl-bootstrap` acts on what it finds.
// The report exists because the interesting failure is invisible from both
// sides: a project's toolchain can be "found" on PATH and still be a Windows
// binary (see lib/doctor.js).

import { workspaceLine } from '../diagnostics.js'
import { composeDoctorReport, parseProbe, PROJECT_PROBE } from '../doctor.js'
import { windowsPathToWsl } from '../paths.js'
import { sessionCwdOf } from '../runner.js'
import { parseDefaultDistro } from './wsl-env.js'

export function createWslDoctorTool({ config, runner }) {
  return {
    name: 'wsl-doctor',
    description:
      'Compare a project with the distribution it runs in: which toolchain its manifests ask for ' +
      '(package.json and lockfiles, Cargo.toml, go.mod, pyproject.toml, Dockerfile, Makefile, CMakeLists.txt), ' +
      'which of those resolve on the Linux side, and which resolve only to a WINDOWS binary through interop — ' +
      'WSL appends the Windows PATH, so `npm` can be the Windows npm while the Linux side has no `node` at all. ' +
      'Reports privileges too. Read-only; run it before blaming a failed command on the command.',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Linux directory to inspect: a Linux path (`~`, `/home/me/proj`) or a translated Windows path. '
            + 'Defaults to the configured directory, else the session workspace.',
        },
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
      if (args.workspace !== undefined && typeof args.workspace !== 'string') {
        throw new Error('wsl-doctor: workspace must be a string')
      }
      if (args.workspace !== undefined && args.workspace.trim() === '') {
        throw new Error('wsl-doctor: workspace must not be empty when given')
      }
      const resolved = runner.resolveDistro(args.distro)
      const label = resolved === null ? 'the default WSL distribution' : `distro "${resolved}"`

      // Same resolution as the `wsl` tool's own default, so the doctor inspects
      // the directory commands would actually run in.
      const requested = args.workspace !== undefined ? args.workspace : undefined
      const fallback = config.defaultWorkdir === null
        ? (sessionCwdOf(exec) ?? process.cwd())
        : config.defaultWorkdir
      const workspace = windowsPathToWsl(requested ?? String(fallback))

      const opts = { distro: args.distro, workdir: workspace, timeoutMs: config.internalTimeoutMs, exec }
      const [probe, list] = await Promise.all([
        runner.runWsl(PROJECT_PROBE, opts),
        runner.spawnWsl(['wsl.exe', '-l', '-v'], config.internalTimeoutMs),
      ])

      const facts = parseProbe(probe.stdout)
      // An unusable workspace is a fact about the request, not a broken probe:
      // report it so the caller can name another directory instead of guessing.
      if (probe.exitCode !== 0 && Object.keys(facts).length === 0) {
        const detail = (probe.stderr.trim() || probe.stdout.trim() || `exit code ${probe.exitCode}`).split(/\r?\n/)[0]
        return {
          summary: [
            `distro: ${resolved ?? parseDefaultDistro(list.stdout) ?? '(system default)'}`,
            `workspace: ${workspace} — could not be entered: ${detail}`,
            'next: pass `workspace` with a Linux directory that exists (run the `wsl-env` tool to see the mounts).',
          ].join('\n\n'),
        }
      }

      const name = resolved ?? parseDefaultDistro(list.stdout)
      facts['base.distro'] = name === null
        ? '(system default)'
        : (resolved === null ? `${name} (system default)` : name)

      // Root is probed ONLY when the panel allows root execution anyway:
      // reporting whether root works must not require running a root command
      // the user has not authorised.
      let rootProbe = null
      if (config.allowRoot === true) {
        try {
          const root = await runner.runWsl('id -u', {
            distro: args.distro,
            workdir: '/',
            timeoutMs: config.internalTimeoutMs,
            asRoot: true,
            exec,
          })
          rootProbe = root.exitCode === 0 && root.stdout.trim() === '0' ? 'available' : 'unavailable'
        } catch {
          rootProbe = 'unavailable'
        }
      }

      return {
        summary: composeDoctorReport(facts, {
          workspaceLine: workspaceLine(workspace) ?? '',
          bootstrapAvailable: config.tools.bootstrap === true,
          rootEnabled: config.allowRoot === true,
          rootProbe,
        }),
      }
    },
    // Probed, nothing changed: the generic card is honest about that.
    presentCall: () => ({ card: 'generic', title: 'Check the project against WSL' }),
  }
}
