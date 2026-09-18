// Destructive-command guard.
//
// The guard is a safety net for a model that is about to do something
// irreversible — not a security boundary (the caller may always pass
// `allowDangerous: true`). It is therefore tuned to be deterministic and to
// err toward refusing, while still letting a read-only INVESTIGATION of the
// same tools run: `man fdisk` and `grep reboot /var/log/syslog` must work.

// `rm` is the one command whose flag spelling is genuinely open-ended:
// `rm -rf`, `rm -fr`, `rm -r -f`, `rm -R --force`, `rm --recursive --force`.
// A regex over the whole command missed the separated and long forms, so scan
// each `rm` invocation and collect its flags individually. The prefix and the
// trailing lookahead tolerate everything that can wrap a command word: quotes,
// backticks, `$(`/`)` command substitution, and a `\rm` escape.
const RM_INVOCATION = /(?:^|[\s;&|"'`(\\])(?:\S*\/)?rm(?=[\s"'`)}]|$)/g
const QUOTE_STRIP_RE = /^["'`]+|["'`]+$/g

// `$IFS` (and `${IFS}`) expands to whitespace, so `rm$IFS-rf` is the same
// command as `rm -rf`. Normalize it for MATCHING only; the command that runs is
// untouched, so the worst case is refusing an exotic but harmless literal.
const IFS_ESCAPE_RE = /\$\{?IFS\}?/g

// A RECURSIVE delete is refused whether or not `-f` is present: with stdin on
// /dev/null nothing prompts, so `rm -r tree` deletes a whole tree silently —
// exactly what this guard exists to prevent. Requiring `-f` as well let
// `rm a -f; rm b -r` through, and `-f` only suppresses prompts anyway.
export function rmIsDestructive(segment) {
  RM_INVOCATION.lastIndex = 0
  let match
  while ((match = RM_INVOCATION.exec(segment)) !== null) {
    for (const rawToken of segment.slice(match.index + match[0].length).split(/\s+/)) {
      const token = rawToken.replace(QUOTE_STRIP_RE, '')
      if (token === '--') break
      if (token === '--recursive') return true
      else if (/^-[A-Za-z]+$/.test(token) && (token.includes('r') || token.includes('R'))) return true
    }
  }
  return false
}

// A command line is a sequence of segments separated by `;`, `&`, `|` or a
// newline. Scanning the WHOLE line for dangerous keywords refused `man fdisk`
// and `grep reboot /var/log/syslog`, so each segment is evaluated separately
// and the device/power tools are matched at COMMAND POSITION — the first word,
// past the wrappers and `VAR=value` assignments that can precede it.
const SEGMENT_SPLIT_RE = /[;&|\n]+/
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'exec', 'nohup', 'nice', 'ionice', 'time', 'stdbuf', 'setsid', 'env',
])
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The command word a segment invokes, with wrappers skipped and the path removed. */
export function commandWord(segment) {
  const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0)
  let index = 0
  while (index < tokens.length) {
    const bare = tokens[index].replace(QUOTE_STRIP_RE, '')
    if (COMMAND_WRAPPERS.has(bare) || ENV_ASSIGNMENT_RE.test(bare) || bare.startsWith('-')) {
      index += 1
      continue
    }
    break
  }
  const word = tokens[index]
  if (word === undefined) return null
  const bare = word.replace(QUOTE_STRIP_RE, '')
  return bare.slice(bare.lastIndexOf('/') + 1)
}

const POWER_TOOLS = new Set(['shutdown', 'poweroff', 'reboot', 'halt'])
const DISK_TOOLS = new Set(['mkswap', 'wipefs', 'fdisk', 'sfdisk', 'gdisk', 'sgdisk', 'parted', 'blkdiscard', 'shred'])

// Patterns that are dangerous wherever they appear, because they WRITE to a
// block device or fork-bomb the machine regardless of the command word.
const DESTRUCTIVE_PATTERNS = [
  [/[^>]\s*>>?\s*\/dev\/(sd|hd|nvme|mmcblk|vd|xvd|disk)/, 'redirect onto a block device'],
  [/:\s*\(\s*\)\s*\{[^\n]*\|[^\n]*&[^\n]*\}\s*;\s*:/, 'fork bomb'],
]

function segmentReason(segment) {
  if (rmIsDestructive(segment)) return 'recursive delete (`rm -r`)'

  const word = commandWord(segment)
  if (word === null) return null
  if (POWER_TOOLS.has(word)) return `power control (\`${word}\`)`
  if (/^mkfs(\.\w+)?$/.test(word)) return 'mkfs (format a filesystem)'
  if (DISK_TOOLS.has(word)) return `disk tool (\`${word}\`)`
  if (word === 'dd' && /\bof=\s*\/dev\//.test(segment)) return 'dd onto a block device'
  if (word === 'systemctl' && /\b(poweroff|reboot|halt)\b/.test(segment)) return 'power control (systemctl)'
  return null
}

/**
 * @param command - the final (post-translation) command string.
 * @returns a human-readable reason when the command is destructive, else null.
 */
export function destructiveReason(command) {
  const scanned = command.replace(IFS_ESCAPE_RE, ' ')
  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(scanned)) return reason
  }
  for (const segment of scanned.split(SEGMENT_SPLIT_RE)) {
    const reason = segmentReason(segment)
    if (reason !== null) return reason
  }
  return null
}
