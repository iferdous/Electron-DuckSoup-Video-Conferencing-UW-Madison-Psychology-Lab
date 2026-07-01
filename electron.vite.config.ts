import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // MediaPipe's model and WASM runtime are bundled locally so smile detection works
    // without an internet dependency in the lab.
    publicDir: resolve('public'),
    // Pin the dev server origin so it matches DUCKSOUP_ALLOWED_WS_ORIGINS (the DuckSoup
    // SFU validates the WebSocket Origin header by exact match). Keep these ports in sync
    // with docker/ducksoup/.env.
    server: {
      port: 5173,
      strictPort: true
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
