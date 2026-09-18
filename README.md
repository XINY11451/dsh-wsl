# dsh-wsl

[English](README.md) | [简体中文](README.zh-CN.md)

A model-facing **WSL** tool plugin for DeepSeek Harness (DSH). It lets an agent run Linux commands through `wsl.exe` directly — no hand-written `.sh` scripts or `pwsh` wrappers.

## Tools

The plugin registers three tools:

| Tool | Purpose |
|---|---|
| `wsl` | Run a Linux command and return `stdout`/`stderr` with exit-code, timeout and truncation markers. |
| `wsl-path` | Convert between Windows and WSL paths via `wslpath`. |
| `wsl-env` | Summarize the WSL environment (distros, kernel, cpu, mem, disk). |

### `wsl`

Runs:

```
wsl.exe -d <distro> -e bash -lc "cd <workdir> && <command>"
```

and returns `stdout`/`stderr` with `[exit code: N]` / `[killed by signal: ...]` /
`[timed out after Nms; the command was killed]` / `[output truncated: ...]` markers.

A script longer than the Windows command-line limit (32767 characters) is fed to
`wsl.exe -d <distro> -e bash -ls` on **stdin** instead, so long commands work
without any size ceiling.

### `wsl-path`

Converts a path in either direction: `C:\Users\me\a.txt` -> `/mnt/c/Users/me/a.txt`
or `/home/me/a.txt` -> `\\wsl.localhost\Ubuntu-22.04\home\me\a.txt`. Direction is
auto-detected from the path, or forced with `direction: 'win' | 'linux'`.

### `wsl-env`

Returns the distribution list, the probed distro, kernel, CPU count, memory and
disk usage so an agent knows what it is running on. Takes an optional `distro`.
A probe that fails is reported in the summary instead of being dropped, and an
unknown distro is an error rather than a partial answer.

## Install

1. Add the package to your DSH profile (`profiles/<profile>/package.json`):

   ```json
   { "dependencies": { "dsh-wsl": "file:<path-to-this-repo>" } }
   ```

   or run `dsh plugin add --profile <profile> file:<path-to-this-repo>`.

2. Add a `tool-wsl` row to an agent preset's `agent.cordis.yml`:

   ```yaml
   - id: tool-wsl
     name: 'dsh-wsl'
   ```

3. Restart DSH.

## `wsl` parameters

| Param | Required | Type | Notes |
|---|---|---|---|
| `command` | yes | string | Linux command to execute |
| `description` | yes | string | short UI label |
| `workdir` | no | string | Linux path (`/home/me`, `~/src`) or Windows path, default `~` |
| `timeoutMs` | no | number | timeout in milliseconds; the process is killed and the result marked as timed out |
| `distro` | no | string | WSL distribution name, default `Ubuntu-22.04` |
| `env` | no | object | extra environment variables to export (keys must be valid shell names) |
| `allowDangerous` | no | boolean | set `true` to run destructive commands |
| `translatePaths` | no | boolean | default `true`; set `false` to pass `command` through verbatim |

## Notes

- Each call runs in a fresh shell — no cwd/variables/functions persist between calls.
- The default distro is `Ubuntu-22.04`; override it per call with the `distro` argument or globally with the `DSH_WSL_DISTRO` environment variable. Edit `DEFAULT_DISTRO` in `index.js` to change the fallback.
- An unknown distro is reported as a clear error (`distribution "X" is not registered`) instead of a raw `-1` exit code.
- Windows paths in `command` and `workdir` are translated to `/mnt/...` automatically:
  - `C:\Users\me\a.txt` -> `/mnt/c/Users/me/a.txt`, and paths containing spaces work in either slash style (`C:\Program Files\Git` and `C:/Program Files/Git` both -> `/mnt/c/Program Files/Git`);
  - `\\wsl.localhost\<distro>\home\x` and `\\wsl$\<distro>\home\x` -> `/home/x`;
  - a single lowercase letter followed by `/` (`a:/b`) is left alone, since ordinary text is far more likely than a drive path there;
  - set `translatePaths: false` when the path belongs to a **Windows** program launched through interop — WSL does not translate `/mnt/c/...` back, so `notepad.exe C:\file.txt` needs its original spelling.
- A `~` in `workdir` or in a `wsl-path` argument is expanded by the shell (`~/my dir` works). Any other path is single-quoted, so `$VAR` inside a path is **not** expanded.
- Output is capped at 64 KiB per stream. The tail is kept and the marker names the spill file holding the **complete** stream, so nothing is unrecoverable:

  ```
  [stdout truncated: kept the last 65536 of 1288895 bytes; full stream: C:\...\stdout.log]
  ```
