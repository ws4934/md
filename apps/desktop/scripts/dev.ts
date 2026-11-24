import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { terminateProcessTree } from '../src/main/acp/process'
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
    detached: process.platform !== `win32`,
    shell: process.platform === `win32`,
  })

  let electronProc: ReturnType<typeof spawn> | null = null
  let shuttingDown = false

  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown)
      return
    shuttingDown = true

    const tasks: Promise<void>[] = []
    if (electronProc) {
      // Give Electron enough time for before-quit -> acpHost.dispose() before escalating.
      tasks.push(terminateProcessTree(electronProc, { gracefulTimeoutMs: 4_500, forceTimeoutMs: 1_500 }))
    }
    tasks.push(terminateProcessTree(viteProc, { gracefulTimeoutMs: 2_000, forceTimeoutMs: 1_000 }))

    await Promise.allSettled(tasks)
    process.exit(code)
  }

  for (const signal of [`SIGINT`, `SIGTERM`, `SIGHUP`] as const) {
    process.on(signal, () => {
      void shutdown(0)
    })
  }

  viteProc.once(`exit`, (code) => {
    if (!shuttingDown) {
      console.error(`[md-desktop] Vite dev server exited unexpectedly (${code ?? `null`})`)
      void shutdown(code ?? 1)
    }
  })

  try {
    await waitForServer(DEV_URL)
  }
  catch (error) {
    await shutdown(1)
    throw error
  }

  if (shuttingDown)
    return

  const extraElectronArgs = process.env.MD_DESKTOP_ELECTRON_ARGS
    ? process.env.MD_DESKTOP_ELECTRON_ARGS.split(/\s+/).filter(Boolean)
    : []

  electronProc = spawn(electronBinary, [desktopDir, ...extraElectronArgs], {
    cwd: desktopDir,
    env: {
      ...process.env,
      MD_DESKTOP_DEV_URL: DEV_URL,
    },
    stdio: `inherit`,
    detached: process.platform !== `win32`,
  })

  electronProc.once(`exit`, (code) => {
    void shutdown(code ?? 0)
  })
}

run().catch((error) => {
  console.error(`[md-desktop] dev runner failed:`, error)
  process.exit(1)
})
