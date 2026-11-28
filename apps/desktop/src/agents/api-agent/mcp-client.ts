import type { McpServer, McpServerStdio } from '@agentclientprotocol/sdk/unstable'
import type { Buffer } from 'node:buffer'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { redactSecret } from '../../main/ai/sanitize'
import { readNdjsonLines } from '../shared/ndjson'

const MCP_PROTOCOL_VERSION = `2024-11-05`
const STARTUP_TIMEOUT_MS = 10_000
// Web search may fail over across up to 5 providers at ~45 s each; image generation is also slow.
const TOOL_CALL_TIMEOUT_MS = 240_000
const CLOSE_GRACE_MS = 500
const MAX_TOOL_LIST_PAGES = 10
const MAX_STDERR_TAIL_CHARS = 2_048
const SECRET_ENV_NAME_RE = /key|token|secret|password|auth/i

export interface McpToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpToolCallOutput {
  text: string
  isError: boolean
}

interface JsonRpcIncomingMessage {
  id?: unknown
  method?: unknown
  result?: unknown
  error?: { code?: number, message?: string }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function isStdioServer(server: McpServer): server is McpServerStdio {
  return !(`type` in server) && typeof server.command === `string`
}

function extractTextFromMcpContent(content: unknown): string {
  if (!Array.isArray(content))
    return ``
  const texts: string[] = []
  for (const item of content) {
    if (item && typeof item === `object` && (item as { type?: unknown }).type === `text`) {
      const text = (item as { text?: unknown }).text
      if (typeof text === `string` && text)
        texts.push(text)
    }
  }
  if (texts.length > 0)
    return texts.join(`\n`)
  return content.length > 0 ? JSON.stringify(content) : ``
}

function createAbortError(): Error {
  const err = new Error(`Cancelled`)
  err.name = `AbortError`
  return err
}

function parseResponseId(rawId: unknown): number | null {
  if (typeof rawId === `number` && Number.isSafeInteger(rawId))
    return rawId
  if (typeof rawId === `string` && /^\d+$/.test(rawId)) {
    const parsed = Number(rawId)
    if (Number.isSafeInteger(parsed))
      return parsed
  }
  return null
}

function isValidRpcId(rawId: unknown): rawId is string | number {
  return typeof rawId === `string` || (typeof rawId === `number` && Number.isFinite(rawId))
}

export class McpStdioClient {
  readonly serverName: string
  readonly tools: McpToolDefinition[] = []

  private readonly child: ChildProcessWithoutNullStreams
  private readonly lineReader: { close: () => void }
  private readonly pending = new Map<number, PendingRequest>()
  private readonly secretValues: string[]
  private stderrTail = ``
  private nextId = 1
  private closed = false
  private terminalError: Error | null = null
  private closePromise: Promise<void> | null = null

