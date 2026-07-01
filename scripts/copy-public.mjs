import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const source = resolve('public')
const target = resolve('out/renderer')

if (existsSync(source)) {
  await mkdir(target, { recursive: true })
  await cp(source, target, { recursive: true })
}
