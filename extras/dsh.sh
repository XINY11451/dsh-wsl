#!/usr/bin/env bash
# dsh — talk to the running DSH desktop from inside WSL.
#
# The desktop's dsh-wsl plugin hosts a small loopback channel; this script sends a
# prompt into the DSH session the panel designates and streams the reply back here.
# WSL reaches the host through its default gateway (under WSL2 NAT that is the
# Windows side), so no interop and no Windows binary is needed: plain bash + curl.
#
# Installed by the plugin's panel ("安装 dsh 命令"). Regenerate instead of editing:
# the panel overwrites this file on every install.
set -u

# Filled in by the plugin when it installs this script: a shell-quoted /mnt/<drive>/... path
# (single quotes included, so a Windows profile with spaces or a quote still parses).
CONFIG=__CHANNEL_CONFIG__
STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-wsl"
# The current session is per TERMINAL: one shared file made `dsh use`/`new` in one window
# silently retarget another window (both are the same user, different conversations).
# `tty` is the pty name; a redirected/pipe run falls back to the shared name.
tty_key() {
  local t
  t=$(tty 2>/dev/null || true)
  case "$t" in
    /dev/*) printf '%s' "${t##*/}" ;;
    *) printf '%s' 'shared' ;;
  esac
}
CURRENT_FILE="$STATE_DIR/current.$(tty_key)"
# The working client/base for the CURRENT channel instance (startedAt changes on every start).
# Probed once per channel start instead of on every command: the probe is what made `dsh`
# feel slow (an in-WSL curl that the firewall silently drops costs seconds before falling
# back to `curl.exe`).
TRANSPORT_FILE="$STATE_DIR/transport"

die() { printf 'dsh: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：
  dsh -- "问题"             把问题发给当前会话，流式显示思考与回复
  dsh <会话id> -- "问题"    发给指定会话
  dsh list                  列出会话（* 表示当前）
  dsh new <会话id>          新建会话并设为当前
  dsh use <会话id>          切换当前会话
  dsh rm <会话id>           归档会话（可恢复）
  dsh status                当前会话与通道状态

只有 -- 后面的内容会当消息发出去；第一个词不是上面的命令、又没有 -- 时，会直接报
「不存在此命令」，不会把打错的命令当成问题发给模型。-- 后面不需要再加引号，也可以
不加（dsh -- 帮我看看 与 dsh -- "帮我看看" 等价）；带空格的内容建议保留引号。
说明：回复来自 DSH 客户端里的同一段对话；在终端按 Ctrl+C 会停止等待，并且
客户端里那一轮也会一起中止。等待回复期间终端仍可输入：先按一次回车暂停输出，
敲完内容再回车就插入当前对话（等同往正在进行的回合里插话），随后继续输出；
第二次回车留空则取消插入。设 DSH_WSL_NO_STEER=1 可关掉这个输入。`dsh -- "…"`
若目标正是正在等待这条命令的会话会自锁，此时会直接报「无法执行」并说明原因，
等这一轮结束或在客户端里输入即可。当前会话按终端分别保存：两个终端互不影响。
EOF
}

# Read the few fields this shim needs with bash builtins only. This used to be a dozen
# grep/sed/head forks on EVERY command — that alone was most of the delay of `dsh use`, which
# touches no network at all. The parser is deliberately indifferent to the JSON writer's
# spacing: the value is stripped of the key, a trailing comma, whitespace (CRLF included) and
# optional quotes, so a reformatted channel.json still reads the same.
parse_value() {
  VALUE=${1#*:}
  # Whitespace first (a CR from a CRLF checkout would otherwise hide the comma), then the
  # comma, then whitespace/quotes again.
  VALUE=${VALUE#"${VALUE%%[![:space:]]*}"}
  VALUE=${VALUE%"${VALUE##*[![:space:]]}"}
  VALUE=${VALUE%,}
  VALUE=${VALUE#"${VALUE%%[![:space:]]*}"}
  VALUE=${VALUE%"${VALUE##*[![:space:]]}"}
  VALUE=${VALUE#\"}
  VALUE=${VALUE%\"}
  VALUE=${VALUE%"${VALUE##*[![:space:]]}"}
}

read_config() {
  TOKEN=''
  PORT=''
  ENABLED=0
  DEFAULT_SESSION=''
  STARTED=''
  HOST=''
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *'"token"'*)
        parse_value "$line"
        TOKEN=$VALUE
        ;;
      *'"port"'*)
        parse_value "$line"
        PORT=${VALUE//[!0-9]/}
        ;;
      *'"enabled"'*)
        case "$line" in *true*) ENABLED=1 ;; esac
        ;;
      *'"sessionId"'*)
        parse_value "$line"
        DEFAULT_SESSION=$VALUE
        ;;
      *'"startedAt"'*)
        parse_value "$line"
        STARTED=${VALUE//[!0-9]/}
        ;;
      *'"host"'*)
        parse_value "$line"
        HOST=$VALUE
        ;;
    esac
  done < "$CONFIG"
}

