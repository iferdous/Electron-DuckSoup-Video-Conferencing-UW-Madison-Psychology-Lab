// Copy docker/ducksoup/env.example -> docker/ducksoup/.env if it doesn't exist yet.
// Cross-platform stand-in for `cp -n` (cmd.exe on Windows has no `cp`) used by `npm run media:up`.
import { existsSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mediaDir = join(here, '..', 'docker', 'ducksoup')
const target = join(mediaDir, '.env')
const source = join(mediaDir, 'env.example')

if (existsSync(target)) {
  console.log('docker/ducksoup/.env already exists; leaving it untouched.')
} else {
  copyFileSync(source, target)
  console.log('Created docker/ducksoup/.env from env.example.')
}
