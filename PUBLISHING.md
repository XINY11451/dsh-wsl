# Publishing

Maintainer notes for releasing this plugin. Four channels carry the same commit
and they are not interchangeable.

| Channel | What it is | What ships it |
|---|---|---|
| GitHub Release asset | what the plugin market installs from | `.github/workflows/release.yml`, on a `v*` tag |
| npm | the package `dsh-wsl-tool` | the same workflow, as its last step |
| Catalog entry | the listing line and the install command the market shows | a PR to `awesome-dsh-plugin/awesome-dsh-plugin` |
| Your working profile | the copy DSH actually loads | `npm run sync`, then a DSH restart |

## The name split is deliberate

The npm package is **`dsh-wsl-tool`**, not `dsh-wsl`. The registry answers

```
403 Forbidden - PUT https://registry.npmjs.org/dsh-wsl -
Package name too similar to existing package is-wsl
```

for the repository name. A name policy is not a permission problem: no token, no
2FA bypass, and no scope changes it, and the name stays unclaimable. The
repository, the plugin (`tool-wsl`), and the market listing keep the `dsh-wsl`
name.

Nothing else depends on that name, because `cordis.patch.yml` names its entry by
**relative path**:

```yaml
- insert:
    - id: tool-wsl
      name: './index.js'
```

DSH anchors a relative `name:` beside the patch file that declared it
(`anchorInsertedPluginNames` in `@deepseek-ai/dsh-app-boot`), so this row loads
this bundle's own `index.js` whatever the install folder is called —
`node_modules/dsh-wsl-tool` from npm, `node_modules/dsh-wsl` in a local `file:`
profile. A bare package name would resolve in only one of those layouts, and
would silently couple this file to the registry name. `test/smoke.mjs` asserts
both that the entry stays relative and that it resolves.

## Release checklist

1. Green locally:

   ```sh
   npm test                                           # shim backend, real WSL
   DSH_SUBPROCESS_LOCAL=/path/to/dsh/node_modules npm run test:real
   ```

2. Bump, sync, commit, tag, push:

   ```sh
   npm version <x.y.z> --no-git-tag-version
   npm run sync                 # into the profile copy DSH loads
   git add -A && git commit -m "..."
   git tag -a v<x.y.z> -m "..."
   git push origin main && git push origin v<x.y.z>
   ```

   `npm run sync` defaults to
   `%USERPROFILE%/.dsh/profiles/web/node_modules/dsh-wsl` — the folder the
   profile's dependency key created, which need not match the npm name. Pass a
   path to target another profile. Restart DSH afterwards: the plugin is imported
   once at load.

3. The tag runs the pipeline. The order is deliberate — the release asset goes
   **first** because it is the market's critical path, then npm, so a failing npm
   publish fails the run loudly without withholding the release.

   The build step asks `npm pack --silent` for the tarball name (it follows
   `package.json`, so it is `dsh-wsl-tool-<version>.tgz`) and copies it to
   `dsh-wsl.tgz`, which is the fixed name the catalog's URL points at. Never
   rename that copy: the market install breaks the moment the asset is not called
   `dsh-wsl.tgz`, and `--latest` is what keeps `releases/latest` resolving to it.

4. Verify each channel.

   **CI** — a check annotation is readable anonymously, unlike the job log:

   ```sh
   curl -s "https://api.github.com/repos/XINY11451/dsh-wsl/actions/runs?per_page=5"
   curl -s "https://api.github.com/repos/XINY11451/dsh-wsl/check-runs/<id>/annotations"
   ```

   A successful publish leaves `published <version> to npm`; a failure leaves
   `npm publish failed: <the npm error lines>`, which is why the workflow turns
   npm's stderr into `::error::` instead of only printing it.

   **npm**:

   ```sh
   curl -s https://registry.npmjs.org/dsh-wsl-tool      # dist-tags.latest
   npm view dsh-wsl-tool version --registry https://registry.npmjs.org
   ```

   Fetching `dist.tarball` and unpacking it is the honest check — it proves the
   artifact, not just the metadata. Scripted requests to `npmjs.com`'s HTML hit a
   Cloudflare challenge; the registry API is the source of truth.

   **Market asset** (this is what users install, and it is independent of npm):

   ```sh
   curl -sL -o /tmp/a.tgz https://github.com/XINY11451/dsh-wsl/releases/latest/download/dsh-wsl.tgz
   tar -xzOf /tmp/a.tgz package/package.json | grep '"version"'
   ```

   **Catalog**: the catalog's generated data is at
   <https://awesome-dsh-plugin.com/plugins.json> — look up `dsh-wsl` and read
   `npm`, `version`, `downloads`, `install`, `tarball`.

## The catalog entry

The listing lives at `data/plugins/XINY11451__dsh-wsl.yml` in
`awesome-dsh-plugin/awesome-dsh-plugin`, one file per plugin. Only
`description.en` is required; `description.zh` is optional. Edit it through a
one-file PR (the web UI's pencil button forks and proposes the change).

Two of its keys are hand-written and must stay:

- `tarball:` — the fixed release URL above. It is what the market's `install`
  command points at today.
- `url` / `name` / `category` — `category: wsl`.

Everything else about the entry is **generated** and must never be written by
hand: `npm`, `version`, `downloads`, `screenshots`, and `install`. In particular
`scripts/probe-npm.mjs` reads `package.json`'s `name` from the repository's
`HEAD`, then accepts the package only when the registry document's
`versions[latest].repository.url` contains `<owner>/<repo>`
(case-insensitively — that check is what stops name squatting). So keep
`repository` in `package.json` accurate, or the catalog stops discovering the npm
package. "Not published" verdicts are re-probed daily, so a freshly published
version can take a day to appear; when it does, `install` switches from the
tarball URL to `dsh plugin --profile web add dsh-wsl-tool`.

## Things that bite

- **A tag event runs the workflow from the tag's commit.** To change the
  pipeline you must commit *and cut a new tag*; re-running an old run reuses the
  workflow it was created with, and moving a tag is not a fix.
- **Job logs need authentication; annotations do not.** There is no `gh` and no
  `GITHUB_TOKEN` on the maintainer machine, so anything that must be diagnosable
  without a credential belongs in an annotation.
- **An interactive `npm publish` asks for a one-time password** and cannot be
  driven from an unattended run. CI authenticates with a granular token that may
  bypass 2FA, stored as the `NPM_TOKEN` secret; with the secret absent the step
  skips with a notice instead of failing. Now that the package exists, OIDC
  trusted publishing is the better replacement.
- **`publishConfig.registry` in `package.json` wins** over a developer's
  `~/.npmrc` mirror, so a mirror configured for reads cannot intercept a publish.
- **The profile's dependency key is not the package name** (`dsh-wsl` versus
  `dsh-wsl-tool`). Do not "fix" that by hand: the profile is managed by pnpm, and
  its `pnpm-lock.yaml`, `node_modules/.modules.yaml`, and
  `node_modules/.package-map.json` all record the key. The relative patch entry
  means the difference costs nothing.
- **Short unscoped names ending in `-wsl` are a minefield.** `dsh-wsl` collides
  with `is-wsl`; longer suffixed names such as `dsh-wsl-workspace` are published
  by other authors and pass. Prefer npm's suggestion (a scope) or a clearly
  suffixed name, and check the registry before tagging.