load_channel() {
  # The Host writes this file when its channel starts and removes it on unmount, so during a
  # desktop restart it is briefly absent. A command typed in that window waits a moment instead
  # of reporting "never installed" — the file comes back by itself once DSH is up.
  if [ ! -r "$CONFIG" ]; then
    local waited=0
    while [ "$waited" -lt 6 ] && [ ! -r "$CONFIG" ]; do
      sleep 0.25 2>/dev/null || sleep 1
      waited=$((waited + 1))
    done
  fi
  [ -r "$CONFIG" ] || die "找不到通道配置 $CONFIG —— DSH 桌面版没在运行，或者正在启动/重启；它启动后会自动写回这个文件。仍然没有的话，在面板里确认「启用 dsh 命令」已打开，并重装一次 dsh 命令"
  read_config
  [ -n "${TOKEN:-}" ] && [ -n "${PORT:-}" ] || die "通道配置不完整 —— 在 DSH 面板里重新安装一次 dsh 命令"
  [ "$ENABLED" = 1 ] || die "WSL 通道没有启用 —— 在 DSH 侧边栏的 WSL 面板里打开「启用 dsh 命令」"
  # Reuse the transport that worked for this exact channel instance. This is the hot path:
  # no network probe, no `ip route` spawn.
  if [ -r "$TRANSPORT_FILE" ] && [ -n "${STARTED:-}" ]; then
    local cached_started cached_client cached_base
    IFS=$'\t' read -r cached_started cached_client cached_base < "$TRANSPORT_FILE" || true
    if [ "${cached_started:-}" = "$STARTED" ] && [ -n "${cached_client:-}" ] \
      && [ -n "${cached_base:-}" ] && command -v "$cached_client" >/dev/null 2>&1; then
      CURL=$cached_client
      BASE=$cached_base
      return
    fi
  fi
  # First command after a (re)start: resolve the address once and probe with a SHORT connect
  # timeout, so a blocked path costs ~0.5 s instead of seconds.
  if [ -n "${HOST:-}" ]; then
    BASE="http://$HOST:$PORT"
  else
    GW=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')
    [ -n "${GW:-}" ] || die "WSL 没有默认网关，无法连到 DSH 宿主机"
    BASE="http://$GW:$PORT"
  fi
  CURL=''
  local candidate
  for candidate in curl curl.exe; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    # /state authenticates like every other route; the token was just read from the same file.
    if "$candidate" -sS --connect-timeout 0.25 --max-time 1 \
      -H "x-dsh-wsl-token: $TOKEN" "$BASE/state" >/dev/null 2>&1; then
      CURL=$candidate
      break
    fi
  done
  # Windows' own curl can reach a host that only listens on the host adapter, and the
  # service may bind loopback instead; try the Windows loopback last.
  if [ -z "$CURL" ] && command -v curl.exe >/dev/null 2>&1 \
    && curl.exe -sS --connect-timeout 0.25 --max-time 1 \
      -H "x-dsh-wsl-token: $TOKEN" "http://127.0.0.1:$PORT/state" >/dev/null 2>&1; then
    CURL=curl.exe
    BASE="http://127.0.0.1:$PORT"
  fi
  [ -n "$CURL" ] || die "连不上 DSH 宿主（$BASE）—— 桌面版在运行吗？通道在面板里启用了吗？"
  mkdir -p "$STATE_DIR"
  printf '%s\t%s\t%s\n' "${STARTED:-0}" "$CURL" "$BASE" > "$TRANSPORT_FILE"
}

