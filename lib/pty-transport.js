// A terminal transport for DSH builds whose `terminalController` no longer exposes
// `follow`/`write`.
//
// DSH 0.2.1 replaced that pair with `attach(agent, id, signal)`, which reads the CALLER's
// Remote invocation to obtain its input uplink — a host-side plugin has no such invocation,
// so a plugin cannot type into the browser's terminal at all. What a plugin can still do is
// what the platform's own persistent-shell tools do: own a PTY through the subprocess
// provider (`spawnTerminal`), and drive it itself.
//
// This module wraps one such PTY in the SAME five calls `wsl-term` already uses —
// `list`, `create`, `follow`, `write`, `close` — so the tool's protocol (helper definition,
// per-call nonce, marker parsing, readiness gating, detachable attachment) works unchanged on
// either generation of the host.
//
// The one thing it cannot offer is the sidebar: these shells are not the app's browser
// terminals, so nobody can watch or join them. `lib/term-bridge.js` closes that gap: when the
// plugin's browser half is running, it drives the user's own sidebar terminal through the page
// (which does hold a Remote invocation) and keeps this PTY as its fallback — so a closed window
// degrades to exactly the shells described here, and the tool says which one it got.
//
// Every terminal is the calling Agent's: one PTY per allocated id, closed by `close`, by the
// owning session's disposal (registered on its `ctx.effect`, exactly like the platform's own
// terminal service), or by the host shutting down. Nothing is persisted — a restart drops them,
// exactly like the old ones.

import { resolveDistro } from './runner.js'
import { windowsPathToWsl } from './paths.js'
import { createBridgeTransport } from './term-bridge.js'

/** Geometry a tool-opened terminal gets when nobody asks for another. */
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
/** Retained tail of one shell's output; the tool only ever reads the markers near the end. */
const MAX_BUFFER_CHARS = 200_000
/** Upper bound for the replayable chunk history: the markers are always recent, so a shell's
 *  whole life is not worth keeping. A live follower pins what it has not read yet. */
const MAX_HISTORY_CHARS = MAX_BUFFER_CHARS
/** How long a terminated PTY may take to settle before the close is reported as done. */
const CLOSE_GRACE_MS = 1_000
/** The platform's own wording, so `isClosedIdentity` in the tool matches. */
const CLOSED_MESSAGE = 'Terminal was closed in this Session'

/** Keep only the end of a growing capture: the markers a call waits for are recent. */
function keepTail(text) {
  return text.length <= MAX_BUFFER_CHARS ? text : text.slice(text.length - MAX_BUFFER_CHARS)
}

/** Chunks not pruned yet; `chunksHead` indexes the first live one. */
const liveChunks = (record) => record.chunks.length - record.chunksHead

/** Absolute index one past the newest chunk. Stable across pruning, so cursors can use it. */
const historyEnd = (record) => record.chunksStart + liveChunks(record)

/**
 * Drop chunk history past the cap.
 *
 * A chunk may only be dropped once every live follower has read it: a follower's cursor is the
 * absolute index of its next chunk, and the one furthest behind pins the window. With no
 * followers everything is already consumed. The head is compacted once in a while so the array
 * itself stays bounded too (a long shell produces many prompt-sized chunks).
 */
function trimHistory(record) {
  let floor = Number.POSITIVE_INFINITY
  for (const lease of record.followers) floor = Math.min(floor, lease.cursor)
  if (floor === Number.POSITIVE_INFINITY) floor = historyEnd(record)
  while (record.chunksChars > MAX_HISTORY_CHARS && record.chunksHead < record.chunks.length) {
    if (record.chunksStart >= floor) break
    record.chunksChars -= record.chunks[record.chunksHead].length
    record.chunksHead += 1
    record.chunksStart += 1
  }
  if (record.chunksHead > 1_024 && record.chunksHead * 2 > record.chunks.length) {
    record.chunks = record.chunks.slice(record.chunksHead)
    record.chunksHead = 0
  }
}

/**
 * Build a PTY-backed terminal transport over `ctx.subprocess`.
 *
 * @param ctx - the plugin context, used only to reach the subprocess provider.
 * @param config - resolved plugin configuration (`distro` decides which distribution runs).
 * @param subprocess - the provider carrying `spawnTerminal`; looked up when omitted.
 * @returns the transport, or null when this build has no terminal-capable subprocess provider.
 */
