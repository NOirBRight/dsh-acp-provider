import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sections = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']
const hostPackage = /^@deepseek-ai\/dsh(?:-|$)/
const openRange = /^>=(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const artifact = /^(?:https?:\/\/|git(?:\+[^:]+)?:|github:|file:)/i
const manifestPath = resolve(process.argv[2] ?? fileURLToPath(new URL('../package.json', import.meta.url)))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const invalid = []

for (const section of sections) {
  for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
    if (!hostPackage.test(name) || (typeof specifier === 'string' && artifact.test(specifier))) continue
    if (typeof specifier !== 'string' || !openRange.test(specifier)) invalid.push(`${section}.${name}: ${specifier}`)
  }
}

if (invalid.length > 0) {
  console.error('DSH package ranges must be an unbounded >= minimum or a pinned install artifact:')
  for (const entry of invalid) console.error(`- ${entry}`)
  process.exitCode = 1
} else {
  console.log('DSH package ranges allow future versions.')
}