- `timeoutMs` also kills the Linux-side process (the provider uses `taskkill /T /F` on Windows).
- Destructive commands are refused unless the call passes `allowDangerous: true`. The guard checks the *final* command string, so nested forms count, and it covers the separated/long spellings too: `rm -rf`, `rm -r -f`, `rm -R --force`, `rm --recursive --force`, `sudo rm -r -f`, `bash -c "rm -rf /"`, `find . -exec rm -rf {} +`. Obfuscated spellings are normalized before matching (`rm$IFS-rf`, `rm${IFS}-rf`, `\rm -rf`, `$(which rm) -rf`). It also refuses `dd` onto a block device, `mkfs`/partitioning/wiping tools, power control, redirection onto a block device, and fork bombs.
- Repeated launcher noise is stripped from stderr: the localhost-proxy warning and procps' `screen size is bogus` line.
- Uses `wsl.exe -e` (`--exec`) so quoting and `$VAR` expansion behave like a normal shell; the default `--` pass-through mangles single quotes and variables.

## Install from the plugin list

The package declares a `dsh.bundle` manifest (see `package.json`), so once the
repository is listed it can be installed by name, e.g. `dsh plugin add dsh-wsl`,
and storefronts will offer it for one-click install. Installing from a local
path (`file:`) as shown above keeps working either way.

## How it works

The plugin is a cordis module that injects the host-plane `tools` and
`subprocess` registries:

- `apply()` registers three tools, each with a JSON-schema parameter definition,
  an output schema, a `render` hook and an async `execute`.
- Every call goes through one spawn path (`spawnWsl`): `wsl.exe -d <distro> -e
  bash -lc "<exports; cd workdir && command>"` through the host `subprocess`
  service, with stdout/stderr capped at 64 KiB (spilling to disk up to 64 MiB), a
  3 s grace period after abort, and an optional `timeoutMs` that aborts the call.
  The plugin's own probes additionally get a 30 s ceiling so a wedged WSL service
  cannot hang a tool call forever.
- `env` entries are exported at the front of the command so they reach the
  Linux side reliably; Windows drive paths are rewritten to `/mnt/...` before
  the command is built.
- Output is returned as `{ exitCode, signal, timedOut, truncated, stdout, stderr,
  stdoutTotalBytes, stdoutDroppedBytes, stderrTotalBytes, stderrDroppedBytes,
  stdoutSpillPath, stderrSpillPath }`; the `render` hook formats it into text
  with the markers listed above.
- A destructive-command guard runs on the final command string before dispatch
  and refuses matched patterns unless `allowDangerous` is set.

The plugin publishes no services of its own, so it sits loose in an agent
preset without a realm.

## Development

The plugin is plain ESM with no build step or runtime dependencies outside the
DSH host plane. Iterate by pointing a profile dependency at the checkout:

```json
{ "dependencies": { "dsh-wsl": "file:/path/to/dsh-wsl" } }
```

then restart DSH and exercise the tools from a session that uses a preset
containing the `tool-wsl` row.

### Tests

```sh
npm test          # 100+ checks against real WSL, with a shim standing in for ctx.subprocess
npm run test:real # the same seam facts checked against the REAL DSH provider
```

`npm test` substitutes only `ctx.subprocess`, with a shim that reproduces the
seam's bounded tail windows, spill files and termination ladder, and drives the
three tools against the real WSL installation. It covers path translation,
workdir quoting, the destructive guard, exit-code/timeout/truncation markers,
`wsl-path`, `wsl-env` and argument validation.

`npm run test:real` verifies the seam facts a shim cannot vouch for — that
`readFrom(0).nextOffset` is the whole-stream total, that the spill file holds the
complete stream, and that a timeout really kills the Linux side of `wsl.exe`. It
needs a DSH installation and is skipped unless pointed at one:

```sh
DSH_SUBPROCESS_LOCAL=/path/to/dsh/node_modules npm run test:real
```

Customization points live at the top of `index.js`: `DEFAULT_DISTRO`,
`DEFAULT_WORKDIR`, the output caps, the grace period, the internal timeout
ceiling and the destructive-pattern list.

## Listing

The repository carries the `dsh-plugin` topic and is listed under the `wsl`
category of the awesome-dsh-plugin community list.