export function createPtyTransport({ ctx, config, subprocess }) {
  let provider = subprocess
  if (provider === undefined || provider === null) {
    try {
      provider = typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined
    } catch {
      // A host that faults on the lookup simply has no PTY transport; the tool says so.
      provider = undefined
    }
  }
  if (provider === undefined || provider === null || typeof provider.spawnTerminal !== 'function') return null

  /** sessionId -> Map<terminalId, record>; a plugin instance owns every shell it opened. */
  const sessions = new Map()
  /** Ids closed in this run: the platform refuses to reuse them, and so does this transport. */
  const closedIds = new Set()
  /** In-flight creations by `<sessionId>:<id>`: concurrent callers must share one shell. */
  const creating = new Map()
  /** Sessions whose shell cleanup was registered on their agent context. */
  const ownerCleanup = new Set()

  const bucket = (sessionId) => {
    const key = String(sessionId ?? '')
    let found = sessions.get(key)
    if (found === undefined) {
      found = new Map()
      sessions.set(key, found)
    }
    return found
  }
  const expect = (sessionId, id) => {
    const found = bucket(sessionId).get(String(id))
    if (found === undefined) throw new Error(`Terminal ${String(id)} does not exist in this Session`)
    return found
  }
  const publicInfo = (record) => ({ ...record.info, shell: { ...record.info.shell, args: [...record.info.shell.args] } })

  /** Wake every follower waiting for the next chunk. */
  const notify = (record) => {
    for (const wake of [...record.waiters]) wake()
  }

  /** Read the PTY for as long as it lives. One pump per terminal; followers share its output. */
  async function pump(record) {
    try {
      for await (const chunk of record.handle.output) {
        const text = record.decoder.decode(chunk, { stream: true })
        if (text.length === 0) continue
        record.buffer = keepTail(record.buffer + text)
        record.chunks.push(text)
        record.chunksChars += text.length
        trimHistory(record)
        notify(record)
      }
      const rest = record.decoder.decode()
      if (rest.length > 0) {
        record.buffer = keepTail(record.buffer + rest)
        record.chunks.push(rest)
        record.chunksChars += rest.length
        trimHistory(record)
      }
    } catch {
      // A provider that fails mid-stream is an ended shell, reported through `handle.done`.
    }
    record.ended = true
    try {
      const outcome = await record.handle.done
      const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : null
      record.info = { ...record.info, state: 'exited', exitCode }
    } catch {
      record.info = { ...record.info, state: 'failed' }
    }
    notify(record)
  }

  /** Resolve when the terminal produces more output, ends, or the caller detaches. */
  function nextChange(record, signal) {
    if (record.ended || signal?.aborted === true) return Promise.resolve()
    return new Promise((resolve) => {
      const wake = () => {
        record.waiters.delete(wake)
        signal?.removeEventListener?.('abort', wake)
        resolve()
      }
      record.waiters.add(wake)
      signal?.addEventListener?.('abort', wake, { once: true })
    })
  }

  /**
   * One attachment: the current capture as its screen, then each new chunk, then the exit.
   *
   * `options.fromNow` starts the cursor at the newest chunk instead of replaying the shell's
   * history: a `run`/`input` only cares about what happens after it types, while a `read` wants
   * the tail that explains the screen. The cursor is an absolute chunk index, and the record
   * never drops a chunk a live follower has not read, so the loop cannot lose data.
   */
  async function* followStream(record, signal, options) {
    const lease = { cursor: options?.fromNow === true ? historyEnd(record) : record.chunksStart }
    record.followers.add(lease)
    try {
      let sequence = 0
      yield { type: 'snapshot', sequence: sequence++, screen: record.buffer, info: publicInfo(record), writable: true }
      while (true) {
        while (lease.cursor - record.chunksStart < liveChunks(record)) {
          const data = record.chunks[record.chunksHead + (lease.cursor - record.chunksStart)]
          lease.cursor += 1
          yield { type: 'output', data }
          yield { type: 'snapshot', sequence: sequence++, screen: record.buffer, info: publicInfo(record), writable: true }
        }
        if (record.ended) break
        if (signal?.aborted === true) return
        await nextChange(record, signal)
      }
      if (record.ended) yield { type: 'state', info: publicInfo(record), writable: false }
    } finally {
      record.followers.delete(lease)
      trimHistory(record)
    }
  }

  /**
   * Where the shell should start.
   *
   * The same rule the one-shot `wsl` tool follows, so the two tools agree about "the project":
   * the panel's fixed directory when one is set, otherwise the CALLING SESSION's workspace
   * (translated), otherwise the host's own directory. The old browser-terminal path inherited
   * whatever the user's terminal had; a PTY we open has to be told.
   */
  function startingDirectory(agent) {
    if (typeof config.defaultWorkdir === 'string' && config.defaultWorkdir !== '') return config.defaultWorkdir
    const sessionCwd = agent?.session?.header?.cwd
    return windowsPathToWsl(typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : process.cwd())
  }

  /** The launcher this transport runs, with the configured distribution and start directory. */
  async function launcher(agent, signal) {
    const distro = resolveDistro(undefined, config)
    let executable = 'wsl.exe'
    try {
      executable = await provider.resolveExecutable('wsl.exe', undefined, signal)
    } catch {
      // A host that cannot resolve it still lets Windows find it on PATH.
    }
    const workdir = startingDirectory(agent)
    const args = [
      ...(distro === null ? [] : ['-d', distro]),
      // `--cd` is the launcher's own directory switch: it applies before the shell starts, so the
      // prompt is already in the right tree (a `cd` inside `-e bash -l` would fight the profile).
      '--cd', workdir,
      '-e', 'bash', '-l',
    ]
    return { executable, args, workdir }
  }

  /** Spawn one shell and shape it as a record. Separated so `create` can reserve the identity. */
  async function spawnRecord(agent, request, signal, sessionId, id) {
    const { executable, args, workdir } = await launcher(agent, signal)
    let handle
    try {
      handle = await provider.spawnTerminal({
        argv: [executable, ...args],
        cwd: process.cwd(),
        cols: request.cols ?? DEFAULT_COLS,
        rows: request.rows ?? DEFAULT_ROWS,
        terminalType: 'xterm-256color',
        env: { WSL_UTF8: '1', DSH_SESSION_ID: sessionId },
        graceMs: CLOSE_GRACE_MS,
        signal,
      })
    } catch (error) {
      throw new Error(`could not open a shell: ${String(error?.message ?? error)}`)
    }
    return {
      handle,
      // The same shape the browser controller publishes, so the tool's renderers,
      // header and readiness logic need no knowledge of where the shell came from.
      info: {
        id,
        title: 'WSL',
        shell: { name: 'WSL', path: executable, args },
        cwd: workdir,
        cols: request.cols ?? DEFAULT_COLS,
        rows: request.rows ?? DEFAULT_ROWS,
        state: 'running',
        exitCode: null,
      },
      buffer: '',
      chunks: [],
      chunksHead: 0,
      chunksStart: 0,
      chunksChars: 0,
      followers: new Set(),
      ended: false,
      waiters: new Set(),
      decoder: new TextDecoder('utf-8'),
    }
  }

  /** Close every shell one session owns; used when that conversation is disposed. */
  async function closeOwnedShells(sessionId) {
    const key = String(sessionId ?? '')
    const map = sessions.get(key)
    if (map !== undefined) {
      for (const [id, record] of [...map]) {
        map.delete(id)
        closedIds.add(`${key}:${id}`)
        try {
          await record.handle.terminate()
        } catch {
          // A provider that already lost the process is the outcome that was wanted.
        }
      }
      sessions.delete(key)
    }
    for (const closed of [...closedIds]) if (closed.startsWith(`${key}:`)) closedIds.delete(closed)
    for (const pending of [...creating.keys()]) if (pending.startsWith(`${key}:`)) creating.delete(pending)
    ownerCleanup.delete(key)
  }

  /**
   * Close this session's shells when its conversation goes away.
   *
   * A plugin-level transport outlives every conversation. Without this hook a private WSL shell
   * (and whatever it is running) would keep living after the session that opened it is disposed;
   * the platform's own terminal service registers exactly this `owner.ctx.effect` for its PTYs.
   * A host whose agent has no ctx simply has no unload hook, and the host shutdown still reaps
   * the shells through the provider.
   */
  function hookOwnerCleanup(agent, sessionId) {
    const key = String(sessionId ?? '')
    if (ownerCleanup.has(key)) return
    const effect = agent?.ctx?.effect
    if (typeof effect !== 'function') return
    ownerCleanup.add(key)
    try {
      effect(() => async () => { await closeOwnedShells(key) }, 'dsh-wsl-tool: private terminal shells')
    } catch {
      ownerCleanup.delete(key)
    }
  }

  return {
    /** Marks the generation this transport serves: the tool words itself differently. */
    kind: 'pty',
    /** Other wiring may need to know which provider created the shells. */
    provider,

    /**
     * Every terminal this transport reports was opened by THIS plugin, so nothing here is the
     * user's own long-lived shell. The tool uses this to decide what it may close and to word
     * its header; a shell it does not own must not be touched by subtask bookkeeping.
     */
    owns() {
      return true
    },

    /** The tool's per-call wording follows the transport that really serves this terminal. */
    kindOf() {
      return 'pty'
    },

    /** Describe one of this transport's terminals, if it still exists. */
    describe(sessionId, id) {
      const found = bucket(sessionId).get(String(id))
      return found === undefined ? null : publicInfo(found)
    },

    /** This transport owns every shell it reports; there is no separate user terminal. */
    userTerminals() {
      return []
    },

    list(sessionId) {
      return [...bucket(sessionId).values()].map((record) => publicInfo(record))
    },

    async create(agent, request, signal) {
      const sessionId = String(agent?.id ?? '')
      const map = bucket(sessionId)
      const id = String(request.id)
      const key = `${sessionId}:${id}`
      const existing = map.get(id)
      if (existing !== undefined) {
        if (!existing.ended) return publicInfo(existing)
        // The shell exited on its own and was never closed: replace it under the same id, so a
        // caller that only remembers the id recovers without a list+close round trip.
        map.delete(id)
        try {
          await existing.handle.terminate()
        } catch {
          // The provider already lost it; the point was to make room.
        }
      }
      if (closedIds.has(key)) throw new Error(CLOSED_MESSAGE)
      // One shell per identity, even under concurrent calls: a second caller joins the spawn
      // already in flight instead of opening a second shell the registry would then lose.
      const inFlight = creating.get(key)
      if (inFlight !== undefined) return publicInfo(await inFlight)
      const spawning = spawnRecord(agent, request, signal, sessionId, id)
      creating.set(key, spawning)
      try {
        const record = await spawning
        if (closedIds.has(key)) {
          // `close` ran while this shell was spawning: honour it instead of resurrecting the id.
          try {
            await record.handle.terminate()
          } catch {
            // Already gone.
          }
          throw new Error(CLOSED_MESSAGE)
        }
        map.set(id, record)
        pump(record)
        hookOwnerCleanup(agent, sessionId)
        return publicInfo(record)
      } finally {
        if (creating.get(key) === spawning) creating.delete(key)
      }
    },

    follow(agent, id, _attachmentId, signal, options) {
      const sessionId = String(agent?.id ?? '')
      const record = expect(sessionId, id)
      return followStream(record, signal, options)
    },

    async write(agent, id, _attachmentId, data) {
      const sessionId = String(agent?.id ?? '')
      const record = expect(sessionId, id)
      if (record.ended) throw new Error(`Terminal ${String(id)} has exited`)
      try {
        // `LocalTerminalHandle.write` is async and rejects once the PTY has exited. Dropping
        // that promise used to let the rejection escape as an unhandled one, which the DSH
        // host's fail-loud handler turns into process.exit(1) — the whole app, not one call.
        await record.handle.write(String(data))
      } catch (error) {
        const exited = record.ended || /exit/i.test(String(error?.message ?? error))
        throw new Error(exited
          ? `Terminal ${String(id)} has exited`
          : `could not write to terminal ${String(id)}: ${String(error?.message ?? error)}`)
      }
    },

    async close(agent, id) {
      const sessionId = String(agent?.id ?? '')
      const key = `${sessionId}:${String(id)}`
      const map = bucket(sessionId)
      const record = map.get(String(id))
      closedIds.add(key)
      map.delete(String(id))
      // A close that lands while the shell is still spawning must not leave it running: the
      // creator re-checks this closed identity after its spawn and terminates what it opened.
      creating.delete(key)
      if (record === undefined) return
      try {
        await record.handle.terminate()
      } catch {
        // A provider that already lost the process is the outcome that was wanted.
      }
    },
  }
}

