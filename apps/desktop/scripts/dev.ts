import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { buildDesktopBundles } from './build'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(__dirname, `..`)
const webDir = path.resolve(desktopDir, `../web`)
const require = createRequire(import.meta.url)
const electronBinary = require(`electron`) as unknown as string

const DEV_PORT = Number(process.env.MD_DESKTOP_DEV_PORT ?? 5175)
const DEV_URL = `http://127.0.0.1:${DEV_PORT}/`

async function waitForServer(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 304)
        return
    }
    catch {
      // Server not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Vite dev server at ${url}`)
}

async function run(): Promise<void> {
  await buildDesktopBundles()

  const viteBin = path.resolve(webDir, `node_modules/.bin/vite`)
  const viteProc = spawn(viteBin, [`--host`, `127.0.0.1`, `--port`, String(DEV_PORT), `--strictPort`], {
    cwd: webDir,
    env: {
      ...process.env,
      SERVER_ENV: `DESKTOP`,
    },
    stdio: `inherit`,
    shell: process.platform === `win32`,
  })

  let electronProc: ReturnType<typeof spawn> | null = null
  let shuttingDown = false

  const shutdown = (code = 0) => {
    if (shuttingDown)
      return
    shuttingDown = true
    if (electronProc && !electronProc.killed)
      electronProc.kill(`SIGTERM`)
    if (!viteProc.killed)
      viteProc.kill(`SIGTERM`)
    process.exit(code)
  }

  process.on(`SIGINT`, () => shutdown(0))
  process.on(`SIGTERM`, () => shutdown(0))

  viteProc.once(`exit`, (code) => {
    if (!shuttingDown) {
      console.error(`[md-desktop] Vite dev server exited unexpectedly (${code ?? `null`})`)
      shutdown(code ?? 1)
    }
  })

  await waitForServer(DEV_URL)

  electronProc = spawn(electronBinary, [desktopDir], {
    cwd: desktopDir,
    env: {
      ...process.env,
      MD_DESKTOP_DEV_URL: DEV_URL,
    },
    stdio: `inherit`,
  })

  electronProc.once(`exit`, (code) => {
    shutdown(code ?? 0)
  })
}

run().catch((error) => {
  console.error(`[md-desktop] dev runner failed:`, error)
  process.exit(1)
})
