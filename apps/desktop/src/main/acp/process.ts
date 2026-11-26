import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const PATH_SENTINEL = `__MD_LOGIN_PATH__`
let cachedLoginPath: string | null = null
let loginPathPromise: Promise<string> | null = null

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue)
    return []
  return pathValue.split(path.delimiter).filter(Boolean)
}

function mergePathEntries(...lists: string[][]): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const list of lists) {
    for (const entry of list) {
      const normalized = entry.trim()
      if (!normalized || seen.has(normalized))
        continue
      seen.add(normalized)
      merged.push(normalized)
    }
  }
  return merged.join(path.delimiter)
}

function defaultPosixFallbackPaths(): string[] {
  const home = os.homedir()
  return [
    path.join(home, `.volta`, `bin`),
    path.join(home, `.local`, `bin`),
    path.join(home, `.npm-global`, `bin`),
    path.join(home, `.pnpm`),
    path.join(home, `Library`, `pnpm`),
    `/opt/homebrew/bin`,
    `/opt/homebrew/sbin`,
    `/usr/local/bin`,
    `/usr/bin`,
    `/bin`,
  ]
}

/**
 * GUI-launched Electron apps on macOS/Linux inherit a minimal PATH.
 * Query the user's login shell once so CLIs installed via Volta/Homebrew/nvm are found.
 */
export async function resolveLoginShellPath(options: { force?: boolean } = {}): Promise<string> {
  if (process.platform === `win32`)
    return process.env.PATH ?? ``

  if (!options.force && cachedLoginPath !== null)
    return cachedLoginPath

  if (!options.force && loginPathPromise)
    return loginPathPromise

  const currentPromise = (async () => {
    const shell = process.env.SHELL || `/bin/zsh`
    const shellPath = await new Promise<string | null>((resolve) => {
      const child = execFile(
        shell,
        [`-ilc`, `printf '${PATH_SENTINEL}%s${PATH_SENTINEL}' "$PATH"`],
        {
          timeout: 3_000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            TERM: `dumb`,
          },
        },
        (error, stdout) => {
          if (error || !stdout) {
            resolve(null)
            return
          }
          const start = stdout.indexOf(PATH_SENTINEL)
          const end = stdout.lastIndexOf(PATH_SENTINEL)
          if (start === -1 || end <= start) {
            resolve(null)
            return
          }
          resolve(stdout.slice(start + PATH_SENTINEL.length, end))
        },
      )
      // Send immediate EOF so interactive rc prompts (e.g. oh-my-zsh update checks) cannot hang until timeout.
      child.stdin?.end()
    })

    const combined = mergePathEntries(
      splitPathEntries(shellPath ?? undefined),
      splitPathEntries(process.env.PATH),
      defaultPosixFallbackPaths(),
    )
    cachedLoginPath = combined
    return combined
  })()
  loginPathPromise = currentPromise

  try {
    return await currentPromise
  }
  finally {
    if (loginPathPromise === currentPromise)
      loginPathPromise = null
  }
}

export async function buildAgentEnv(
  extraEnv?: Record<string, string>,
  pathOverride?: string,
): Promise<NodeJS.ProcessEnv> {
  const resolvedPath = pathOverride ?? await resolveLoginShellPath()
  const baseEnv: NodeJS.ProcessEnv = { ...process.env }
  // Plain objects are case-sensitive even on Windows where process.env uses `Path`; avoid duplicate PATH keys.
  for (const key of Object.keys(baseEnv)) {
    if (key !== `PATH` && key.toUpperCase() === `PATH`)
      delete baseEnv[key]
  }
  return {
    ...baseEnv,
    PATH: resolvedPath,
    ...extraEnv,
  }
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile())
      return false
    if (process.platform === `win32`)
      return true
    await fs.access(filePath, fsConstants.X_OK)
    return true
  }
  catch {
    return false
  }
}

export async function resolveBinaryOnPath(
  binary: string,
  pathEnv?: string,
): Promise<string | null> {
  if (!binary.trim())
    return null

  const isWin = process.platform === `win32`
  const exts = isWin
    ? (process.env.PATHEXT ?? `.COM;.EXE;.BAT;.CMD`).split(`;`).filter(Boolean)
    : [``]

  const hasSeparator = binary.includes(`/`) || binary.includes(`\\`)
  if (hasSeparator || path.isAbsolute(binary)) {
    const direct = path.resolve(binary)
    if (await isExecutableFile(direct))
      return direct
    if (isWin) {
      for (const ext of exts) {
        const candidate = `${direct}${ext}`
        if (await isExecutableFile(candidate))
          return candidate
      }
    }
    return null
  }

  const resolvedPath = pathEnv ?? await resolveLoginShellPath()
  const dirs = splitPathEntries(resolvedPath)

  for (const dir of dirs) {
    if (isWin) {
      const hasKnownExt = exts.some(ext => binary.toLowerCase().endsWith(ext.toLowerCase()))
      const candidates = hasKnownExt ? [binary] : [binary, ...exts.map(ext => `${binary}${ext}`)]
      for (const name of candidates) {
        const candidate = path.join(dir, name)
        if (await isExecutableFile(candidate))
          return candidate
      }
    }
    else {
      const candidate = path.join(dir, binary)
      if (await isExecutableFile(candidate))
        return candidate
    }
  }

  return null
}