/**
 * Pick the terminal transport this host offers.
 *
 * The pre-bridge generation (a controller that speaks `follow`/`write`, DSH ≤ 0.2.0) is no
 * longer supported: on those hosts the tool now reports that it cannot drive a terminal rather
 * than driving the user's browser terminal directly. What is left is the bridge (0.2.1: the
 * plugin's CLIENT half joins the sidebar terminal and this host half queues the keystrokes for
 * it; the private PTY is its fallback for a closed window) and the private PTY itself. A host
 * with neither yields null, which the tool reports as an unsupported build.
 *
 * @returns the transport, or null when this host has no way to run a terminal.
 */
export function createTerminalTransport({ ctx, config }) {
  let controller = null
  try {
    controller = typeof ctx?.get === 'function' ? ctx.get('terminalController') : null
  } catch {
    controller = null
  }
  let pty = null
  try {
    pty = createPtyTransport({ ctx, config })
  } catch {
    // Picking a transport must never be what stops the plugin from mounting: the other five
    // tools have nothing to do with the terminal.
    pty = null
  }
  // The bridge owns the same PTY as its fallback, so one transport keeps one registry of shells:
  // a shell opened while the window was closed stays drivable through the same object after it
  // reopens, and `list` shows both generations at once.
  try {
    const bridge = createBridgeTransport({ ctx, config, controller, pty })
    if (bridge !== null) return bridge
  } catch {
    // A bridge that cannot be built is exactly a host that has only the PTY.
  }
  if (pty !== null) return pty
  return null
}

