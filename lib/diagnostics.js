// Capability diagnostics for `wsl-env`: one probe script, its parser, and the
// compact lines composed from it.
//
// The question this answers is "can this machine run X?" — WSL1 or 2, systemd,
// cgroup version, GPU passthrough, docker, which drives are mounted, and how WSL
// itself is configured. Every fact is optional: a missing tool or a disabled
// interop must degrade to a label, never fail the whole summary.

import { windowsPathToWsl } from './paths.js'

const WINDOWS_MOUNT_RE = /^\/mnt\/([a-z])(?:\/|$)/

/**
 * Describe where the session's own working directory lands inside WSL.
 *
 * This is the one fact that changes what the model should DO rather than what it
 * can do: a checkout under `/mnt/<drive>` goes through the Windows filesystem
 * bridge, where metadata-heavy work (builds, installs, git) is dramatically
 * slower than on the Linux filesystem — measured on the author's machine at ~8x
 * for a 128 MB sequential write and far worse for many small files. Saying so
 * here is cheap; discovering it as a mystery slowdown is not.
 *
 * @param hostCwd - the plugin's own working directory (a Windows path here).
 * @returns a summary line, or null when the directory cannot be expressed.
 */
export function workspaceLine(hostCwd) {
  const path = windowsPathToWsl(String(hostCwd ?? ''))
  if (!path.startsWith('/')) return null
  const mount = WINDOWS_MOUNT_RE.exec(path)
  const where = mount === null
    ? 'Linux filesystem'
    : `Windows drive mount /mnt/${mount[1]} — builds, installs and git are much slower here; prefer a path under /home when it matters`
  return `workspace: ${path} (${where})`
}

/**
 * One shell round trip collecting every fact that does not need its own
 * `wsl.exe` launch. Each line is `key=value`; a fact that cannot be read prints
 * an explicit marker (`absent`, `none`, empty) rather than disappearing.
 *
 * `cmd.exe` is reached through interop to read the WINDOWS-side `.wslconfig`
 * (networking mode, memory and processor limits live there, not in the distro).
 * It runs from `/mnt/c` so cmd.exe does not inherit a `\\wsl.localhost\...`
 * working directory and complain about a UNC path.
 */
export const CAPABILITY_PROBE = [
  String.raw`echo "os=$(. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME")"`,
  String.raw`echo "wsl=$(uname -r | grep -q WSL2 && echo 2 || echo 1)"`,
  String.raw`echo "init=$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')"`,
  String.raw`echo "cgroup=$(stat -fc %T /sys/fs/cgroup 2>/dev/null)"`,
  String.raw`[ -e /dev/dxg ] && echo "gpu=dxg" || echo "gpu=none"`,
  String.raw`if command -v nvidia-smi >/dev/null 2>&1; then echo "nvidia=$(nvidia-smi -L 2>/dev/null | head -1)"; else echo "nvidia=absent"; fi`,
  String.raw`if command -v docker >/dev/null 2>&1; then echo "docker=$(timeout 3 docker info --format '{{.ServerVersion}}' 2>/dev/null || echo cli-only)"; else echo "docker=absent"; fi`,
  String.raw`echo "drives=$(ls /mnt 2>/dev/null | grep -E '^[a-z]$' | tr '\n' ',')"`,
  String.raw`echo "wslconf=$(grep -vE '^[[:space:]]*(#|$)' /etc/wsl.conf 2>/dev/null | tr '\n' ';')"`,
  String.raw`echo "winconf=$(cd /mnt/c 2>/dev/null && cmd.exe /c 'type "%USERPROFILE%\.wslconfig"' 2>/dev/null | tr -d '\r' | grep -vE '^[[:space:]]*(#|$)' | tr '\n' ';')"`,
].join('\n')

/**
 * Parse `key=value` probe output into a fact map.
 * Lines without `=`, and keys repeated later, are ignored/overwritten; values
 * keep their internal spaces and lose only the trailing newline.
 */
export function parseFacts(text) {
  const facts = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (key === '' || /\s/.test(key)) continue
    facts[key] = line.slice(separator + 1).trim()
  }
  return facts
}

function cgroupLabel(value) {
  if (value === 'cgroup2fs') return 'cgroup v2'
  if (value === 'tmpfs') return 'cgroup v1'
  return value === undefined || value === '' ? null : `cgroup ${value}`
}

/**
 * Compose the compact capability lines from a parsed probe.
 * @returns lines for the facts that were readable; unreadable ones are omitted
 *   rather than guessed at, so an absent line means "could not tell".
 */
export function capabilityLines(facts) {
  const lines = []

  // Identity and kernel-level facts.
  const identity = []
  if (facts.os) identity.push(facts.os)
  if (facts.wsl === '2') identity.push('WSL2')
  else if (facts.wsl === '1') identity.push('WSL1 (no systemd, no docker, slow /mnt)')
  const cgroup = cgroupLabel(facts.cgroup)
  if (cgroup !== null) identity.push(cgroup)
  if (identity.length > 0) lines.push(identity.join(' · '))

  // Init system and containers.
  const runtime = []
  if (facts.init) {
    runtime.push(facts.init === 'systemd' ? 'systemd: yes' : `systemd: no (PID 1 is ${facts.init})`)
  }
  if (facts.docker === 'absent') runtime.push('docker: not installed')
  else if (facts.docker === 'cli-only') runtime.push('docker: cli only, daemon unreachable')
  else if (facts.docker) runtime.push(`docker: daemon ${facts.docker}`)
  if (runtime.length > 0) lines.push(runtime.join(' · '))

  // GPU passthrough. The adapter UUID adds length without answering
  // "can this machine do GPU work", so it is dropped.
  const gpu = []
  if (facts.gpu === 'dxg') gpu.push('/dev/dxg present (GPU passthrough enabled)')
  else if (facts.gpu === 'none') gpu.push('no /dev/dxg (no GPU passthrough)')
  if (facts.nvidia && facts.nvidia !== 'absent') {
    gpu.push(`nvidia-smi: ${facts.nvidia.replace(/\s*\(UUID:[^)]*\)/, '')}`)
  } else if (facts.nvidia === 'absent') gpu.push('nvidia-smi: not installed')
  if (gpu.length > 0) lines.push(`GPU: ${gpu.join(' · ')}`)

  // Mounted Windows drives.
  const drives = (facts.drives ?? '').split(',').filter((drive) => drive !== '')
  if (drives.length > 0) lines.push(`drives: ${drives.map((drive) => `/mnt/${drive}`).join(' ')}`)

  // Configuration, from both sides of the boundary.
  const config = []
  if (facts.wslconf) config.push(`/etc/wsl.conf: ${facts.wslconf}`)
  if (facts.winconf) config.push(`.wslconfig: ${facts.winconf}`)
  else if (facts.winconf === '') config.push('.wslconfig: not set')
  if (config.length > 0) lines.push(config.join(' · '))

  return lines
}

/**
 * Summarize `wsl --version`, whose labels are LOCALIZED, so nothing is parsed
 * by name: the first three lines are WSL/kernel/WSLg in a fixed order, and the
 * Windows build line is the one naming Windows. The Direct3D/MSRDC/DXCore
 * versions are dropped as noise.
 * @returns one line, or null when the output was not the expected table.
 */
export function launcherSummary(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(':') && line.length > 0)
  if (lines.length === 0) return null
  const keep = lines.slice(0, 3)
  const windows = lines.find((line) => /windows/i.test(line))
  if (windows !== undefined && !keep.includes(windows)) keep.push(windows)
  return keep.join(' · ')
}
