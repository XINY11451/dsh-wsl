# dsh-wsl

[English](README.md) | [简体中文](README.zh-CN.md)

A model-facing **WSL** tool plugin for DeepSeek Harness (DSH). It lets an agent run Linux commands through `wsl.exe` directly — no hand-written `.sh` scripts or `pwsh` wrappers.

## What it does

Registers a `wsl` tool that runs:

```
wsl.exe -d Ubuntu-22.04 -e bash -lc "cd <workdir> && <command>"
```

and returns `stdout`/`stderr` with exit-code markers.

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

## Parameters

| Param | Required | Type | Notes |
|---|---|---|---|
| `command` | yes | string | Linux command to execute |
| `description` | yes | string | short UI label |
| `workdir` | no | string | WSL/Linux path, default `~` |
| `timeoutMs` | no | number | timeout in milliseconds |

## Notes

- Each call runs in a fresh `bash -lc` shell — no cwd/variables/functions persist between calls.
- The distro is hardcoded to `Ubuntu-22.04`; edit `DEFAULT_DISTRO` in `index.js` to change it.
- Uses `wsl.exe -e` (`--exec`) so quoting and `$VAR` expansion behave like a normal shell; the default `--` pass-through mangles single quotes and variables.

## Install from the plugin list

The package declares a `dsh.bundle` manifest (see `package.json`), so once the
repository is listed it can be installed by name, e.g. `dsh plugin add dsh-wsl`,
and storefronts will offer it for one-click install. Installing from a local
path (`file:`) as shown above keeps working either way.

## How it works

The plugin is a cordis module that injects the host-plane `tools` and
`subprocess` registries:

- `apply()` registers a single `wsl` tool with a JSON-schema parameter
  definition, an output schema, a `render` hook and an async `execute`.
- `execute()` spawns `wsl.exe -d Ubuntu-22.04 -e bash -lc "<cd workdir && command>"`
  through the host `subprocess` service, with stdin ignored, stdout/stderr
  capped at 64 KiB (spilling to disk up to 64 MiB), a 3 s grace period after
  abort, and an optional `timeoutMs` that aborts the call.
- Output is returned as `{ exitCode, signal, stdout, stderr, truncated }`;
  the `render` hook formats it into text with `[exit code: N]` / `[killed by
  signal: ...]` / `[output truncated]` markers.

The plugin publishes no services of its own, so it sits loose in an agent
preset without a realm.

## Development

The plugin is plain ESM with no build step or runtime dependencies outside the
DSH host plane. Iterate by pointing a profile dependency at the checkout:

```json
{ "dependencies": { "dsh-wsl": "file:/path/to/dsh-wsl" } }
```

then restart DSH and exercise the `wsl` tool from a session that uses a preset
containing the `tool-wsl` row.

Customization points live at the top of `index.js`: `DEFAULT_DISTRO`,
`DEFAULT_WORKDIR`, the output caps and the grace period. The distribution is
currently hardcoded to `Ubuntu-22.04`.

## Listing

The repository carries the `dsh-plugin` topic and is listed under the `wsl`
category of the awesome-dsh-plugin community list.