current_session() {
  local saved='' line=''
  if [ -r "$CURRENT_FILE" ]; then IFS= read -r line < "$CURRENT_FILE" || true; saved=${line//[[:space:]]/}; fi
  # A terminal that has never chosen one adopts the old shared value once (upgrade path);
  # after its first `use`/`new` the per-terminal file is the only source.
  if [ -z "$saved" ] && [ -r "$STATE_DIR/current" ]; then
    IFS= read -r line < "$STATE_DIR/current" || true
    saved=${line//[[:space:]]/}
  fi
  [ -n "$saved" ] && { printf '%s' "$saved"; return; }
  # Empty means auto: the host keeps a dedicated session for the terminal.
  printf '%s' "${DEFAULT_SESSION:-}"
}

set_current() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$1" > "$CURRENT_FILE"
}

# One POST with the CURRENT client/base. Kept separate so a failed request can forget a stale
# transport, re-resolve, and retry with the new token/base.
post_once() {
  local route=$1 body=${2:-} session=${3:-}
  local timeout=60
  local extra=()
  [ "$route" = say ] && { timeout=0; extra=(-N); }
  [ -n "${DSH_WSL_CALLER_SESSION:-}" ] && extra+=(-H "x-dsh-wsl-caller: $DSH_WSL_CALLER_SESSION")
  if [ -n "$session" ]; then
    "$CURL" -sS "${extra[@]}" --max-time "$timeout" -X POST \
      -H "x-dsh-wsl-token: $TOKEN" \
      -H "x-dsh-wsl-session: $session" \
      --data-raw "$body" "$BASE/$route"
  else
    "$CURL" -sS "${extra[@]}" --max-time "$timeout" -X POST \
      -H "x-dsh-wsl-token: $TOKEN" \
      --data-raw "$body" "$BASE/$route"
  fi
}

# POST a body to one route; prints the response body. `say` streams for as long as the
# turn runs, so it carries no client-side deadline and is not retried mid-stream. The
# management routes are quick, so a connection failure there is recovered once: a stale
# cached transport (WSL restart, firewall change) must not require a manual step.
post() {
  local route=$1 body=${2:-} session=${3:-}
  if [ "$route" = say ]; then
    post_once "$route" "$body" "$session"
    return
  fi
  local out
  out=$(post_once "$route" "$body" "$session")
  if [ $? -ne 0 ]; then
    rm -f "$TRANSPORT_FILE"
    load_channel || return 1
    out=$(post_once "$route" "$body" "$session") || die "连不上 DSH 宿主（$BASE）—— 桌面版在运行吗？"
  fi
  printf '%s' "$out"
}

cmd_list() {
  local out
  out=$(post list '' "$(current_session)")
  case "$out" in
    err*) die "${out#err	}" ;;
  esac
  if [ "$out" = "ok"$'\t'"(no sessions)" ]; then printf '(没有会话)\n'; return; fi
  printf '%s\n' "$out" | awk -F'\t' '
    NF == 0 { next }
    { mark = ($5 == "*") ? "*" : " "; printf "%s %-28s %s\n", mark, $1, ($2 == "" ? "(未命名)" : $2) }
  '
}

cmd_new() {
  local id=$1 out created
  [ -n "$id" ] || die "用法：dsh new <会话id>"
  out=$(post new "$id" "$id")
  case "$out" in
    err*) die "${out#err	}" ;;
  esac
  # The Host may mint its own id; switching to the requested one would point every later
  # command at a session that does not exist. Use what it answered with.
  created=$(printf '%s\n' "$out" | cut -f2)
  [ -n "${created:-}" ] || created=$id
  set_current "$created"
  printf '已新建并切换到会话 %s\n' "$created"
}

cmd_use() {
  local id=$1
  [ -n "$id" ] || die "用法：dsh use <会话id>"
  set_current "$id"
  printf '当前会话：%s\n' "$id"
}

cmd_rm() {
  local id=$1 out
  [ -n "$id" ] || die "用法：dsh rm <会话id>"
  out=$(post rm "$id" "$id")
  case "$out" in
    err*) die "${out#err	}" ;;
  esac
  if [ "$(current_session)" = "$id" ]; then rm -f "$CURRENT_FILE"; fi
  printf '已归档会话 %s\n' "$id"
}

cmd_status() {
  local state session_line landing state_line
  state=$("$CURL" -sS --connect-timeout 1 --max-time 3 -H "x-dsh-wsl-token: $TOKEN" "$BASE/state" 2>/dev/null) || {
    # The cached transport can go stale between two commands (channel restarted, firewall
    # changed): forget it and settle the current one instead of failing once.
    rm -f "$TRANSPORT_FILE"
    load_channel
    state=$("$CURL" -sS --connect-timeout 1 --max-time 3 -H "x-dsh-wsl-token: $TOKEN" "$BASE/state" 2>/dev/null) \
      || die "连不上 DSH 宿主（$BASE）—— 桌面版在运行吗？"
  }
  # A wrong token is a real channel answer now: say it instead of printing it as "state".
  case "$state" in
    err*) die "${state#err	}" ;;
  esac
  session_line=$(current_session)
  [ -n "$session_line" ] || session_line='默认（最近活跃会话）'
  CURRENT_SESSION=$session_line
  # The Host's channel landing (panel setting) and this shell's current session can differ;
  # naming them apart is what stops one being mistaken for the other. Parsed with builtins:
  # `dsh status` should not pay for sed/tr forks on a line of text.
  landing=''
  while IFS= read -r state_line; do
    case "$state_line" in
      session=*) landing=${state_line#session=} ;;
    esac
  done <<< "$state"
  printf '当前会话：%s\n' "${CURRENT_SESSION:-$(current_session)}"
  printf '通道：%s\n' "${state//$'\n'/ }"
  if [ -n "${landing:-}" ]; then printf '面板落点：%s（未用 dsh use 指定时的目标）\n' "$landing"; fi
  printf 'shim：%s\n' "$(command -v dsh || printf '未知')"
  printf '客户端：%s\n' "$CURL"
}

