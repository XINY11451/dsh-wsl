/**
 * The WSL channel: a small loopback HTTP server the `dsh` command inside WSL talks to.
 *
 * Why a server of its own instead of the plugin's `webServer` routes: that server binds
 * 127.0.0.1, and under WSL2 NAT the WSL side reaches this machine through the WSL virtual
 * adapter's address, not through loopback. So this module listens on the address WSL
 * itself uses as its default gateway (discovered by asking `wsl.exe`), on a random port,
 * and every request must carry a token that only the state file and this module know.
 * The token defends the channel when the adapter is reachable from more than one peer.
 *
 * The wire protocol is line-oriented TEXT, not JSON, because the client is a bash script:
 *
 *   client -> server   POST /say     raw UTF-8 prompt in the body
 *                      POST /list    (empty body)
 *                      POST /new     one session id
 *                      POST /rm      one session id
 *                      GET  /state   (no body)
 *   server -> client   one line per frame:
 *                      `~ack`                 request accepted
 *                      `~r <ms>`              this turn's reasoning has started (ms since send)
 *                      `~t <ms>`              visible answer text has started
 *                      `~step <turn> <step>`  one step began
 *                      `~s <base64>`          reasoning chunk (raw text, UTF-8)
 *                      `~a <base64>`          answer chunk (raw text, UTF-8)
 *                      `~p`                   heartbeat, ignore
 *                      `~e <ok> <ms> <steps> <in> <out> <base64 reason>`
 *                      `~x <base64 message>`  error before/after the turn
 *                      `ok\t<id>` / `err\t<message>` for the management routes
 *
 * Base64 is what keeps arbitrary model output (newlines, tabs, ANSI, CJK) from colliding
 * with the frame markers while still streaming chunk by chunk.
 *
 * Everything here is defensive: this feature must never be the reason the plugin fails to
 * mount, so services are looked up lazily and every failure becomes a frame or an error
 * line, not an exception in `apply()`.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { shellQuote } from './paths.js'
import { stripAnsi } from './terminal.js'

/** Size cap for a management request body (a session id), in bytes. */
const MAX_ID_BODY = 4096
/** Size cap for a prompt body, in bytes. The model gets the text verbatim. */
const MAX_PROMPT_BODY = 256 * 1024
/** Heartbeat cadence while a turn runs, so a proxy cannot idle the stream out. */
const HEARTBEAT_MS = 15000
/** Hard ceiling for one turn; the agent itself has no wall clock. */
const MAX_TURN_MS = 4 * 60 * 60 * 1000
/** A session id the client can carry: no whitespace or control characters, bounded length. */
const MAX_SESSION_ID = 128
/** `/list` rows are re-validated after this long; changes from the GUI invalidate outright. */
const ROWS_CACHE_TTL_MS = 500
/** The session event that moves a label the picker shows (and no token delta does). */
const TITLE_EVENT = 'session/title'

/**
 * A session id that can travel through the line protocol, the TSV list and the per-terminal
 * current file without being split. Control characters and whitespace are refused rather
 * than trimmed: an id is an identity, not a message.
 * @param {unknown} value - candidate id.
 * @returns {boolean} true when it is usable as an id.
 */
export function validSessionId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_ID
    && !/[\s\u0000-\u001f\u007f]/u.test(value)
}

/**
 * One tab-separated cell: titles are model text, so a tab or newline in one must not shift
 * the columns of `dsh list` (or fabricate a row, `*` marker included).
 * @param {unknown} value - cell text.
 * @returns {string} single-line text.
 */
function tsvCell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ')
}

/**
 * Prefix for every prompt that arrives through the WSL terminal. `sessionController.prompt`
 * always records a plain user message, so without this the conversation shows the terminal's
 * words exactly as if the user had typed them there. The prefix is the honest label the
 * client can render — the API offers no origin field.
 */
export const SAY_PREFIX = '【WSL 终端】'

/**
 * The channel's own state file. The `dsh` shim reads port and token from here, so it has
 * to live on the Windows side where WSL can reach it under /mnt/c.
 *
 * It deliberately does NOT live under `~/.dsh/dsh-wsl`: that is exactly where a
 * development checkout of this plugin sits, and writing runtime state into a git working
 * tree put a generated shim into the repository on 2026-10-22. `%LOCALAPPDATA%\dsh-wsl`
 * is per-user, not versioned, and still reachable as /mnt/c/...
 * @param {NodeJS.ProcessEnv} env - used only to find the user's local-app-data directory.
 * @returns {string} absolute path to `channel.json`.
 */
export function channelStateFile(env = process.env) {
  const root = env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local')
  return join(root, 'dsh-wsl', 'channel.json')
}

/**
 * The configured default session, with the documented fallback.
 * @param {object} config - the resolved plugin config.
 * @returns {string} a non-empty session id.
 */
export function channelSessionOf(config) {
  const value = config !== null && typeof config === 'object' ? config.channelSession : undefined
  // Empty means auto: the channel keeps a dedicated session for the terminal. A literal
  // id that does not exist would make every prompt fail instead of doing the obvious thing.
  return typeof value === 'string' ? value.trim() : ''
}

/** One base64 chunk frame line. @param {string} tag - `s` or `a`. @param {string} text - raw chunk. */
const chunkLine = (tag, text) => `~${tag} ${Buffer.from(text, 'utf8').toString('base64')}`

/** One base64 error frame line. @param {string} message - human readable. */
const errorLine = (message) => `~x ${Buffer.from(String(message), 'utf8').toString('base64')}`

/**
 * Read a request body with a cap, as UTF-8 text.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {number} limit - byte cap; exceeding it rejects rather than truncating.
 * @returns {Promise<string>} the body.
 */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let tooLarge = false
    request.on('data', (chunk) => {
      // Once over the cap the rest is still consumed (and discarded) so the client can read
      // the 413 answer: destroying or pausing here leaves unread bytes and the close becomes
      // a bare connection reset instead of the error line.
      if (tooLarge) return
      total += chunk.length
      if (total > limit) {
        tooLarge = true
        const error = new Error(`request body exceeds ${String(limit)} bytes`)
        error.code = 'BODY_TOO_LARGE'
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Answer one plain-text management request.
 * @param {import('node:http').ServerResponse} response - response.
 * @param {number} code - HTTP status.
 * @param {string} line - the single line to send.
 */
function answerLine(response, code, line) {
  if (response.headersSent) {
    try { response.end() } catch { /* already gone */ }
    return
  }
  response.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(line + '\n')
}

/**
 * Format Platform wallet rows the way the account panel does: currency symbol, two decimals,
 * `<0.01` under a cent, grouped digits. Unknown shapes are ignored rather than printed raw.
 * @param {unknown} wallets - `[{ currency, balance }]` from the account service.
 * @returns {string} e.g. `¥12.34` or `¥12.34 + $1.00`; '' when nothing usable.
 */
export function walletText(wallets) {
  if (!Array.isArray(wallets)) return ''
  const parts = []
  for (const wallet of wallets) {
    if (wallet === null || typeof wallet !== 'object') continue
    const currency = wallet.currency === 'USD' ? '$' : (wallet.currency === 'CNY' ? '¥' : '')
    if (currency === '') continue
    // Only a real number or a numeric string is a balance. `Number(null)`/`Number('')` are 0,
    // and printing those as `¥0.00` would turn a missing value into "no money left".
    const raw = wallet.balance
    const amount = typeof raw === 'number'
      ? raw
      : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN)
    if (!Number.isFinite(amount)) continue
    const abs = Math.abs(amount)
    if (amount === 0) {
      parts.push(`${currency}0.00`)
      continue
    }
    if (abs < 0.01) {
      parts.push(`${amount < 0 ? '-' : ''}<${currency}0.01`)
      continue
    }
    const [whole, fraction] = abs.toFixed(2).split('.')
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    parts.push(`${amount < 0 ? '-' : ''}${currency}${grouped}.${fraction}`)
  }
  return parts.join(' + ')
}

let harnessVersionCache = null
/**
 * The client version the account service expects in its request headers. The account panel
 * sends the Harness build version; read the same package when it is resolvable.
 * @returns {Promise<string>} a version string, never empty.
 */
export async function harnessVersion() {
  if (harnessVersionCache !== null) return harnessVersionCache
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../@deepseek-ai/dsh/package.json', import.meta.url), 'utf8'))
    harnessVersionCache = typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.2.1'
  } catch {
    harnessVersionCache = '0.2.1'
  }
  return harnessVersionCache
}

/**
 * Pull a session's stable id out of whatever record shape the DSH build hands back.
 * Session records have carried the id on the record, in `session.id`, and in
 * `header.id` across the 0.1.7–0.2.1 line, so all three are accepted.
 * @param {unknown} record - one session record.
 * @returns {{ id: string, cwd: string|undefined, createdAt: number|undefined }} normalized.
 */
export function sessionRecordOf(record) {
  const source = record !== null && typeof record === 'object' ? record : {}
  const header = source.header ?? source.session?.header ?? source.session ?? source
  const id = header?.id ?? source.id ?? source.sessionId
  return {
    id: id === undefined || id === null ? '' : String(id),
    cwd: typeof header?.cwd === 'string' ? header.cwd : (typeof source.cwd === 'string' ? source.cwd : undefined),
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
    // Forked and subagent sessions share the store but never belong in a picker of
    // conversations; the header is the only place that says so.
    parentSession: header?.parentSession ?? source.parentSession,
    origin: header?.origin ?? source.origin,
  }
}

/**
 * Normalize whatever a title lookup returns into an id -> title map.
 *
 * Two shapes cost this picker a round trip on 2026-10-22: `readTitleSnapshots` answers
 * with one PromiseSettledResult per id (`{sessionId, status, value:{session,title}}`),
 * and `title` there is a **title snapshot object** (`{title, messageSeqs, source,
 * eventSeq, updatedAt}`), not a string. Read both, so a snapshot is a label and a
 * displayable title is never mistaken for a missing one.
 * @param {unknown} value - the service's answer.
 * @returns {Map<string, string>} titles keyed by session id.
 */
export function titlesOf(value) {
  const titles = new Map()
  const textOf = (entry) => {
    if (typeof entry === 'string') return entry
    if (entry !== null && typeof entry === 'object' && typeof entry.title === 'string') return entry.title
    if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') return entry.text
    return undefined
  }
  const add = (id, title) => {
    const text = textOf(title)
    if (id !== undefined && id !== null && typeof text === 'string' && text !== '') titles.set(String(id), text)
  }
  if (value instanceof Map) {
    for (const [id, entry] of value) add(id, typeof entry === 'string' ? entry : (entry?.title ?? entry?.value?.title))
    return titles
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry === null || entry === undefined) continue
      if (entry.status !== undefined) {
        if (entry.status !== 'fulfilled') continue
        // `projectMany` answers `{sessionId, status, value:{session,title?}}`: the id sits
        // on the wrapper, which is the field the first version missed.
        const settled = entry.value
        add(entry.sessionId ?? settled?.session?.id ?? settled?.id, settled?.title ?? settled?.snapshot?.title)
        continue
      }
      add(entry.id ?? entry.sessionId ?? entry.session?.id ?? entry.header?.id,
        typeof entry === 'string' ? entry : (entry.title ?? entry.snapshot?.title))
    }
    return titles
  }
  if (value !== null && typeof value === 'object') {
    for (const [id, entry] of Object.entries(value)) add(id, typeof entry === 'string' ? entry : entry?.title)
  }
  return titles
}