/**
 * A stable transport handle that can upgrade itself to the browser bridge later.
 *
 * Mount order is host-defined. DSH 0.2.1-rc.3 brings the web-app rows (and with them
 * `terminalController`) up AFTER a profile plugin's `apply`, so resolving the transport once at
 * apply silently picked the private-PTY fallback and never looked back: `/info` kept reporting
 * `terminal: pty` and the terminal tool kept claiming the sidebar terminal could not be joined,
 * even though the bridge was perfectly available a moment later. The handle keeps one identity
 * (tools, routes and the channel capture it) and delegates to whichever generation is current;
 * `upgrade()` re-resolves once the host actually offers the services the bridge needs.
 *
 * @param {{ ctx: object, config: object }} options - same inputs `createTerminalTransport` takes.
 * @returns the handle: the transport surface plus `upgrade()`.
 */
export function createLazyTerminalTransport({ ctx, config }) {
  let impl = null
  try {
    impl = createTerminalTransport({ ctx, config })
  } catch {
    impl = null
  }
  const call = (name, args) => {
    const current = impl
    if (current === null || typeof current[name] !== 'function') {
      throw new Error(`wsl-term: this host has no terminal transport (${name} is unavailable)`)
    }
    return current[name](...args)
  }
  const safe = (name, fallback, args = []) => {
    try {
      return call(name, args)
    } catch {
      return fallback
    }
  }
  return {
    /**
     * Re-resolve the transport, keeping the new one only when it is a browser bridge.
     * @returns {boolean} true when the bridge is now in use.
     */
    upgrade() {
      try {
        const next = createTerminalTransport({ ctx, config })
        if (next === null || typeof next.status !== 'function' || next.bridgeCapable !== true) return false
        impl = next
        return true
      } catch {
        return false
      }
    },
    /** Marks the generation this handle currently serves. */
    get kind() {
      return impl !== null && typeof impl.kind === 'string' ? impl.kind : null
    },
    /** True when the browser terminal bridge is available (a property of the build). */
    get bridgeCapable() {
      return impl !== null && impl.bridgeCapable === true
    },
    get provider() {
      return impl?.provider
    },
    status() {
      return safe('status', null)
    },
    /**
     * Whether the tool opened this terminal (only those may be closed by it).
     *
     * This MUST be forwarded: `wsl-term` treats a transport that cannot answer as "not ours"
     * (the safe default), so dropping it here made every terminal — including the private
     * shells this plugin had just opened — unbribable to `close` and to
     * `subtask-done keepTerminal: false`, leaking one shell per subtask.
     * @param {string} sessionId - conversation that holds the terminal.
     * @param {string} id - terminal id.
     * @returns {boolean} true only when this plugin created it.
     */
    owns(sessionId, id) {
      return safe('owns', false, [sessionId, id]) === true
    },
    /** The generation that really serves one terminal (wording follows it, per call). */
    kindOf(sessionId, id) {
      const kind = safe('kindOf', null, [sessionId, id])
      if (typeof kind === 'string') return kind
      return impl !== null && typeof impl.kind === 'string' ? impl.kind : null
    },
    describe(sessionId, id) {
      return safe('describe', null, [sessionId, id])
    },
    list(sessionId) {
      return safe('list', [], [sessionId])
    },
    create(agent, request, signal) {
      return call('create', [agent, request, signal])
    },
    close(agent, id) {
      return call('close', [agent, id])
    },
    follow(agent, id, attachmentId, signal, options) {
      return call('follow', [agent, id, attachmentId, signal, options])
    },
    write(agent, id, attachmentId, data) {
      return call('write', [agent, id, attachmentId, data])
    },
    userTerminals(sessionId) {
      return safe('userTerminals', [], [sessionId])
    },
  }
}