  private constructor(
    serverName: string,
    child: ChildProcessWithoutNullStreams,
    secretValues: string[],
  ) {
    this.serverName = serverName
    this.child = child
    this.secretValues = secretValues

    // Swallow broken-pipe errors on child stdio streams so an exiting MCP child cannot crash api-agent.
    child.stdin.on(`error`, () => {})
    child.stdout.on(`error`, () => {})
    child.stderr.on(`error`, () => {})

    child.stderr.on(`data`, (chunk: Buffer | string) => {
      const next = `${this.stderrTail}${chunk.toString()}`
      this.stderrTail = next.length > MAX_STDERR_TAIL_CHARS
        ? next.slice(-MAX_STDERR_TAIL_CHARS)
        : next
    })

    this.lineReader = readNdjsonLines(child.stdout, {
      onLine: (line) => {
        const trimmed = line.trim()
        if (!trimmed)
          return
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        }
        catch {
          return
        }
        if (!parsed || typeof parsed !== `object` || Array.isArray(parsed))
          return
        const msg = parsed as JsonRpcIncomingMessage

        // Handle server-initiated requests/notifications separately so their IDs never collide with pending client calls.
        if (`method` in msg && typeof msg.method === `string`) {
          if (isValidRpcId(msg.id)) {
            if (msg.method === `ping`)
              this.tryWriteMessage({ id: msg.id, result: {} })
            else
              this.tryWriteMessage({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
          }
          return
        }

        if (!(`result` in msg) && !(`error` in msg))
          return

        const numericId = parseResponseId(msg.id)
        if (numericId === null)
          return
        const pending = this.pending.get(numericId)
        if (!pending)
          return
        this.pending.delete(numericId)
        clearTimeout(pending.timer)
        if (msg.error) {
          const rawErr = msg.error.message || `MCP error (${msg.error.code ?? `unknown`})`
          pending.reject(new Error(this.redact(rawErr)))
        }
        else {
          pending.resolve(msg.result)
        }
      },
    })

    child.once(`error`, (error) => {
      const err = new Error(this.redact(`MCP server "${serverName}" failed: ${error.message}`))
      this.terminalError ??= err
      this.failAllPending(err)
    })

    child.once(`exit`, (code, signal) => {
      this.lineReader.close()
      const tail = this.stderrTail.trim().slice(-400)
      const detail = tail ? `: ${this.redact(tail)}` : ``
      const err = new Error(`MCP server "${serverName}" exited (code=${code ?? `null`}, signal=${signal ?? `null`})${detail}`)
      this.terminalError ??= err
      this.failAllPending(err)
    })
  }

  static async connect(server: McpServerStdio, cwd: string): Promise<McpStdioClient> {
    const env: NodeJS.ProcessEnv = { ...process.env }
    // Keep the API agent's LLM credentials out of child MCP server environments.
    delete env.MD_API_AGENT_CONFIG
    const secretValues: string[] = []
    for (const entry of server.env ?? []) {
      env[entry.name] = entry.value
      if (SECRET_ENV_NAME_RE.test(entry.name) && entry.value.trim().length >= 3)
        secretValues.push(entry.value.trim())
    }

    const child = spawn(server.command, server.args ?? [], {
      cwd,
      env,
      stdio: [`pipe`, `pipe`, `pipe`],
      windowsHide: true,
    })

    const client = new McpStdioClient(server.name, child, secretValues)
    try {
      await client.request(`initialize`, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: `md-api-agent`,
          version: `1.0.0`,
        },
      }, STARTUP_TIMEOUT_MS)

      client.notify(`notifications/initialized`, {})
      await client.fetchTools()
      return client
    }
    catch (error) {
      await client.close()
      throw error
    }
  }