/**
 * The first thing the user said in a session, as a short label for a conversation whose
 * title was never generated. Raw surface events are scanned for a `user/message` whose
 * source is the user (runtime-context and skill reminders are not names).
 * @param {unknown} events - `readSurface().events`.
 * @returns {string} a trimmed one-line snippet, or '' when there is none.
 */
export function firstUserLine(events) {
  if (!Array.isArray(events)) return ''
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const source = event?.data?.source
    if (source !== undefined && source !== null && source.kind !== 'user') continue
    const content = event?.data?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const line = block.text.replace(/\s+/g, ' ').trim()
      if (line === '') continue
      return line.length > 28 ? `${line.slice(0, 28)}…` : line
    }
  }
  return ''
}

/**
 * Create the WSL channel for one plugin mount.
 *
 * @param {object} options - wiring.
 * @param {object} options.ctx - host context (services are looked up lazily through `get`).
 * @param {object} options.config - resolved plugin config.
 * @param {(argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} [options.wsl]
 *   runs `wsl.exe` with argv, used to discover the host address WSL reaches and to install
 *   the shim. Absent in tests, where the channel binds loopback and reports that.
 * @param {NodeJS.ProcessEnv} [options.env] - environment (profile directory).
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {object|null} [options.transport] - the terminal transport, used to read the screen of
 *   the terminal a prompt was typed in (read-only, best effort).
 * @returns {object} the channel handle.
 */
