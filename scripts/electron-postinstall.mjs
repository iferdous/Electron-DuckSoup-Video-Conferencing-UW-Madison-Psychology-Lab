import { spawnSync } from 'node:child_process'

const isHostedBuild = process.env.RENDER === 'true' || process.env.NODE_ENV === 'production'

if (isHostedBuild) {
  console.log('Skipping Electron native dependency install for hosted signaling build.')
  process.exit(0)
}

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const result = spawnSync(command, ['electron-builder', 'install-app-deps'], {
  stdio: 'inherit'
})

process.exit(result.status ?? 1)