  private redact(message: string): string {
    return redactSecret(message, ...this.secretValues)
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private writeMessage(payload: Record<string, unknown>): void {
    if (this.closed)
      throw new Error(`MCP server "${this.serverName}" is closed`)
    if (this.terminalError)
      throw this.terminalError
    if (this.child.stdin.destroyed || !this.child.stdin.writable)
      throw new Error(`MCP server "${this.serverName}" stdin is closed`)
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: `2.0`, ...payload })}\n`)
  }

  private tryWriteMessage(payload: Record<string, unknown>): void {
    try {
      this.writeMessage(payload)
    }
    catch {
      // Best-effort message write.
    }
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.tryWriteMessage(params !== undefined ? { method, params } : { method })
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error(`MCP server "${this.serverName}" is closed`))
    if (this.terminalError)
      return Promise.reject(this.terminalError)
    if (abortSignal?.aborted)
      return Promise.reject(createAbortError())

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id)
        if (!entry)
          return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        this.notify(`notifications/cancelled`, { requestId: id, reason: `Cancelled` })
        reject(createAbortError())
      }
      const cleanup = () => {
        abortSignal?.removeEventListener(`abort`, onAbort)
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id))
          return
        cleanup()
        this.notify(`notifications/cancelled`, { requestId: id, reason: `Timed out` })
        reject(new Error(`MCP request "${method}" to "${this.serverName}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (err) => {
          cleanup()
          reject(err)
        },
        timer,
      })

      abortSignal?.addEventListener(`abort`, onAbort, { once: true })

      try {
        this.writeMessage({ id, method, params })
      }
      catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private async fetchTools(): Promise<void> {
    const seenCursors = new Set<string>()
    const seenNames = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const raw = await this.request(
        `tools/list`,
        cursor ? { cursor } : {},
        STARTUP_TIMEOUT_MS,
      )
      if (!raw || typeof raw !== `object`)
        break
      const response = raw as { tools?: unknown, nextCursor?: unknown }
      if (Array.isArray(response.tools)) {
        for (const item of response.tools) {
          if (!item || typeof item !== `object`)
            continue
          const rec = item as Record<string, unknown>
          if (typeof rec.name !== `string` || !rec.name.trim())
            continue
          const name = rec.name.trim()
          if (seenNames.has(name))
            continue
          seenNames.add(name)
          this.tools.push({
            name,
            ...(typeof rec.title === `string` && rec.title.trim() ? { title: rec.title.trim() } : {}),
            ...(typeof rec.description === `string` ? { description: rec.description } : {}),
            ...(rec.inputSchema && typeof rec.inputSchema === `object` && !Array.isArray(rec.inputSchema)
              ? { inputSchema: rec.inputSchema as Record<string, unknown> }
              : {}),
          })
        }
      }
      if (typeof response.nextCursor === `string` && response.nextCursor && !seenCursors.has(response.nextCursor)) {
        seenCursors.add(response.nextCursor)
        cursor = response.nextCursor
      }
      else {
        break
      }
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<McpToolCallOutput> {
    const raw = await this.request(
      `tools/call`,
      { name, arguments: args },
      TOOL_CALL_TIMEOUT_MS,
      abortSignal,
    )
    if (!raw || typeof raw !== `object`)
      return { text: ``, isError: false }
    const response = raw as { content?: unknown, isError?: unknown }
    return {
      text: this.redact(extractTextFromMcpContent(response.content)),
      isError: Boolean(response.isError),
    }
  }

  close(): Promise<void> {
    if (this.closePromise)
      return this.closePromise
    this.closed = true
    this.failAllPending(new Error(`MCP server "${this.serverName}" closed`))
    this.lineReader.close()
    try {
      this.child.stdin.end()
    }
    catch {
      // Ignore already-closed stdin.
    }

    this.closePromise = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve()
        return
      }
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | null = null
      const done = () => {
        if (settled)
          return
        settled = true
        this.child.off(`exit`, done)
        if (killTimer)
          clearTimeout(killTimer)
        resolve()
      }
      this.child.once(`exit`, done)
      try {
        this.child.kill(`SIGTERM`)
      }
      catch {
        done()
        return
      }
      killTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          try {
            this.child.kill(`SIGKILL`)
          }
          catch {
            // Ignore kill errors for already-exited child.
          }
        }
        this.child.stdin.destroy()
        this.child.stdout.destroy()
        this.child.stderr.destroy()
        done()
      }, CLOSE_GRACE_MS)
    })
    return this.closePromise
  }

  /** Synchronous last-resort termination for Node's `process.on('exit')`. */
  forceKill(): void {
    this.closed = true
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill(`SIGKILL`)
      }
      catch {
        // Ignore already-exited child.
      }
    }
  }
}

export async function connectMcpServers(
  servers: readonly McpServer[],
  cwd: string,
): Promise<McpStdioClient[]> {
  const stdioServers: McpServerStdio[] = []
  for (const server of servers) {
    if (isStdioServer(server)) {
      stdioServers.push(server)
    }
    else {
      process.stderr.write(`[md-api-agent] skipping unsupported non-stdio MCP server "${server.name}"\n`)
    }
  }
  if (stdioServers.length === 0)
    return []

  const settled = await Promise.allSettled(
    stdioServers.map(server => McpStdioClient.connect(server, cwd)),
  )

  const clients: McpStdioClient[] = []
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    if (result.status === `fulfilled`) {
      clients.push(result.value)
    }
    else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      process.stderr.write(`[md-api-agent] failed to start MCP server "${stdioServers[i].name}": ${reason}\n`)
    }
  }
  return clients
}
