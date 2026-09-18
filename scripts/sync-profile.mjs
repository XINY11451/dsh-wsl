// Copy this checkout into a DSH profile's node_modules.
//
// A `file:` dependency is a COPY, not a link, so editing the checkout does not
// change what DSH loads. Splitting the plugin into `lib/` made that easier to
// get wrong (a stale copy used to be one file, now it is a tree), so this
// script replaces the copy wholesale and verifies the result.
//
//   node scripts/sync-profile.mjs [profileDir]
//
// Defaults to `%USERPROFILE%/.dsh/profiles/web/node_modules/dsh-wsl`.

import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(
  process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-wsl'),
)

if (!existsSync(packageRoot)) throw new Error(`source package not found: ${packageRoot}`)
if (!existsSync(dirname(target))) {
  throw new Error(`profile node_modules not found: ${dirname(target)} — is the profile path right?`)
}

// Everything the plugin needs at runtime; deliberately not the tests or assets.
const entries = ['index.js', 'package.json', 'cordis.patch.yml', 'README.md', 'README.zh-CN.md', 'LICENSE', 'lib']

for (const entry of entries) {
  const from = join(packageRoot, entry)
  if (!existsSync(from)) throw new Error(`missing in source: ${entry}`)
  const to = join(target, entry)
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
}

// A sync that silently skipped `lib/` would leave a plugin that imports
// nothing, so report what actually landed and fail when it is short.
const copied = readdirSync(join(target, 'lib'), { recursive: true })
  .filter((name) => String(name).endsWith('.js')).length
if (copied < 5) throw new Error(`expected the lib/ modules to be copied, found ${copied} .js files`)

console.log(`synced ${entries.length} entries to ${target}`)
console.log(`  index.js  ${statSync(join(target, 'index.js')).size} bytes`)
console.log(`  lib/*.js  ${copied} modules`)