# Stream one turn: `~`-prefixed frames, `~s`/`~a` carry base64 chunks of raw text.
# A connection that fails BEFORE the first frame forgets the cached transport and retries once
# (the recovery the management routes already had); anything after the first frame is not
# retried, so a prompt is never delivered twice.
cmd_say() {
  local session=$1 prompt=$2
  local reason=0 ended=0 line ms steps tin tout breason ok text_reason
  local ticker='' reason_start=0 ack_ticker='' ack_start=0
  local shell_pid=$$ balance_pid='' balance_file='' tick_fd=''
  local got_frame=0 attempt=0 say_exit=0
  local start_us=0 last_status_us=0 step_count=0 last_reason_ms=0
  local DURATION='' TOKENS='' sec='' frac='' tin_text='' tout_text='' reason_note=''
  local steer_pid='' pause_text='' was_paused=0
  local status_shown=0
  # The reader and the frame loop are different processes; a flag file is the channel between
  # them: while it exists the answer is held back so the person can type a clean line.
  pause_flag="$STATE_DIR/pause.$$"
  # The account wallet is fetched in the background from the moment the Host accepts the turn,
  # so the end-of-turn line normally costs nothing. It has its own 3 s budget and is never
  # retried: a slow account service must not hold the prompt open after the answer is printed.
  prefetch_balance() {
    [ -n "$balance_pid" ] && return
    balance_file="$STATE_DIR/balance.$$"
    ( exec "$CURL" -sS --max-time 3 -X POST -H "x-dsh-wsl-token: $TOKEN" --data-raw '' "$BASE/balance" > "$balance_file" 2>/dev/null ) &
    balance_pid=$!
  }
  cleanup_balance() {
    if [ -n "${balance_pid:-}" ]; then
      kill "$balance_pid" 2>/dev/null
      wait "$balance_pid" 2>/dev/null
      balance_pid=''
    fi
    if [ -n "${balance_file:-}" ]; then
      rm -f "$balance_file"
      balance_file=''
    fi
  }
  cleanup_say() {
    stop_steer_reader
    rm -f "$pause_flag" 2>/dev/null
    pause_text=''
  }
  # True while the terminal reader holds the answer back for a compose line.
  paused() { [ -e "$pause_flag" ]; }
  # The step line is ONE line, repainted in place. It used to start and end with a newline, so a
  # 60-step turn scrolled ~60 "已用 … 第 N 步" lines past the reader instead of showing a clock.
  # clear_status erases it and reports whether there was one (the completion line then reuses that
  # row instead of adding a blank one).
  clear_status() {
    if [ "${status_shown:-0}" = 1 ]; then
      printf '\r\033[2K'
      status_shown=0
      return 0
    fi
    return 1
  }
  flush_paused_output() {
    if [ -n "${pause_text:-}" ]; then
      clear_status
      printf '%s' "$pause_text"
      pause_text=''
    fi
  }
  # The turn is over (or being torn down): whatever was held back is the answer, so print it
  # and release the pause before any completion line follows.
  resume_output() {
    rm -f "$pause_flag" 2>/dev/null
    flush_paused_output
  }
  report_balance() {
    [ -n "$balance_pid" ] || return
    local waited=0 reply='' body=''
    # Wait at most ~0.6 s, then abandon the request: the answer is already on screen and the
    # balance is a convenience, never a reason to keep the shell waiting.
    while [ "$waited" -lt 6 ] && kill -0 "$balance_pid" 2>/dev/null; do
      [ -s "$balance_file" ] && break
      sleep 0.1
      waited=$((waited + 1))
    done
    if kill -0 "$balance_pid" 2>/dev/null; then kill "$balance_pid" 2>/dev/null; fi
    wait "$balance_pid" 2>/dev/null
    balance_pid=''
    if [ -r "$balance_file" ]; then IFS= read -r reply < "$balance_file"; fi
    rm -f "$balance_file"
    balance_file=''
    case "$reply" in
      ok*)
        body=${reply#ok}
        body=${body#$'\t'}
        case "$body" in
          '未登录') body='未登录 DeepSeek 账号' ;;
          '暂不可用') return ;;
          '') return ;;
        esac
        printf '账户余额：%s\n' "$body"
        ;;
    esac
  }
  # `~ack` only says the Host accepted the request; the model's first frame can be seconds
  # away when the target conversation carries a large context. A live elapsed counter from
  # that moment makes the wait honest instead of looking frozen.
  stop_ack_ticker() {
    if [ -n "$ack_ticker" ]; then
      kill "$ack_ticker" 2>/dev/null
      wait "$ack_ticker" 2>/dev/null
      ack_ticker=''
      # Never wipe the line the person is typing on.
      if ! paused; then printf '\r\033[2K'; fi
    fi
  }
  # One microsecond clock read without a fork: bash 5's $EPOCHREALTIME is a special variable
  # (all digits after the filter). Older bash falls back to `date`, and the wait to `sleep`.
  clock_us() {
    if [ -n "${EPOCHREALTIME:-}" ]; then
      CLOCK_US=${EPOCHREALTIME//[!0-9]/}
    else
      CLOCK_US=$(($(date +%s%N) / 1000))
    fi
  }
  # `41s` under a minute, `34分18秒` above it: a 2058.0s turn should not read like a timer.
  format_duration_ms() {
    local ms=${1:-0} total
    total=$((ms / 1000))
    if [ "$total" -ge 60 ]; then
      printf -v sec '%02d' $((total % 60))
      DURATION=$((total / 60))分${sec}秒
    else
      DURATION=${total}s
    fi
  }
  # The live-progress lines read like the thinking clock (`0分41秒`) even under a minute.
  format_clock_ms() {
    local ms=${1:-0} total
    total=$((ms / 1000))
    printf -v sec '%02d' $((total % 60))
    DURATION=$((total / 60))分${sec}秒
  }
  # `187` stays readable; `12345` becomes `12.3k` (builtins only: this runs at turn end).
  format_tokens() {
    local n=${1:-0}
    if [ "$n" -ge 1000 ]; then
      printf -v frac '%d' $(((n % 1000) / 100))
      TOKENS=$((n / 1000)).${frac}k
    else
      TOKENS=$n
    fi
  }
  # Zero-fork tick: a FIFO held open read-write gives `read -t` a blocking descriptor that never
  # data or EOF, so a 0.2 s tick costs no `date` and no `sleep` process. The FIFO is unlinked at
  # once; the descriptor (8) stays valid for this process and its ticker subshells.
  ensure_tick_fd() {
    [ -n "${tick_fd:-}" ] && return
    local fifo="${TMPDIR:-/tmp}/dsh-wsl-tick.$$"
    if mkfifo "$fifo" 2>/dev/null; then
      # `exec 8<>file 2>/dev/null` would redirect THIS shell's stderr for the rest of the turn
      # (a bare `exec` applies every redirection permanently), silently swallowing every later
      # error line. The brace group scopes the stderr redirect; fd 8 still survives it.
      if { exec 8<>"$fifo"; } 2>/dev/null; then
        rm -f "$fifo"
        tick_fd=8
        return
      fi
      rm -f "$fifo" 2>/dev/null
    fi
    tick_fd='none'
  }
  tick_wait() {
    if [ "${tick_fd:-none}" = 8 ]; then
      read -r -t 0.2 -u 8 _ || true
    else
      sleep 0.2
    fi
  }
  start_ack_ticker() {
    ensure_tick_fd
    clock_us
    ack_start=$CLOCK_US
    (
      while kill -0 "$shell_pid" 2>/dev/null; do
        if paused; then tick_wait; continue; fi
        clock_us
        total=$(( (CLOCK_US - ack_start) / 1000000 ))
        printf '\r\033[2m… 已送达，等待模型 %d分%02d秒\033[0m' $((total / 60)) $((total % 60))
        tick_wait
      done
    ) &
    ack_ticker=$!
  }
  # The first `~r` only says WHEN reasoning began: the elapsed time up to that point would stay
  # frozen on screen while the model keeps thinking. Keep a live clock instead — it ticks on the
  # same line (carriage return) until the first text arrives.
  stop_reason() {
    local had=$reason
    stop_ack_ticker
    if [ -n "$ticker" ]; then
      kill "$ticker" 2>/dev/null
      wait "$ticker" 2>/dev/null
      ticker=''
    fi
    if [ "$had" = 1 ] && ! paused; then printf '\033[0m\n'; fi
    reason=2
  }
  # The first text frame ends the thinking phase: close the live clock with one honest summary
  # line instead of freezing it mid-number, then leave the terminal to the answer itself.
  finish_thinking() {
    [ "$reason" = 2 ] && return
    local elapsed_ms
    clock_us
    if [ "$reason" = 1 ]; then
      elapsed_ms=$((last_reason_ms + (CLOCK_US - reason_start) / 1000))
    else
      elapsed_ms=$(( (CLOCK_US - start_us) / 1000 ))
    fi
    stop_reason
    if ! paused; then
      format_clock_ms "$elapsed_ms"
      printf '\033[2m⏱ 思考 %s · 开始输出\033[0m\n' "$DURATION"
    fi
    last_status_us=$CLOCK_US
  }
  # After the text started, a step boundary is the natural place for a progress line. The 10 s
  # throttle keeps a 98-step turn to a handful of lines instead of one per step (and the clock
  # read is a builtin, so no `date` process appears in the tick period).
  maybe_step_status() {
    [ "$reason" = 2 ] || return
    paused && return
    clock_us
    [ $(( (CLOCK_US - last_status_us) / 1000 )) -ge 10000 ] || return
    format_clock_ms $(( (CLOCK_US - start_us) / 1000 ))
    if [ "$status_shown" = 1 ]; then
      printf '\r\033[2K'
    else
      # First status after a text run: move off the answer's line, then paint on a quiet one.
      printf '\n\033[2K'
    fi
    printf '\033[2m⏱ 已用 %s · 第 %d 步\033[0m' "$DURATION" "$step_count"
    status_shown=1
    last_status_us=$CLOCK_US
  }
  clock_us
  start_us=$CLOCK_US
  last_status_us=$CLOCK_US
  # An interrupted terminal is not a failure: say so instead of "the connection dropped", and
  # exit with the signal's conventional code. The trap also runs the same cleanup the normal
  # paths use, so no status line, ticker or balance temp file is left behind.
  interrupted=0
  on_interrupt() {
    interrupted=$1
    stop_reason
    cleanup_balance
    cleanup_say
    printf '\ndsh: 已在终端中断，客户端本轮也已停止\n' >&2
    exit "$1"
  }
  # A host crash or a closed connection ends the stream WITHOUT the frames that stop the
  # clock; without this the ticker would keep printing on this terminal forever. The same
  # handler releases the balance request and its temp file on every interruption path.
  # EXIT covers the paths that never reach the cleanup below (a `die` after the stream, an
  # `exit` from a frame branch).
  trap 'on_interrupt 130' INT
  trap 'on_interrupt 143' TERM
  trap 'on_interrupt 129' HUP
  trap 'stop_reason; cleanup_balance; cleanup_say' EXIT
  # While a turn streams the terminal has no prompt. Pressing Enter there holds the answer back
  # and the next line goes into the conversation as a steer (the same `/insert` route the old
  # `dsh insert` command used), so a running `dsh -- "…"` can be talked into without a second window.
  # Only a real terminal gets this: a pipe or a tool shell must not have its stdin read out from
  # under the command that owns it.
  start_steer_reader() {
    [ -t 0 ] || return
    [ "${DSH_WSL_NO_STEER:-}" = 1 ] && return
    printf '\033[2m（等待中：回车暂停输出并插话，输入完再回车；Ctrl+C 中止本轮）\033[0m\n'
    (
      trap 'exit 0' INT TERM HUP
      while IFS= read -r steer_text; do
        steer_text=${steer_text%$'\r'}
        if [ -z "${steer_text//[[:space:]]/}" ]; then
          # A bare Enter holds the answer back so the next line is typed on a quiet terminal;
          # a second empty line cancels. The frame loop sees the flag and buffers instead of
          # printing, the tickers stop painting, and the reader prints the input prompt.
          if [ -e "$pause_flag" ]; then
            rm -f "$pause_flag"
            printf '\r\033[2K已取消插入，继续输出\n'
            continue
          fi
          mkdir -p "$STATE_DIR" 2>/dev/null
          : > "$pause_flag"
          printf '\r\033[2K\033[2m插入内容（回车发送；空行取消）：\033[0m'
          IFS= read -r steer_text || steer_text=''
          steer_text=${steer_text%$'\r'}
          if [ -z "${steer_text//[[:space:]]/}" ]; then
            rm -f "$pause_flag"
            printf '\r\033[2K已取消插入，继续输出\n'
            continue
          fi
          inserted=$(post insert "$steer_text" "$session")
          case "$inserted" in
            err*) printf '\r\033[2K[dsh] 插入失败：%s\n' "${inserted#err	}" ;;
            '') printf '\r\033[2K[dsh] 插入没有回应\n' ;;
            *) printf '\r\033[2K[dsh] 已插入当前对话，继续输出\n' ;;
          esac
          rm -f "$pause_flag"
          continue
        fi
        inserted=$(post insert "$steer_text" "$session")
        case "$inserted" in
          err*) printf '\r\033[2K[dsh] 插入失败：%s\n' "${inserted#err	}" ;;
          '') printf '\r\033[2K[dsh] 插入没有回应\n' ;;
          *) printf '\r\033[2K[dsh] 已插入当前对话\n' ;;
        esac
      done
      # A background job in a shell without job control gets /dev/null as stdin, so the
      # terminal is re-attached explicitly; without this the reader saw EOF at once and
      # typed lines disappeared into the line discipline.
    ) </dev/tty &
    steer_pid=$!
  }
  stop_steer_reader() {
    if [ -n "${steer_pid:-}" ]; then
      kill "$steer_pid" 2>/dev/null
      steer_pid=''
    fi
  }
  start_steer_reader
  stream_turn() {
    got_frame=0
    say_exit=0
    while IFS= read -r line; do
      # `post say` appends this after its stream closes: the exit code reaches the main shell
      # as a frame instead of a temp file, so a turn that ends in `~e` cannot leave a
      # `say.<pid>` file behind for a writer that runs after this shell already exited.
      case "$line" in
        '~exit '*)
          say_exit=${line#'~exit '}
          say_exit=${say_exit//[!0-9]/}
          continue
          ;;
      esac
      # Compose pause handling. The answer held while the person typed is the first thing to
      # release; and because the think line is deliberately not repainted over their input, the
      # clock has to be shown again as soon as output resumes — otherwise the terminal keeps the
      # last frozen number until the next step crosses the status throttle ("the timer stopped
      # after inserting"). `was_paused` tracks the transition, not just a non-empty buffer: a
      # pause during the thinking phase usually buffers no text at all.
      if paused; then
        was_paused=1
      elif [ "$was_paused" = 1 ]; then
        was_paused=0
        flush_paused_output
        if [ "$reason" = 2 ]; then
          last_status_us=0
          maybe_step_status
        fi
      fi
      got_frame=1
      case "$line" in
        '~ack') start_ack_ticker; prefetch_balance ;;
        '~r '*)
          stop_ack_ticker
          ms=${line#'~r '}
          ms=${ms//[!0-9]/}
          [ -n "$ms" ] || ms=0
          last_reason_ms=$ms
          if [ "$reason" != 1 ]; then
            reason=1
            ensure_tick_fd
            clock_us
            reason_start=$CLOCK_US
            (
              while kill -0 "$shell_pid" 2>/dev/null; do
                if paused; then tick_wait; continue; fi
                clock_us
                elapsed=$(( (CLOCK_US - reason_start) / 1000 + ms ))
                total=$((elapsed / 1000))
                printf '\r\033[2m⏱ 思考中… %d分%02d秒\033[0m' $((total / 60)) $((total % 60))
                tick_wait
              done
            ) &
            ticker=$!
          fi
          ;;
        '~t '*) finish_thinking ;;
        '~a '*)
          stop_ack_ticker
          finish_thinking
          if paused; then
            # The person is composing: hold the answer in memory and print it after the insert
            # so their line stays clean (a compose is seconds, so the buffer stays small).
            pause_text+="$(printf '%s' "${line#'~a '}" | base64 -d)"
          else
            clear_status
            printf '%s' "${line#'~a '}" | base64 -d
          fi
          ;;
        '~step '*)
          step_count=$((step_count + 1))
          maybe_step_status
          ;;
        '~p') ;;
        '~x '*)
          stop_reason
          resume_output
          clear_status
          cleanup_balance
          cleanup_say
          text_reason=$(printf '%s' "${line#'~x '}" | base64 -d)
          printf '\ndsh: %s\n' "$text_reason" >&2
          exit 1
          ;;
        '~e '*)
          stop_reason
          # Anything held back by a compose line is the answer; print it before the summary.
          resume_output
          read -r _ ok ms steps tin tout breason <<< "$line"
          ms=${ms:-0}
          ms=${ms//[!0-9]/}
          tin=${tin//[!0-9]/}
          tout=${tout//[!0-9]/}
          [ -n "$tin" ] || tin=0
          [ -n "$tout" ] || tout=0
          text_reason=$(printf '%s' "${breason:-}" | base64 -d 2>/dev/null)
          case "$text_reason" in
            ''|completed|done|finished) reason_note='' ;;
            error) reason_note='（回合出错）' ;;
            timeout) reason_note='（超时）' ;;
            *) reason_note="（${text_reason}）" ;;
          esac
          format_duration_ms "$ms"
          format_tokens "$tin"; tin_text=$TOKENS
          format_tokens "$tout"; tout_text=$TOKENS
          if ! clear_status; then printf '\n'; fi
          printf '✓ 完成 %s · %s 步 · in %s / out %s tok%s\n' \
            "$DURATION" "${steps:-0}" "$tin_text" "$tout_text" "$reason_note"
          # A large landing conversation is the usual reason a terminal turn takes seconds: each
          # message re-sends its whole context. Naming the cause beats letting it look like lag.
          if [ "${tin:-0}" -gt 50000 ] 2>/dev/null; then
            printf '提示：目标会话上下文较大（in %s tok），每回合都要重发；终端聊天可先 %s 建一个精简会话\n' \
              "$tin" '`dsh new terminal`' >&2
          fi
          report_balance
          cleanup_say
          ended=1
          [ "$ok" = 1 ] && exit 0 || exit 1
          ;;
        'err'*) stop_reason; resume_output; clear_status; cleanup_balance; cleanup_say; die "${line#err	}" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < <(post say "$prompt" "$session"; printf '~exit %s\n' "$?")
  }
  stream_turn
  cleanup_say
  # No frame at all + curl failed means the cached transport is wrong, not the turn: forget it,
  # re-probe, and try once more (management routes already recover from a stale cache this way).
  if [ "$got_frame" = 0 ] && [ "${say_exit:-0}" != 0 ] && [ "$attempt" = 0 ]; then
    attempt=1
    rm -f "$TRANSPORT_FILE"
    load_channel || return 1
    stream_turn
    cleanup_say
  fi
  stop_reason
  cleanup_balance
  if [ "$ended" = 1 ]; then return 0; fi
  printf '\n' >&2
  if [ "${say_exit:-0}" != 0 ] && [ "$got_frame" = 0 ]; then
    die "连不上 DSH 宿主（$BASE）—— 桌面版在运行吗？通道在面板里启用了吗？"
  fi
  die "连接在回合结束前断开"
}