export function createChannel({ ctx, config, wsl = undefined, transport = null, env = process.env, now = Date.now } = {}) {
  const token = randomBytes(32).toString('hex')
  const stateFile = channelStateFile(env)
  /** @type {import('node:http').Server | null} */
  let server = null
  let port = 0
  let host = '127.0.0.1'
  let startedAt = null
  let stopped = false
  /** The plugin is being torn down: a destroyed stream there is not a user interrupt. */
  let stopping = false

  /** Live streaming responses: `stop()` drops them so a plugin unmount never waits for a turn. */
  const inflight = new Set()
  /** Sessions a `/say` stream is already waiting for; a second terminal would cross-talk. */
  const waitingSessions = new Set()
  /**
   * Sessions interrupted from the terminal a moment ago: `interrupt` is asynchronous, and while
   * the cancelled turn tears down the Agent is still reported as `running`. A prompt sent in that
   * window (the person presses Ctrl+C and types the next thing immediately) must NOT steer into
   * the dying turn — it would be swallowed and the terminal would show a zero-step "aborted"
   * completion. Start a queue turn instead until the session has settled.
   */
  const cancelledAt = new Map()
  const CANCEL_SETTLE_MS = 3_000
  /** Disposer for the rows-cache invalidation listener, removed on stop(). */
  let offCacheEvents = null

  const enabled = () => config?.channelEnabled === true
  const sessionId = () => channelSessionOf(config)

  /**
   * The session a prompt without an explicit header lands in: the configured one, or — when
   * none is configured — the most recently active conversation, which is the one the client
   * is showing. Nothing new is created: the terminal is a second surface for that chat.
   * @returns {Promise<string>} a session id, or '' when no session service is available.
   */
  async function resolveTarget() {
    const fixed = sessionId()
    if (fixed !== '') return fixed
    const controller = service('sessionController')
    if (controller === undefined || typeof controller.list !== 'function') return ''
    try {
      const answer = await controller.list(undefined, undefined)
      const items = Array.isArray(answer) ? answer : (Array.isArray(answer?.items) ? answer.items : [])
      for (const item of items) {
        const id = String(item?.sessionId ?? '')
        if (id !== '' && item?.parentSessionId === undefined && item?.origin !== 'subagent') return id
      }
    } catch {
      /* no fallback session */
    }
    return ''
  }

  /** Look a host service up without ever throwing. */
  const service = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Stop the turn that this terminal was waiting for. Ctrl+C means "stop", not "keep running in
   * the background", so the client's turn is cancelled with the same `cancel` the client's own
   * stop button uses. Fire-and-forget and defensive: a stale/absent session or a rejecting
   * cancel must never crash the channel or leave an unhandled rejection. Callers skip this
   * while the plugin is being torn down (see `stopping`), because that would kill a user's turn.
   * @param {string} session - the session this stream targeted.
   */
  const cancelTurn = (session) => {
    const controller = service('sessionController')
    if (controller === undefined || controller === null || typeof controller.cancel !== 'function') return
    // Remember the moment: the next prompt in this window starts a fresh queue turn instead of
    // steering into the turn that is still tearing down (see `cancelledAt`).
    cancelledAt.set(String(session), now())
    try {
      const result = controller.cancel({ sessionId: session })
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.then(() => { /* cancelled */ }, () => { /* the turn already ended */ })
      }
      try {
        console.info(`dsh-wsl-tool: the terminal interrupted session ${session}; cancelled that turn`)
      } catch {
        /* logging must not be a failure mode */
      }
    } catch {
      /* not attached any more: nothing to cancel, and that is not an error for the channel */
    }
  }

  /** Write the state file the `dsh` shim reads. Best effort: a read-only profile is not fatal. */
  const publishState = () => {
    const text = JSON.stringify({
      version: 2,
      port,
      token,
      host,
      enabled: enabled(),
      sessionId: sessionId(),
      startedAt,
    }, null, 2) + '\n'
    const temporary = `${stateFile}.tmp`
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      // A shim can read this file at any instant; a truncate-then-write leaves a window where
      // it sees the token but no port. Write beside it, then move it into place.
      writeFileSync(temporary, text, 'utf8')
      try {
        renameSync(temporary, stateFile)
      } catch {
        // Windows refuses to replace a file a reader has open for a moment; fall back to
        // the in-place write rather than leaving the shim with a stale port.
        writeFileSync(stateFile, text, 'utf8')
        try { rmSync(temporary, { force: true }) } catch { /* ignore */ }
      }
    } catch {
      try { rmSync(temporary, { force: true }) } catch { /* ignore */ }
      /* the shim reports "run DSH first" on its own */
    }
  }

  /**
   * Remove the state file on a clean unmount, so a dead port is not advertised — but only
   * when the file still describes THIS channel. A settings write can rebuild the plugin
   * while the previous instance is still alive; its stop() used to delete the file the new
   * instance had just published, and every terminal command then reported "no channel config".
   */
  const unpublishState = () => {
    try {
      const stored = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (typeof stored?.token === 'string' && stored.token !== token) return
    } catch {
      /* unreadable or absent: removing is harmless */
    }
    try { rmSync(stateFile, { force: true }) } catch { /* ignore */ }
  }

  /**
   * The address WSL uses for this machine: its default gateway. Under WSL2 NAT that is the
   * host's WSL adapter, which is exactly where this server should listen.
   * @returns {Promise<string|null>} the address, or null when WSL cannot be asked.
   */
  const discoverHostAddress = async () => {
    if (typeof wsl !== 'function') return null
    try {
      const result = await wsl(['-e', 'sh', '-c', "ip -4 route show default 2>/dev/null | awk '{print $3; exit}'"])
      const address = String(result?.stdout ?? '').trim()
      return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) ? address : null
    } catch {
      return null
    }
  }

  // ------------------------------------------------------ the terminal's own history
  //
  // The `dsh` command runs inside one of the user's sidebar terminals, and the PAGE holds that
  // terminal's scrollback — this process never sees it. The scrollback must NOT be pasted into
  // the conversation (the owner called that out twice): instead the Host keeps a bounded copy
  // here, and `index.js` hands it to the model as a hidden system-prompt CONTEXT for the next
  // request. The transcript stays the person's own words; the model gets the context anyway.
  //
  // The terminal is identified by the command line the prompt shows on screen. There is no
  // per-session cache of which terminal that is: one conversation can have several user
  // terminals, and a remembered id would hand a later prompt the terminal it did not come from.
  const HISTORY_BUDGET_MS = 3000
  const HISTORY_PER_ATTACH_MS = 1500
  const HISTORY_LINES = 100
  const HISTORY_CHARS = 10000
  /** How long a captured terminal context stays available to the next request. */
  const HISTORY_CONTEXT_TTL_MS = 5 * 60 * 1000
  /** session id -> the model-only terminal context captured for its next request. */
  const terminalContexts = new Map()

  /**
   * One read-only screen snapshot: attach, take the first snapshot, let go.
   * @returns {Promise<{ screen: string|null, failed: boolean }>} the screen, and whether the
   * attach itself failed (the panel reports that differently from "the screen had no match").
   */
  async function readTerminalScreen(agent, terminalId, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const frames = transport.follow(agent, terminalId, `dsh-wsl-history-${randomUUID()}`, controller.signal)
      for await (const frame of frames) {
        if (frame?.type === 'snapshot' && typeof frame.screen === 'string') return { screen: frame.screen, failed: false }
      }
      return { screen: null, failed: false }
    } catch {
      return { screen: null, failed: true }
    } finally {
      clearTimeout(timer)
      // Closing the iterator above already detaches; the abort covers a frame that never came.
      controller.abort()
    }
  }

  /**
   * The last capture attempt, for the panel: "the model got no history" has several causes and
   * they need different answers ("nobody was looking" is not "the screen never showed the
   * command"). Bounded on purpose — one attempt, counters, nothing retained.
   */
  const historyLast = {
    at: 0, route: '', sessionId: '', reason: 'none', terminalId: '', candidates: 0, attaches: 0, snapshots: 0, ms: 0, lines: 0,
  }
  const historyCounts = { attempts: 0, captured: 0 }

  /**
   * Record one capture attempt.
   * @param {string} route - the route that asked: 'say' or 'insert'.
   * @param {string} sessionId - the session the prompt is going to.
   * @param {string} reason - 'ok' or the name of the step that said no.
   * @param {object} [extra] - terminalId, candidates, attaches, snapshots, lines, elapsed ms.
   * @returns {void}
   */
  function noteHistory(route, sessionId, reason, extra = {}) {
    historyCounts.attempts += 1
    if (reason === 'ok') historyCounts.captured += 1
    historyLast.at = now()
    historyLast.route = String(route)
    historyLast.sessionId = String(sessionId ?? '')
    historyLast.reason = String(reason)
    historyLast.terminalId = String(extra.terminalId ?? '')
    historyLast.candidates = Number(extra.candidates ?? 0) || 0
    historyLast.attaches = Number(extra.attaches ?? 0) || 0
    historyLast.snapshots = Number(extra.snapshots ?? 0) || 0
    historyLast.ms = Number(extra.ms ?? 0) || 0
    historyLast.lines = Number(extra.lines ?? 0) || 0
  }

  /**
   * The screen of the user's terminal that shows `needle`.
   *
   * Never throws: every way of finding nothing is named, because the caller records the reason
   * for the panel instead of guessing.
   * @param {string} sessionId - session whose user terminals are candidates.
   * @param {string} needle - a run of text that only that terminal's screen carries.
   * @returns {Promise<{ reason: string, screen?: string, at?: number, terminalId?: string, candidates: number, attaches: number, snapshots: number }>} screen + match, or why there is none.
   */
  async function findTerminalScreen(sessionId, needle) {
    const nothing = (reason, extra = {}) => ({ reason, candidates: 0, attaches: 0, snapshots: 0, ...extra })
    if (transport === null || transport === undefined) return nothing('no-transport')
    if (typeof transport.userTerminals !== 'function' || typeof transport.follow !== 'function') return nothing('no-transport')
    const agents = service('agents')
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined) return nothing('no-agent')
    const deadline = now() + HISTORY_BUDGET_MS
    let infos
    try {
      infos = await transport.userTerminals(sessionId)
    } catch {
      return nothing('no-terminals')
    }
    if (!Array.isArray(infos) || infos.length === 0) return nothing('no-terminals')
    const candidates = infos.length
    let attaches = 0
    let snapshots = 0
    let attachFailures = 0
    let best = null
    for (const info of infos.slice(0, 4)) {
      const remaining = deadline - now()
      if (remaining < 200) break
      const terminalId = String(info?.id ?? '')
      if (terminalId === '') continue
      attaches += 1
      const read = await readTerminalScreen(agent, terminalId, Math.min(remaining, HISTORY_PER_ATTACH_MS))
      if (read.failed) attachFailures += 1
      if (read.screen === null) continue
      snapshots += 1
      const at = read.screen.lastIndexOf(needle)
      if (at === -1) continue
      if (best === null || at > best.at) best = { at, screen: read.screen, terminalId }
    }
    if (best === null) {
      // A failed attach, a snapshot that never arrived, and a screen that does not carry the
      // command are three different problems: the bridge, the bridge's timing, and the wrong
      // terminal (or a screen that was cleared).
      let reason = 'no-match'
      if (attaches === 0) reason = 'no-attach-budget'
      else if (snapshots === 0) reason = attachFailures > 0 ? 'attach-failed' : 'no-snapshot'
      return nothing(reason, { candidates, attaches, snapshots })
    }
    return { reason: 'ok', ...best, candidates, attaches, snapshots }
  }

  /**
   * The tail of a screen, before `until` when given, stripped of control sequences.
   * @param {string} screen - raw screen text.
   * @param {number} [until] - keep only what is before this index.
   * @param {number} maxLines - line cap.
   * @param {number} maxChars - character cap.
   * @returns {string} the text ('' when nothing is left).
   */
  function screenTail(screen, until, maxLines, maxChars) {
    const body = until === undefined ? screen : screen.slice(0, until)
    const lines = stripAnsi(body)
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    let text = lines.slice(-maxLines).join('\n')
    if (text.length > maxChars) text = text.slice(-maxChars)
    return text.trim()
  }

  /**
   * Capture the sending terminal's screen for the model, WITHOUT putting it in the message.
   *
   * The returned text is stored per session and read by the `system-prompt` context registered
   * in `index.js`: the model sees it as hidden runtime context at its next request, the person
   * sees only the message they typed.
   *
   * Both ways a person can send from the terminal use this — `/say` (the turn) and `/insert`
   * (the Enter-insert that talks into a running turn). Leaving `/insert` out lost the history
   * of exactly the messages a person types mid-turn.
   * @param {string} sessionId - the session the prompt is going to.
   * @param {string} prompt - the text the person typed (the screen shows it).
   * @param {string} [route] - which route asked: 'say' or 'insert'.
   * @returns {Promise<boolean>} whether a context was captured.
   */
  async function captureTerminalContext(sessionId, prompt, route = 'say') {
    const started = now()
    const needle = prompt.trim().slice(0, 24)
    // Two characters is enough to find the line the person typed — and it has to be, because
    // the prompts typed at a shell are often short ("继续", "test"). A one-character prompt is
    // too ambiguous to attribute to one terminal, so it captures nothing.
    if (needle.length < 2) {
      noteHistory(route, sessionId, 'needle-too-short', { ms: now() - started })
      return false
    }
    const found = await findTerminalScreen(sessionId, needle)
    const foundExtra = {
      terminalId: found.terminalId,
      candidates: found.candidates,
      attaches: found.attaches,
      snapshots: found.snapshots,
      ms: now() - started,
    }
    if (found.reason !== 'ok') {
      noteHistory(route, sessionId, found.reason, foundExtra)
      return false
    }
    // Cut at the start of the line that carries the needle: the half-typed `dsh "…"` echo is not
    // part of what the person is asking about.
    const lineStart = found.screen.lastIndexOf('\n', found.at - 1)
    const until = lineStart === -1 ? found.at : lineStart
    const body = screenTail(found.screen, until, HISTORY_LINES, HISTORY_CHARS)
    if (body === '') {
      noteHistory(route, sessionId, 'empty-screen', foundExtra)
      return false
    }
    terminalContexts.set(String(sessionId), {
      at: now(),
      text: '【终端历史】以下是这个终端在我回复这条消息之前的屏幕内容（只读快照，最多 '
        + `${HISTORY_LINES} 行；如需更多可调用 wsl-term 的 read 动作，id=${found.terminalId}）：\n`
        + `${body}\n【终端历史结束】`,
    })
    noteHistory(route, sessionId, 'ok', { ...foundExtra, lines: body.split('\n').length })
    return true
  }

  /**
   * The captured context for one session, if still fresh. Consumed by the prompt assembly.
   * @param {string} sessionId - session to look up.
   * @returns {string} the context text, or ''.
   */
  function terminalContextFor(sessionId) {
    const entry = terminalContexts.get(String(sessionId ?? ''))
    if (entry === undefined) return ''
    if (now() - entry.at > HISTORY_CONTEXT_TTL_MS) {
      terminalContexts.delete(String(sessionId ?? ''))
      return ''
    }
    return entry.text
  }

  /**
   * Forget one session's captured context (called right after a request assembled it).
   * @param {string} sessionId - session whose context was just used.
   */
  function consumeTerminalContext(sessionId) {
    terminalContexts.delete(String(sessionId ?? ''))
  }

  /**
   * The last hidden-context attempt and its counters, for the panel's channel block.
   * Answers "did the model get the screen, and if not, which step said no" without a log dive.
   * @returns {object} last attempt, attempts, captured, and how many contexts wait for a request.
   */
  function historyState() {
    return {
      ...historyLast,
      attempts: historyCounts.attempts,
      captured: historyCounts.captured,
      pending: terminalContexts.size,
    }
  }

  // ---------------------------------------------------------------- say (the turn)

  /**
   * Run one prompt through the client's own session controller and stream the turn.
   * @param {import('node:http').IncomingMessage} request - the client request.
   * @param {import('node:http').ServerResponse} response - the streaming response.
   * @param {string} prompt - the user text.
   */
  async function say(request, response, prompt) {
    if (enabled() === false) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const text = prompt.trim()
    if (text === '') return answerLine(response, 400, 'err\tempty prompt')
    // Every message that arrives through the terminal carries this marker in the conversation:
    // the owner asked to be able to tell terminal messages from client ones at a glance.
    const marked = SAY_PREFIX + text

    const controller = service('sessionController')
    const headerSession = String(request.headers['x-dsh-wsl-session'] ?? '').trim()
    const target = headerSession !== '' ? headerSession : await resolveTarget()
    if (target === '') {
      return answerLine(response, 501, 'err\t没有可用的会话：这个 DSH 没有提供 sessionController，或新建会话失败')
    }
    // Self-lock: a tool call running inside session X asks the terminal to send a prompt to X.
    // The prompt would join X's live turn, but that turn can only end after this very command
    // returns — so say why it cannot run instead of hanging until the deadline. The shim passes
    // its caller through `x-dsh-wsl-caller`; a person typing `dsh` has no caller and is not
    // affected (waiting at the terminal is the normal chat flow).
    const callerSession = String(request.headers['x-dsh-wsl-caller'] ?? '').trim()
    if (callerSession !== '' && callerSession === target) {
      return answerLine(
        response,
        409,
        'err\t无法执行：目标会话正在等待这条命令的返回（这条命令本身属于它正在跑的这一轮）。'
        + '发出去会自锁——这一轮要等命令结束，命令要等这一轮结束。'
        + '请直接在客户端里输入，或等这一轮结束后再从终端发。',
      )
    }
    if (controller === undefined || typeof controller.prompt !== 'function') {
      return answerLine(response, 501, 'err\tthis DSH build does not expose sessionController.prompt')
    }
    // One waiting terminal per conversation. Two `/say` streams to the same session would both
    // subscribe to the same event feed and each print the combined answer (the frames carry no
    // per-request turn id), so the second one is refused instead of cross-talked. `/insert` is
    // deliberately exempt: it is the route the in-terminal Enter (steer) uses to talk into a
    // conversation that is already waiting.
    if (waitingSessions.has(target)) {
      return answerLine(response, 409, 'err\t该会话已有终端在等回复：等它结束，或在那个终端里按回车插话')
    }

    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    const t0 = now()
    const requestId = randomUUID()
    const abort = new AbortController()
    let finished = false
    let steps = 0
    let reasonStarted = false
    let textStarted = false
    // A turn can run many steps: each assistant/message carries that step's usage, so the end
    // frame reports the SUM. The live stream's usage frame is only the current step's progress
    // and the fallback when no message-level usage was ever reported.
    let streamUsage = { inputTokens: 0, outputTokens: 0 }
    let totalUsage = { inputTokens: 0, outputTokens: 0 }
    let heartbeat = null
    let deadline = null
    let flushTimer = null
    let pendingText = ''
    let offFrames = null
    let offEvents = null
    inflight.add(response)
    waitingSessions.add(target)

    /** Frames are line-based and the shim forks a decoder per `~a`: coalesce text deltas. */
    const FLUSH_MS = 30
    const FLUSH_CHARS = 8 * 1024
    const flushText = () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (pendingText === '') return
      const text = pendingText
      pendingText = ''
      write(chunkLine('a', text))
    }
    const queueText = (text) => {
      pendingText += text
      if (pendingText.length >= FLUSH_CHARS) {
        flushText()
        return
      }
      if (flushTimer !== null) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        flushText()
      }, FLUSH_MS)
      if (typeof flushTimer.unref === 'function') flushTimer.unref()
    }

    /** Release everything this stream owns. Runs once: finish(), the response close, or stop(). */
    const cleanup = () => {
      if (heartbeat !== null) clearInterval(heartbeat)
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      // The turn ceiling is one per stream: leaving it armed kept a 4-hour timer (and this
      // whole closure) alive for every completed turn.
      if (deadline !== null) clearTimeout(deadline)
      try { offFrames?.() } catch { /* ignore */ }
      try { offEvents?.() } catch { /* ignore */ }
      try { response.off('close', onClose) } catch { /* ignore */ }
      inflight.delete(response)
      waitingSessions.delete(target)
    }

    const write = (line) => {
      if (finished) return
      try { response.write(line + '\n') } catch { /* client went away */ }
    }
    const finish = (ok, reason) => {
      if (finished) return
      // Whatever text is still buffered is part of the answer: flush it before the end frame.
      flushText()
      finished = true
      cleanup()
      const reported = totalUsage.inputTokens > 0 || totalUsage.outputTokens > 0 ? totalUsage : streamUsage
      // The final frame bypasses `write`: that helper refuses to write once the turn is
      // marked finished, and this is the one line that must still go out.
      try {
        response.write(`~e ${ok ? '1' : '0'} ${now() - t0} ${steps} ${reported.inputTokens} ${reported.outputTokens} ${Buffer.from(String(reason), 'utf8').toString('base64')}\n`)
      } catch { /* client went away */ }
      try { response.end() } catch { /* ignore */ }
    }

    write('~ack')
    // Forward, do not queue. A conversation that is already answering receives this line
    // into its live turn (steer), so the same agent can react immediately; an idle one gets
    // a normal prompt that starts right away.
    let running = false
    try {
      running = service('agents')?.get?.(target)?.status === 'running'
    } catch {
      running = false
    }
    // A turn cancelled from this terminal a moment ago still reads as `running` while it tears
    // down. Steering into it silently loses the prompt (the terminal shows a zero-step
    // "aborted" completion), so this window starts a queue turn instead.
    const justCancelled = (now() - (cancelledAt.get(target) ?? 0)) < CANCEL_SETTLE_MS
    if (justCancelled) running = false
    heartbeat = setInterval(() => write('~p'), HEARTBEAT_MS)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    // The sending terminal's screen is captured for the MODEL ONLY: `index.js` registers a
    // system-prompt context that hands it to the next request, so the transcript stays the
    // person's own words while the model still sees what they were looking at. A tool-invoked
    // prompt (caller session set) is not typed at a screen, so it gets nothing.
    if (callerSession === '') {
      try {
        await captureTerminalContext(target, text, 'say')
      } catch {
        // Best effort: a terminal that cannot be read must not change how the prompt arrives.
      }
    }
    // The conversation message itself is exactly what the person typed (with the terminal
    // marker); the screen went into the hidden context above.
    const promptText = marked

    // Frame feed: the provider's live assistant stream, the same source the GUI paints.
    offFrames = ctx?.on?.('agent/assistant-stream', ({ agent, frame }) => {
      if (finished) return
      if (agent?.session?.id !== target || frame === undefined || frame === null) return
      if (frame.type === 'start') return
      if (frame.type === 'end') return
      const chunk = frame.chunk
      if (chunk === undefined || chunk === null) return
      if (chunk.type === 'reasoning-delta') {
        // The terminal shows that the model is thinking and how long it took, but not the
        // reasoning text itself — that stays in the client transcript.
        if (!reasonStarted) {
          reasonStarted = true
          write(`~r ${now() - t0}`)
        }
        return
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        if (!textStarted) {
          textStarted = true
          write(`~t ${now() - t0}`)
        }
        queueText(chunk.text)
        return
      }
      if (chunk.type === 'usage' && typeof chunk.usage === 'object' && chunk.usage !== null) {
        streamUsage = {
          inputTokens: Number(chunk.usage.inputTokens ?? streamUsage.inputTokens) || 0,
          outputTokens: Number(chunk.usage.outputTokens ?? streamUsage.outputTokens) || 0,
        }
      }
    }, { global: true })

    // Durable event feed: step boundaries and the turn's end are only reliable here.
    offEvents = ctx?.on?.('session/event', (session, event) => {
      if (finished) return
      if (session?.id !== target || event === undefined || event === null) return
      if (event.type === 'step/start') {
        steps += 1
        write(`~step ${String(event.data?.turn ?? '?')} ${String(event.data?.step ?? '?')}`)
        return
      }
      if (event.type === 'assistant/message') {
        const eventUsage = event.data?.usage
        if (eventUsage !== undefined && eventUsage !== null) {
          totalUsage = {
            inputTokens: totalUsage.inputTokens + (Number(eventUsage.inputTokens) || 0),
            outputTokens: totalUsage.outputTokens + (Number(eventUsage.outputTokens) || 0),
          }
        }
        return
      }
      if (event.type === 'turn/end') {
        finish(true, event.data?.reason?.kind ?? 'completed')
      }
    })

    // A disconnect is visible on the RESPONSE, not the request: Node emits the request's
    // `close` as soon as the body has been read (before this listener could exist), so the
    // old `request.on('close')` hook never fired. Ctrl+C means "stop": the client's turn is
    // cancelled as well, unless this channel is just being torn down by the plugin.
    const onClose = () => {
      if (finished) return
      abort.abort()
      if (!stopping) cancelTurn(target)
      finished = true
      cleanup()
    }
    response.on('close', onClose)
    // The terminal may already be gone by the time the listener exists.
    if (response.destroyed) onClose()

    deadline = setTimeout(() => {
      if (finished) return
      write(errorLine('turn exceeded the channel ceiling'))
      finish(false, 'timeout')
    }, MAX_TURN_MS)
    if (typeof deadline.unref === 'function') deadline.unref()

    try {
      // The exact admission path the browser uses: it resumes the Session when it is cold,
      // validates attachments, and records the message with the user-rpc source.
      try {
        await controller.prompt({
          sessionId: target,
          content: [{ type: 'text', text: promptText }],
          // steer = delivered into the turn that is already running; queue = start now.
          mode: running ? 'steer' : 'queue',
          requestId,
        }, abort.signal)
      } catch (error) {
        // A cancelled turn can still refuse the fresh queue while it is finishing; the person
        // is typing at a terminal, so give it a moment and admit it once more.
        if (!justCancelled || finished || abort.signal.aborted) throw error
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (finished || abort.signal.aborted) return
        await controller.prompt({
          sessionId: target,
          content: [{ type: 'text', text: promptText }],
          mode: 'queue',
          requestId: randomUUID(),
        }, abort.signal)
      }
    } catch (error) {
      const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
      if (!finished) {
        write(errorLine(message))
        finish(false, 'error')
      }
    }
  }

  // ---------------------------------------------------------------- insert (no wait)

  /**
   * Deliver one prompt WITHOUT waiting for its turn.
   *
   * `/say` is the chat form: it streams until `turn/end`. That is wrong for exactly one caller —
   * a tool call running inside the conversation it writes into: the prompt joins that live turn,
   * and the turn can only end after the tool call returns, so the command would wait on itself
   * (the self-lock `/say` now refuses by name). This route is the supported way to put a message
   * into a conversation and get control back immediately (steer when it is running, queue when
   * idle); the text appears in the conversation, which is where the caller reads it.
   */
  async function insert(request, response, prompt) {
    if (enabled() === false) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const text = String(prompt ?? '').trim()
    if (text === '') return answerLine(response, 400, 'err\tempty prompt')
    // The inserted message carries the same terminal marker as `/say`'s prompts.
    const marked = SAY_PREFIX + text
    const controller = service('sessionController')
    if (controller === undefined || typeof controller.prompt !== 'function') {
      return answerLine(response, 501, 'err\tthis DSH build does not expose sessionController.prompt')
    }
    const headerSession = String(request.headers['x-dsh-wsl-session'] ?? '').trim()
    const target = headerSession !== '' ? headerSession : await resolveTarget()
    if (target === '') {
      return answerLine(response, 501, 'err\t没有可用的会话：这个 DSH 没有提供 sessionController，或新建会话失败')
    }
    let running = false
    try {
      running = service('agents')?.get?.(target)?.status === 'running'
    } catch {
      running = false
    }
    // The Enter-insert path is the person typing at their own terminal, so the screen goes to
    // the model's hidden context exactly like `/say`'s does. A tool-invoked insert (caller set)
    // is not typed at a screen and gets nothing, the same rule `/say` follows.
    const callerSession = String(request.headers['x-dsh-wsl-caller'] ?? '').trim()
    if (callerSession === '') {
      try {
        await captureTerminalContext(target, text, 'insert')
      } catch {
        // Best effort: the insert must arrive whether or not the screen could be read.
      }
    }
    try {
      // `prompt` requires an AbortSignal; nothing here aborts, so the answer (a message in the
      // conversation) is not tied to this HTTP request.
      await controller.prompt({
        sessionId: target,
        content: [{ type: 'text', text: marked }],
        mode: running ? 'steer' : 'queue',
        requestId: randomUUID(),
      }, new AbortController().signal)
    } catch (error) {
      const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
      return answerLine(response, 500, `err\t${message}`)
    }
    return answerLine(response, 200, `ok\t${running ? 'inserted' : 'queued'}\t${target}`)
  }

  // ------------------------------------------------------------ management routes

  /**
   * Titles the desktop already computed, read from its own projection cache. This is a
   * fallback source only: if `readTitleSnapshots` comes back empty (it did on 2026-10-22,
   * which emptied the whole picker), these labels still let the user recognise a
   * conversation. Best effort — a missing or changed cache file just adds nothing.
   * @returns {Map<string, string>} id -> title.
   */
  function projectionTitles() {
    const titles = new Map()
    try {
      const home = env.USERPROFILE || env.HOME
      if (typeof home !== 'string' || home === '') return titles
      const file = join(home, '.dsh', 'storages', 'session_projcache.json')
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const table = parsed?.tables?.sessions
      if (table === null || typeof table !== 'object') return titles
      for (const [id, session] of Object.entries(table)) {
        const title = session?.rows?.title?.val
        if (typeof title === 'string' && title !== '') titles.set(String(id), title)
      }
    } catch {
      /* absent cache: no fallback titles */
    }
    return titles
  }

  // A first message is a fallback label; reading a session's surface is the expensive part of
  // an untitled row, and that sentence does not change, so remember it across refreshes. This
  // map lives at channel scope on purpose: a per-refresh map could never hit (the ids of one
  // refresh are unique) and every `/list` refresh re-read every untitled session again.
  const firstLineCache = new Map()

  /**
   * The sessions the panel's picker offers and the CLI's `list` prints: the registered
   * workspace's own top-level, unarchived conversations, newest first, capped at 12, with
   * the configured session marked. Membership in the workspace is the filter that matters
   * — `listSessions()` also carries subagent runs, the IM inbox and other store entries,
   * and a title is only a label (never a requirement, or a title-lookup fault would empty
   * the whole list).
   * @returns {Promise<{ rows: Array<{ id: string, title: string, cwd: string, workspace: string, createdAt: number|null, current: boolean }>, meta: { records: number, members: number, titled: number } }>} rows and counts.
   */
  async function sessionRowsUncached(currentOverride = '') {
    const meta = { records: 0, members: 0, titled: 0, source: 'query' }
    const controller = service('sessionController')
    const query = service('sessionQuery')
    // Workspace membership is the same accounting the client sidebar uses; a title is only
    // a label, never a requirement for being listed (a title-lookup fault must not empty it).
    const registry = service('workspaceRegistry')
    let archived = new Set()
    const workspaceOf = new Map()
    try {
      const ids = registry?.archivedSessionIds
      archived = new Set((Array.isArray(ids) ? ids : []).map(String))
      const workspaces = typeof registry?.list === 'function' ? registry.list() : []
      for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
        const label = typeof workspace?.title === 'string' && workspace.title !== ''
          ? workspace.title
          : (typeof workspace?.path === 'string' ? workspace.path : '')
        for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) workspaceOf.set(String(id), label)
      }
    } catch {
      archived = new Set()
    }
    meta.members = workspaceOf.size
    // The terminal's own current session wins over the panel's configured landing: `dsh use`
    // switches what the CLI talks to, so `dsh list` must mark that one.
    const current = currentOverride !== '' ? currentOverride : sessionId()
    const wanted = (id, parentSession, origin) => {
      if (id === '') return false
      if (parentSession !== undefined && parentSession !== null) return false
      if (origin === 'subagent') return false
      if (archived.has(id)) return false
      // With a readable registry it is authoritative; without it, any top-level conversation.
      return workspaceOf.size === 0 || workspaceOf.has(id)
    }
    const pick = (candidates) => {
      const picked = candidates.slice(0, 12)
      // The configured session stays visible even when it is not among the newest 12 — it is
      // the one dsh will use; a phantom row for an id that does not exist would be worse.
      // The row stays within the documented cap: the twelfth newest drops out instead.
      if (current !== '' && !picked.some((item) => item.id === current)) {
        const live = candidates.find((item) => item.id === current)
        if (live !== undefined) {
          picked.unshift(live)
          if (picked.length > 12) picked.pop()
        }
      }
      return picked
    }
    const titlesFor = async (ids) => {
      let titles = new Map()
      try {
        if (typeof query?.readTitleSnapshots === 'function') {
          titles = titlesOf(await query.readTitleSnapshots(ids, undefined))
        }
      } catch {
        titles = new Map()
      }
      if (titles.size === 0) titles = projectionTitles()
      else for (const [id, title] of projectionTitles()) if (!titles.has(id)) titles.set(id, title)
      // A conversation with no generated title still has a first message; that sentence is a
      // far better label than an id. One extra read per still-untitled row, bounded to the list.
      if (typeof query?.readSurface === 'function') {
        for (const id of ids) {
          if (titles.has(id)) continue
          const cached = firstLineCache.get(id)
          if (cached !== undefined && Date.now() - cached.at < 600_000) {
            titles.set(id, cached.text)
            continue
          }
          try {
            const label = firstUserLine((await query.readSurface(id))?.events)
            if (label !== '') {
              titles.set(id, label)
              firstLineCache.set(id, { text: label, at: Date.now() })
            }
          } catch {
            /* no label for this row */
          }
        }
      }
      return titles
    }
    // Preferred source: the client's own list. It is already ordered by activity
    // (updatedAt = max(createdAt, sessionListMetadata.lastPromptAt)) and carries the title
    // projection — literally the same rows the sidebar shows.
    if (controller !== undefined && typeof controller.list === 'function') {
      try {
        // sessionController.list() is the Host API: it answers { items }, not an array.
        const answer = await controller.list(undefined, undefined)
        const items = Array.isArray(answer) ? answer : (Array.isArray(answer?.items) ? answer.items : [])
        meta.records = items.length
        // An empty controller list usually means the shape moved again; fall back to the raw
        // query instead of presenting an empty picker.
        if (items.length === 0 && query !== undefined) throw new Error('session list came back empty')
        const candidates = []
        for (const item of Array.isArray(items) ? items : []) {
          const id = String(item?.sessionId ?? '')
          if (!wanted(id, item?.parentSessionId, item?.origin)) continue
          candidates.push({
            id,
            cwd: typeof item?.cwd === 'string' ? item.cwd : '',
            activityAt: typeof item?.updatedAt === 'number' ? item.updatedAt : null,
            title: typeof item?.projections?.values?.title === 'string' ? item.projections.values.title : '',
          })
        }
        candidates.sort((left, right) => (Number(right.activityAt ?? 0) || 0) - (Number(left.activityAt ?? 0) || 0))
        const picked = pick(candidates)
        const labels = await titlesFor(picked.filter((item) => item.title === '').map((item) => item.id))
        const rows = picked.map((item) => ({
          id: item.id,
          title: item.title !== '' ? item.title : (labels.get(item.id) ?? ''),
          cwd: item.cwd,
          workspace: workspaceOf.get(item.id) ?? '',
          activityAt: item.activityAt,
          createdAt: null,
          current: item.id === current,
        }))
        meta.titled = rows.filter((row) => row.title !== '').length
        meta.source = 'controller'
        return { rows, meta }
      } catch {
        /* fall through to the raw query */
      }
    }
    if (query === undefined || typeof query.listSessions !== 'function') {
      return { rows: [], meta }
    }
    const records = (await query.listSessions(undefined))
      .map(sessionRecordOf)
      .filter((record) => record.id !== '')
    meta.records = records.length
    const candidates = records
      .filter((record) => wanted(record.id, record.parentSession, record.origin))
      .map((record) => ({
        id: record.id,
        cwd: record.cwd ?? '',
        activityAt: typeof record.createdAt === 'number' ? record.createdAt : null,
        createdAt: record.createdAt ?? null,
      }))
    const picked = pick(candidates)
    const labels = await titlesFor(picked.map((item) => item.id))
    const rows = picked.map((item) => ({
      id: item.id,
      title: labels.get(item.id) ?? '',
      cwd: item.cwd,
      workspace: workspaceOf.get(item.id) ?? '',
      activityAt: item.activityAt,
      createdAt: item.createdAt,
      current: item.id === current,
    }))
    meta.titled = rows.filter((row) => row.title !== '').length
    return { rows, meta }
  }

  /**
   * A cheap fingerprint of the facts the GUI changes when it creates, archives or restores a
   * conversation. `workspaceRegistry` is in memory, so comparing it costs no I/O and no title
   * lookups; a different fingerprint means the cached rows are stale for certain.
   * @returns {string} archived ids + each workspace's membership.
   */
  const workspaceSnapshot = () => {
    try {
      const registry = service('workspaceRegistry')
      const archived = Array.isArray(registry?.archivedSessionIds)
        ? registry.archivedSessionIds.map(String).join(',')
        : ''
      const workspaces = typeof registry?.list === 'function' ? registry.list() : []
      const members = (Array.isArray(workspaces) ? workspaces : []).map((workspace) => {
        const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.map(String).join(',') : ''
        return `${String(workspace?.id ?? workspace?.workspaceId ?? '')}:${ids}`
      })
      return `${archived}|${members.join(';')}`
    } catch {
      // No registry: fall back to the time-based refresh only.
      return ''
    }
  }

  /**
   * `dsh list` is a picker refresh, not a query: the rows only move when a conversation does,
   * and rebuilding them means title/workspace lookups plus a surface read per untitled row.
   * Serve the cached rows immediately and refresh them in the background, so the command is
   * never slower than the shell around it. The cache is dropped outright when the CLI creates
   * or archives, when a workspace's membership changes, and when a title is generated; the
   * short TTL covers everything else (an unobserved rename, a restored session).
   */
  const rowsCache = new Map()
  const rowsRefreshing = new Set()
  const rememberRows = (key, value) => {
    rowsCache.set(key, { at: Date.now(), value, snapshot: workspaceSnapshot() })
  }
  async function sessionRows(currentOverride = '') {
    const key = currentOverride !== '' ? currentOverride : sessionId()
    const hit = rowsCache.get(key)
    const snapshot = workspaceSnapshot()
    if (hit !== undefined && hit.snapshot === snapshot) {
      if (Date.now() - hit.at > ROWS_CACHE_TTL_MS && !rowsRefreshing.has(key)) {
        rowsRefreshing.add(key)
        sessionRowsUncached(currentOverride)
          .then((value) => rememberRows(key, value))
          .catch(() => { /* keep the rows already served */ })
          .finally(() => rowsRefreshing.delete(key))
      }
      return hit.value
    }
    // Unknown key or changed membership: pay for a rebuild now, so the very next `dsh list`
    // after a GUI-side create/archive is correct.
    const value = await sessionRowsUncached(currentOverride)
    rememberRows(key, value)
    return value
  }

  // Titles are generated in the background by the desktop; the rows carry them and nothing in
  // the workspace fingerprint moves, so the cache is dropped on that one event. Every other
  // session event (turn/step/token traffic) is ignored: clearing on those would undo the cache.
  if (typeof ctx?.on === 'function') {
    try {
      offCacheEvents = ctx.on('session/event', (session, event) => {
        if (event?.type === TITLE_EVENT) rowsCache.clear()
      })
    } catch {
      offCacheEvents = null
    }
  }

  /** List sessions ordered like the sidebar — by last activity, as tab-separated lines. */
  async function list(request, response) {
    if (!enabled()) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const controller = service('sessionController')
    const query = service('sessionQuery')
    const canList = (controller !== undefined && typeof controller.list === 'function')
      || (query !== undefined && typeof query.listSessions === 'function')
    if (!canList) {
      return answerLine(response, 501, 'err\tthis DSH build does not expose a session list')
    }
    const headerSession = String(request.headers['x-dsh-wsl-session'] ?? '').trim()
    const { rows } = await sessionRows(headerSession)
    // One row, five fixed columns: a title is model text and must not be able to inject a
    // tab or a newline into the TSV (which would shift fields or fabricate a `*` row).
    const lines = rows.map((row) => [
      tsvCell(row.id),
      tsvCell(row.title),
      tsvCell(row.cwd),
      tsvCell(row.activityAt ?? row.createdAt ?? ''),
      row.current ? '*' : '',
    ].join('\t'))
    return answerLine(response, 200, lines.length === 0 ? 'ok\t(no sessions)' : lines.join('\n'))
  }

  /**
   * Create one ordinary session in the client's workspace — the same call the CLI's
   * `new` and the panel's picker use, so both create exactly what the client lists.
   * @param {string} [requestedId] - explicit id, or '' to let DSH mint one.
   * @returns {Promise<{ ok: boolean, sessionId?: string, detail?: string }>} outcome.
   */
  async function createSession(requestedId = '') {
    const controller = service('sessionController')
    if (controller === undefined || typeof controller.create !== 'function') {
      return { ok: false, detail: 'this DSH build does not expose sessionController.create' }
    }
    const requested = typeof requestedId === 'string' ? requestedId.trim() : ''
    // An id travels through the line protocol, the TSV list and the per-terminal current file;
    // whitespace/control characters would split all three. Rejecting is safer than trimming.
    if (requested !== '' && !validSessionId(requested)) {
      return { ok: false, code: 'invalid', detail: 'session id must be 1-128 characters without whitespace or control characters' }
    }
    // Creating through a workspace is what attaches the session to the client's sidebar
    // and to this picker; a bare cwd would leave it unattached. Prefer the workspace that
    // was touched most recently, which is the one the user is working in.
    let workspaceId
    let cwd
    try {
      const registry = service('workspaceRegistry')
      const workspaces = typeof registry?.list === 'function' ? registry.list() : []
      const sorted = (Array.isArray(workspaces) ? workspaces : [])
        .slice()
        .sort((a, b) => (Number(b?.updatedAt ?? 0) || 0) - (Number(a?.updatedAt ?? 0) || 0))
      const newest = sorted[0]
      workspaceId = newest?.id ?? newest?.workspaceId
      if (typeof newest?.path === 'string') cwd = newest.path
    } catch {
      workspaceId = undefined
    }
    if (workspaceId === undefined) {
      try {
        const query = service('sessionQuery')
        const records = typeof query?.listSessions === 'function' ? (await query.listSessions(undefined)).map(sessionRecordOf) : []
        cwd = records[0]?.cwd
      } catch {
        cwd = undefined
      }
    }
    const created = await controller.create({
      ...(requested === '' ? {} : { sessionId: requested }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(workspaceId === undefined && typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    })
    const id = created?.sessionId ?? created?.agent?.id ?? requested
    return { ok: true, sessionId: id === undefined || id === null ? '' : String(id) }
  }

  /** Create one ordinary session in the client's workspace, optionally with a chosen id. */
  async function create(request, response, body) {
    if (!enabled()) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const result = await createSession(body)
    if (result.ok !== true) {
      return answerLine(response, result.code === 'invalid' ? 400 : 501, `err\t${result.detail ?? 'could not create a session'}`)
    }
    rowsCache.clear()
    return answerLine(response, 200, `ok\t${result.sessionId ?? '(unknown)'}`)
  }

  /** Archive one session (the client's own "remove" semantics: reversible). */
  async function archive(request, response, body) {
    if (!enabled()) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const target = body.trim()
    if (target === '') return answerLine(response, 400, 'err\tsession id required')
    if (!validSessionId(target)) {
      return answerLine(response, 400, 'err\tsession id must be 1-128 characters without whitespace or control characters')
    }
    const agents = service('agents')
    try {
      if (typeof agents?.get === 'function' && agents.get(target) !== undefined) {
        return answerLine(response, 409, `err\tsession "${target}" is open in DSH; close it first`)
      }
    } catch { /* treat as closed */ }
    const workspace = service('workspaceController')
    if (workspace === undefined || typeof workspace.archiveSession !== 'function') {
      return answerLine(response, 501, 'err\tthis DSH build does not expose workspaceController.archiveSession')
    }
    await workspace.archiveSession({ sessionId: target })
    rowsCache.clear()
    return answerLine(response, 200, `ok\t${target}`)
  }

  /**
   * The signed-in DeepSeek Platform wallet, for the terminal to print after a turn. The account
   * service is a Host-only consumer here, so the request is made host-side with the same client
   * identity headers the account panel sends; no credential ever reaches the shim.
   */
  async function balance(request, response) {
    if (!enabled()) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const account = service('deepseekAccount') ?? service('accountController')
    if (account === undefined || account === null || typeof account.getBalance !== 'function') {
      return answerLine(response, 501, 'err\tthis DSH build does not expose the DeepSeek account')
    }
    const client = {
      version: await harnessVersion(),
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
    let outcome
    try {
      outcome = await account.getBalance(client)
    } catch (error) {
      const detail = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
      return answerLine(response, 500, `err\t${detail}`)
    }
    // null = signed out or the grant changed; a failed read must never look like a zero balance.
    if (outcome === null || outcome === undefined) return answerLine(response, 200, 'ok\t未登录')
    if (outcome.status !== 'ready') return answerLine(response, 200, 'ok\t暂不可用')
    const wallets = walletText(outcome.value)
    // Nothing usable is not a zero balance: the account is signed in but the wallet rows are
    // empty or unreadable, so say "unavailable" rather than `¥0.00`.
    if (wallets === '') return answerLine(response, 200, 'ok\t暂不可用')
    // A zero bonus wallet is common (the grant exists but is spent): printing `赠金 <¥0.01`
    // would read as a fraction of a cent instead of "no bonus".
    const bonusWallets = (Array.isArray(outcome.bonusWallets) ? outcome.bonusWallets : [])
      .filter((wallet) => Number(wallet?.balance) > 0)
    const bonus = walletText(bonusWallets)
    return answerLine(response, 200, `ok\t余额 ${wallets}${bonus === '' ? '' : `（赠金 ${bonus}）`}`)
  }

  /** One `key=value` line per fact, for `dsh status`. */
  function state(request, response) {
    const lines = [
      `enabled=${enabled() ? '1' : '0'}`,
      `session=${sessionId()}`,
      `port=${String(port)}`,
      `version=${readVersion()}`,
      `started=${String(startedAt ?? '')}`,
    ]
    return answerLine(response, 200, lines.join('\n'))
  }

  /** The plugin's own version, read from its manifest; null when unreadable. */
  function readVersion() {
    try {
      const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      return typeof manifest.version === 'string' ? manifest.version : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  // ------------------------------------------------------------------ dispatcher

  /**
   * Dispatch one channel request.
   * @param {import('node:http').IncomingMessage} request - request.
   * @param {import('node:http').ServerResponse} response - response.
   * @returns {Promise<void>} settles when the response is done or streaming ended.
   */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://channel.invalid')
    const route = url.pathname
    // Every request authenticates, `/state` included: the shim has the token before it probes.
    const authorized = () => {
      const offered = String(request.headers['x-dsh-wsl-token'] ?? '')
      return offered.length === token.length && timingSafeEqual(offered, token)
    }
    if (route === '/state') {
      if (request.method !== 'GET') return answerLine(response, 405, 'err\tGET only')
      if (!authorized()) return answerLine(response, 401, 'err\tmissing or wrong channel token')
      return state(request, response)
    }
    if (request.method !== 'POST') return answerLine(response, 405, 'err\tPOST only')
    if (!authorized()) return answerLine(response, 401, 'err\tmissing or wrong channel token')
    if (route === '/say') return say(request, response, await readBody(request, MAX_PROMPT_BODY))
    if (route === '/insert') return insert(request, response, await readBody(request, MAX_PROMPT_BODY))
    if (route === '/list') return list(request, response)
    if (route === '/new') return create(request, response, await readBody(request, MAX_ID_BODY))
    if (route === '/rm') return archive(request, response, await readBody(request, MAX_ID_BODY))
    if (route === '/balance') return balance(request, response)
    return answerLine(response, 404, 'err\tunknown channel route')
  }

  /** Constant-time comparison for equal-length ASCII tokens. */
  function timingSafeEqual(a, b) {
    let diff = 0
    for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
    return diff === 0
  }

  // --------------------------------------------------------------- lifecycle

  /** Bind the channel server. Failures are reported, never thrown out of `apply()`. */
  async function start() {
    if (server !== null || stopped) return { port, host }
    try {
      const discovered = await discoverHostAddress()
      server = createServer((request, response) => {
        handle(request, response).catch((error) => {
          if (error !== null && typeof error === 'object' && error.code === 'BODY_TOO_LARGE') {
            answerLine(response, 413, 'err\tbody too large')
            return
          }
          const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
          answerLine(response, 500, `err\t${message}`)
        })
      })
      server.on('clientError', (error, socket) => {
        try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* ignore */ }
      })
      // WSL mirrored networking has no host-side gateway address to bind: the default route is
      // the LAN router and binding it fails. The fallback is loopback, which the shim already
      // reaches through `curl.exe` (and through its own curl in mirrored mode).
      const addresses = discovered === null ? ['0.0.0.0'] : [discovered, '127.0.0.1']
      let bound = null
      for (const address of addresses) {
        try {
          await new Promise((resolve, reject) => {
            const onError = (error) => {
              server.off('listening', onListening)
              reject(error)
            }
            const onListening = () => {
              server.off('error', onError)
              resolve()
            }
            server.once('error', onError)
            server.once('listening', onListening)
            server.listen(0, address)
          })
          bound = address
          break
        } catch {
          // Try the next candidate (mirrored networking, or an adapter that just went away).
        }
      }
      if (bound === null) throw new Error('the channel could not bind any address')
      const address = server.address()
      port = typeof address === 'object' && address !== null ? address.port : 0
      host = bound
      startedAt = now()
      publishState()
      // Heal a missing or outdated `dsh` in the distro by itself; a disabled channel is skipped
      // inside ensureShim, and an install failure is only a warning (the manual button remains).
      void ensureShim()
      return { port, host }
    } catch (error) {
      // A bind failure disables the channel without touching the rest of the plugin.
      server = null
      port = 0
      try { console.warn('dsh-wsl-tool: the WSL channel server did not start', error) } catch { /* ignore */ }
      return { port: 0, host: null }
    }
  }

  /** Stop the server and stop advertising it. */
  async function stop() {
    // Mark the teardown BEFORE destroying streams: their close handlers must not treat an
    // unmount/hot reload as a Ctrl+C and cancel a turn the user is watching in the client.
    stopping = true
    stopped = true
    unpublishState()
    try { offCacheEvents?.() } catch { /* ignore */ }
    offCacheEvents = null
    // Drop open streams instead of waiting for their turns: an unmount must not hang on a
    // turn that may have hours left. Destroying the response fires the same close cleanup.
    for (const response of [...inflight]) {
      try { response.destroy() } catch { /* ignore */ }
    }
    inflight.clear()
    if (server === null) return
    const closing = server
    server = null
    await new Promise((resolve) => closing.close(() => resolve()))
  }

  /**
   * Reflect a live settings change: the channel advertises `enabled`/`sessionId` in the
   * state file, so a switch flip has to rewrite it. Starts the server if the first
   * attempt failed (a distro that was not running yet).
   * @returns {Promise<{ port: number, host: string|null }>} the current binding.
   */
  async function refresh() {
    if (startedAt === null) {
      // Nothing is served while the channel is off; leaving the state file behind would
      // advertise a dead port, so it is removed instead.
      if (!enabled()) {
        unpublishState()
        return { port: 0, host: null }
      }
      return start()
    }
    publishState()
    void ensureShim()
    return { port, host }
  }

  /** Translate one Windows absolute path to the /mnt/<drive>/ form WSL sees. */
  const toWslPath = (path) => path
    .replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${String(drive).toLowerCase()}/`)
    .replace(/\\/g, '/')

  /**
   * The shim as it should be on disk: the template with the state-file path filled in.
   * @returns {string} the script.
   */
  function renderShim() {
    const template = readFileSync(new URL('../extras/dsh.sh', import.meta.url), 'utf8')
    // Quote the path for bash: a Windows profile path may contain spaces or a single quote.
    return template.split('__CHANNEL_CONFIG__').join(shellQuote(toWslPath(stateFile)))
  }

  /**
   * Whether the installed shim is the one this version would write. One `cat` in the distro
   * answers it; `current` means there is nothing to do.
   * @returns {Promise<'current'|'missing'|'stale'|'unknown'>} the state.
   */
  async function shimState() {
    if (typeof wsl !== 'function') return 'unknown'
    let expected
    try {
      expected = renderShim()
    } catch {
      return 'unknown'
    }
    let result
    try {
      result = await wsl(['-e', 'sh', '-c', 'if [ -f "$HOME/.local/bin/dsh" ]; then cat "$HOME/.local/bin/dsh"; fi'])
    } catch {
      return 'unknown'
    }
    if (result?.code !== 0) return 'unknown'
    const installed = String(result?.stdout ?? '')
    if (installed === '') return 'missing'
    return installed === expected ? 'current' : 'stale'
  }

  // One automatic install attempt at a time, and not more often than a minute (a settings flip
  // or a panel refresh can call this repeatedly); a failed attempt clears the throttle so the
  // next refresh tries again.
  let shimEnsure = null
  let shimCheckedAt = 0

  /**
   * Install a missing (or outdated) shim without asking. Called after the channel is up, which
   * is exactly when the state file is valid. It never replaces the shim while a turn streams:
   * a running `dsh` has the file open, so the swap waits for the next refresh.
   * @returns {Promise<{ state: string, installed: boolean, detail?: string }>} what happened.
   */
  function ensureShim() {
    if (shimEnsure !== null) return shimEnsure
    if (config?.autoInstallShim !== true) return Promise.resolve({ state: 'disabled', installed: false })
    if (typeof wsl !== 'function' || !enabled()) return Promise.resolve({ state: 'skipped', installed: false })
    if (now() - shimCheckedAt < 60_000) return Promise.resolve({ state: 'throttled', installed: false })
    shimEnsure = (async () => {
      shimCheckedAt = now()
      const state = await shimState()
      if (state === 'current' || state === 'unknown') return { state, installed: false }
      if (inflight.size > 0) {
        shimCheckedAt = 0
        return { state, installed: false, detail: 'a turn is streaming; the shim is replaced on the next refresh' }
      }
      const result = await install()
      if (result.ok) {
        try { console.info(`dsh-wsl-tool: installed the dsh shim automatically (${state})`) } catch { /* ignore */ }
      } else {
        shimCheckedAt = 0
        try { console.warn(`dsh-wsl-tool: could not install the dsh shim automatically: ${result.detail}`) } catch { /* ignore */ }
      }
      return { state, installed: result.ok, detail: result.detail }
    })().catch((error) => {
      shimCheckedAt = 0
      try { console.warn('dsh-wsl-tool: the automatic shim check failed', error) } catch { /* ignore */ }
      return { state: 'unknown', installed: false, detail: String(error?.message ?? error) }
    }).finally(() => { shimEnsure = null })
    return shimEnsure
  }

  /**
   * Install (or refresh) the `dsh` shim inside WSL and rewrite the state file.
   * @param {(path: string, contents: string, mode?: number) => void} [writer] - test seam.
   * @returns {Promise<{ ok: boolean, target?: string, detail: string }>} outcome.
   */
  async function install(writer = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, 'utf8')
  }) {
    if (typeof wsl !== 'function') return { ok: false, detail: 'no wsl.exe runner in this host' }
    // Installing copies the shim that reads the state file, so the server has to exist; but a
    // disabled channel must not be started behind the owner's back just because they clicked
    // install. Say what to do instead.
    if (startedAt === null && !enabled()) {
      return { ok: false, detail: 'WSL 通道未启用：先在面板里打开「启用 dsh 命令」，再安装 dsh 命令' }
    }
    if (startedAt === null) {
      const started = await start()
      if (started.port === 0) {
        return { ok: false, detail: 'WSL 通道没有启动（端口绑定失败），暂时无法安装 dsh 命令' }
      }
    }
    let script
    try {
      script = renderShim()
    } catch (error) {
      return { ok: false, detail: `could not read the shim template: ${String(error?.message ?? error)}` }
    }
    const windowsPath = join(dirname(stateFile), 'dsh.sh')
    const scriptPath = toWslPath(windowsPath)
    try {
      writer(windowsPath, script)
    } catch (error) {
      return { ok: false, detail: `could not write ${windowsPath}: ${String(error?.message ?? error)}` }
    }
    const command = [
      'set -e',
      'mkdir -p "$HOME/.local/bin" "$HOME/.config/dsh-wsl"',
      `install -m 0755 ${shellQuote(scriptPath)} "$HOME/.local/bin/dsh"`,
      'printf "%s\\n" "$HOME/.local/bin/dsh"',
    ].join(' && ')
    try {
      const result = await wsl(['-e', 'bash', '-lc', command])
      if (result?.code !== 0) {
        return { ok: false, detail: String(result?.stderr ?? 'the install command failed').trim() }
      }
      publishState()
      const output = String(result?.stdout ?? '').trim().split('\n')
      return { ok: true, target: output[output.length - 1] ?? '~/.local/bin/dsh', detail: 'installed' }
    } catch (error) {
      return { ok: false, detail: String(error?.message ?? error) }
    }
  }

  /** Facts for the panel: what the channel is and whether the shim is there. */
  async function panelState() {
    // Re-advertise on every panel read: cheap, and it heals a state file lost to the
    // stop/start race a hot reload can produce.
    if (enabled() === true) publishState()
    let shim = { installed: false, path: '' }
    if (typeof wsl === 'function') {
      try {
        const result = await wsl(['-e', 'bash', '-lc', 'test -x "$HOME/.local/bin/dsh" && echo yes || echo no'])
        const installed = String(result?.stdout ?? '').trim() === 'yes'
        shim = { installed, path: '~/.local/bin/dsh' }
      } catch { /* reported as not installed */ }
    }
    let sessions = []
    let sessionMeta = { records: 0, members: 0, titled: 0 }
    try {
      const result = await sessionRows()
      sessions = result.rows
      sessionMeta = result.meta
    } catch (error) {
      sessions = []
      sessionMeta = { records: 0, members: 0, titled: 0, error: String(error?.message ?? error) }
    }
    return {
      enabled: enabled(),
      sessionId: sessionId(),
      sessions,
      // Counts only, no ids: what the picker saw is the first thing to look at when the
      // list comes back empty again.
      sessionMeta,
      port,
      host,
      version: readVersion(),
      stateFile,
      shim,
      // The hidden-context path, for "the model did not get my terminal": which route asked,
      // which step answered, and how many captures await their request.
      history: historyState(),
    }
  }

  return {
    start,
    stop,
    refresh,
    say,
    list,
    create,
    createSession,
    archive,
    install,
    ensureShim,
    panelState,
    state,
    handle,
    token,
    /** Hidden model context captured from the sending terminal (read by `index.js`). */
    terminalContextFor,
    consumeTerminalContext,
    /** Diagnostics for that context: the last attempt, counters, pending captures. */
    historyState,
    get port() { return port },
    get host() { return host },
    stateFile,
  }
}
