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
const requireFromWeb = createRequire(path.join(webDir, `package.json`))

const DEV_PORT = Number(process.env.MD_DESKTOP_DEV_PORT ?? 5175)
const DEV_URL = `http://127.0.0.1:${DEV_PORT}/`

export interface WaitForServerOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  shouldAbort?: () => boolean
  fetchFn?: typeof fetch
}

export async function waitForServer(url: string, options: WaitForServerOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 45_000
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const fetchFn = options.fetchFn ?? fetch
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (options.shouldAbort?.())
      throw new Error(`Aborted waiting for Vite dev server at ${url}`)
    try {
      const res = await fetchFn(url)
      if (res.ok || res.status === 304)
        return
    }
    catch {
      // Server not listening yet.
    }
    if (options.shouldAbort?.())
      throw new Error(`Aborted waiting for Vite dev server at ${url}`)
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`Timed out waiting for Vite dev server at ${url}`)
}

export function exitCodeFromProcessExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  defaultCode: number,
): number {
  if (code !== null)
    return code
  if (signal !== null)
    return 1
  return defaultCode
}

export function createShutdownController(
  onCleanup: () => Promise<unknown>,
  onExit: (code: number) => void,
): {
  readonly isShuttingDown: boolean
  shutdown: (code?: number) => Promise<void>
} {
  let inFlight: Promise<void> | null = null
  let exitCode = 0

  return {
    get isShuttingDown() {
      return inFlight !== null
    },
    shutdown(code = 0): Promise<void> {
      if (!inFlight) {
        exitCode = code
        inFlight = (async () => {
          try {
            await onCleanup()
          }
          finally {
            onExit(exitCode)
          }
        })()
      }
      return inFlight
    },
  }
}

async function run(): Promise<void> {
  await buildDesktopBundles({ sourcemap: true })

  const electronBinary = require(`electron`) as unknown as string
  const viteCliEntry = requireFromWeb.resolve(`vite/bin/vite.js`)
  const viteProc = spawn(
    process.execPath,
    [viteCliEntry, `--mode`, `desktop`, `--host`, `127.0.0.1`, `--port`, String(DEV_PORT), `--strictPort`],
    {
      cwd: webDir,
      env: {
        ...process.env,
        SERVER_ENV: `DESKTOP`,
      },
      stdio: `inherit`,
      detached: process.platform !== `win32`,
    },
  )

  let electronProc: ReturnType<typeof spawn> | null = null
  const controller = createShutdownController(
    async () => {
      const tasks: Promise<void>[] = []
      if (electronProc) {
        // Give Electron enough time for before-quit -> acpHost.dispose() before escalating.
        tasks.push(terminateProcessTree(electronProc, { gracefulTimeoutMs: 4_500, forceTimeoutMs: 1_500 }))
      }
      tasks.push(terminateProcessTree(viteProc, { gracefulTimeoutMs: 2_000, forceTimeoutMs: 1_000 }))
      await Promise.allSettled(tasks)
    },
    code => process.exit(code),
  )

  for (const signal of [`SIGINT`, `SIGTERM`, `SIGHUP`] as const) {
    process.on(signal, () => {
      void controller.shutdown(0)
    })
  }

  const onFatalError = (error: unknown) => {
    console.error(`[md-desktop] fatal error:`, error)
    void controller.shutdown(1)
  }
  process.once(`uncaughtException`, onFatalError)
  process.once(`unhandledRejection`, onFatalError)

  viteProc.once(`error`, (error) => {
    if (!controller.isShuttingDown) {
      console.error(`[md-desktop] Failed to start Vite dev server:`, error)
      void controller.shutdown(1)
    }
  })

  viteProc.once(`exit`, (code, signal) => {
    if (!controller.isShuttingDown) {
      console.error(`[md-desktop] Vite dev server exited unexpectedly (${code ?? signal ?? `null`})`)
      void controller.shutdown(exitCodeFromProcessExit(code, signal, 1))
    }
  })

  try {
    await waitForServer(DEV_URL, { shouldAbort: () => controller.isShuttingDown })
  }
  catch (error) {
    await controller.shutdown(1)
    throw error
  }

  if (controller.isShuttingDown)
    return

  const extraElectronArgs = process.env.MD_DESKTOP_ELECTRON_ARGS
    ? process.env.MD_DESKTOP_ELECTRON_ARGS.split(/\s+/).filter(Boolean)
    : []

  try {
    electronProc = spawn(electronBinary, [desktopDir, ...extraElectronArgs], {
      cwd: desktopDir,
      env: {
        ...process.env,
        MD_DESKTOP_DEV_URL: DEV_URL,
      },
      stdio: `inherit`,
      detached: process.platform !== `win32`,
    })
  }
  catch (error) {
    await controller.shutdown(1)
    throw error
  }

  electronProc.once(`error`, (error) => {
    if (!controller.isShuttingDown) {
      console.error(`[md-desktop] Failed to start Electron:`, error)
      void controller.shutdown(1)
    }
  })

  electronProc.once(`exit`, (code, signal) => {
    void controller.shutdown(exitCodeFromProcessExit(code, signal, 0))
  })
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  run().catch((error) => {
    console.error(`[md-desktop] dev runner failed:`, error)
    process.exit(1)
  })
}