# ---------------------------------------------------------------- entry point

[ $# -eq 0 ] && { usage; exit 1; }
case "$1" in
  -h|--help|help) usage; exit 0 ;;
  # Removed commands answer for themselves instead of falling through as a prompt aimed at a
  # session literally named "insert" or "screen".
  insert) die "dsh insert 已移除：等待回复时按一次回车暂停输出，输入内容再回车，就插入当前对话" ;;
  screen) die "dsh screen 已移除：终端历史会随消息自动带给模型，不需要手动读取" ;;
esac

# `use` touches one local file: no channel, no network, no probe.
case "$1" in
  use) cmd_use "${2:-}"; exit 0 ;;
esac

# A message only leaves the terminal when it is marked as one: `dsh -- …` (current session) or
# `dsh <会话id> -- …` (named session). Everything else is a COMMAND, so a typo answers "no such
# command" instead of being sent to the model as a prompt — the shell strips quoting before this
# script ever sees it, which is why the marker is `--` and not "was it quoted".
if [ "$1" = "--" ]; then
  shift
  [ $# -gt 0 ] || die "用法：dsh -- <问题>（也可以写成 dsh -- \"问题\"）"
  load_channel || exit 1
  cmd_say "$(current_session)" "$*"
  exit 0
fi
if [ "${2:-}" = "--" ]; then
  target=$1
  shift 2
  [ $# -gt 0 ] || die "用法：dsh <会话id> -- <问题>"
  load_channel || exit 1
  cmd_say "$target" "$*"
  exit 0
fi

case "$1" in
  list|ls|new|rm|archive|status) : ;;
  *) die "不存在此命令：$1（输入 dsh help 查看用法；发消息请用 dsh -- \"问题\"）" ;;
esac

load_channel || exit 1

case "$1" in
  list|ls) cmd_list; exit 0 ;;
  new) cmd_new "${2:-}"; exit 0 ;;
  rm|archive) cmd_rm "${2:-}"; exit 0 ;;
  status) cmd_status; exit 0 ;;
esac