export function quoteWindowsArg(arg: string): string {
  if (/[\r\n\0]/.test(arg))
    throw new Error(`Invalid control character in Windows command argument`)
  if (arg.length === 0)
    return `""`
  if (!/[\s"&|<>^()]/.test(arg))
    return arg
  // Double backslashes immediately preceding `"` and trailing backslashes so CRT argv parsing preserves them.
  const escaped = arg
    .replace(/(\\*)"/g, `$1$1\\"`)
    .replace(/(\\*)$/, `$1$1`)
  return `"${escaped}"`
}

export function buildWindowsCmdLine(command: string, args: string[]): string {
  // Wrap the full command in outer quotes for `cmd.exe /d /s /c` with `windowsVerbatimArguments: true`.
  const inner = [quoteWindowsArg(command), ...args.map(quoteWindowsArg)].join(` `)
  return `"${inner}"`
}

export function spawnAgentProcess(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
  },
): ChildProcessWithoutNullStreams {
  if (/\0/.test(command) || args.some(arg => arg.includes(`\0`)))
    throw new Error(`Invalid null byte in process command or arguments`)

  const isWin = process.platform === `win32`
  const needsWindowsShell = isWin && (/\.(?:cmd|bat)$/i.test(command) || !path.extname(command))

  if (needsWindowsShell) {
    const cmdLine = buildWindowsCmdLine(command, args)
    const child = spawn(process.env.ComSpec || `cmd.exe`, [`/d`, `/s`, `/c`, cmdLine], {
      cwd: options.cwd,
      env: options.env,
      stdio: [`pipe`, `pipe`, `pipe`],
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    return assertChildPipes(child)
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: [`pipe`, `pipe`, `pipe`],
    // Create a dedicated process group on POSIX so terminateProcessTree kills child descendants too.
    detached: !isWin,
    windowsHide: true,
  })
  return assertChildPipes(child)
}

function assertChildPipes(child: ChildProcess): ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr)
    throw new Error(`Failed to open stdio pipes for ACP child process`)
  return child as ChildProcessWithoutNullStreams
}

function isProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isProcessExited(child))
    return Promise.resolve(true)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off(`exit`, onDone)
      child.off(`close`, onDone)
      resolve(false)
    }, timeoutMs)

    function onDone() {
      clearTimeout(timer)
      child.off(`exit`, onDone)
      child.off(`close`, onDone)
      resolve(true)
    }

    child.once(`exit`, onDone)
    child.once(`close`, onDone)
  })
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: { gracefulTimeoutMs?: number, forceTimeoutMs?: number } = {},
): Promise<void> {
  if (isProcessExited(child))
    return

  const pid = child.pid
  if (!pid) {
    child.kill(`SIGKILL`)
    return
  }

  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 1_500
  const forceTimeoutMs = options.forceTimeoutMs ?? 1_500

  if (process.platform === `win32`) {
    await new Promise<void>((resolve) => {
      execFile(`taskkill`, [`/PID`, String(pid), `/T`, `/F`], { timeout: forceTimeoutMs }, () => {
        resolve()
      })
    })
    await waitForExit(child, forceTimeoutMs)
    return
  }

  try {
    process.kill(-pid, `SIGTERM`)
  }
  catch {
    try {
      child.kill(`SIGTERM`)
    }
    catch {
      return
    }
  }

  if (await waitForExit(child, gracefulTimeoutMs))
    return

  try {
    process.kill(-pid, `SIGKILL`)
  }
  catch {
    try {
      child.kill(`SIGKILL`)
    }
    catch {
      return
    }
  }

  await waitForExit(child, forceTimeoutMs)
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer)
  }
}

export function createChildFailureGuard(
  child: ChildProcess,
  stderrChunks: string[],
): { promise: Promise<never>, dispose: () => void } {
  let cleanup = () => {}
  const promise = new Promise<never>((_resolve, reject) => {
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const rejectWithExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled)
        return
      settled = true
      cleanup()
      const stderr = stderrChunks.join(``).trim()
      const suffix = stderr ? `: ${stderr.slice(-400)}` : ``
      reject(
        new Error(
          `ACP process exited unexpectedly (code=${code ?? `null`}${signal ? `, signal=${signal}` : ``})${suffix}`,
        ),
      )
    }

    const onError = (error: Error) => {
      if (settled)
        return
      settled = true
      cleanup()
      reject(new Error(`ACP process failed to start: ${error.message}`))
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      // Wait briefly for `close` so buffered stderr written right before exit is captured.
      if (!child.stderr || child.stderr.readableEnded) {
        rejectWithExit(code, signal)
        return
      }
      const onClose = () => rejectWithExit(code, signal)
      child.once(`close`, onClose)
      flushTimer = setTimeout(() => {
        child.off(`close`, onClose)
        rejectWithExit(code, signal)
      }, 30)
      flushTimer.unref?.()
    }

    cleanup = () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      child.off(`error`, onError)
      child.off(`exit`, onExit)
    }

    child.once(`error`, onError)
    child.once(`exit`, onExit)
  })

  // Prevent unhandled rejection if the outer request finishes before the child exits.
  promise.catch(() => undefined)

  return { promise, dispose: () => cleanup() }
}
