import type { McpServer, McpServerStdio } from '@agentclientprotocol/sdk/unstable'
import type { Buffer } from 'node:buffer'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import process from 'node:process'
import readline from 'node:readline'

const MCP_PROTOCOL_VERSION = `2024-11-05`
const STARTUP_TIMEOUT_MS = 10_000
const TOOL_CALL_TIMEOUT_MS = 120_000
const CLOSE_GRACE_MS = 500
const MAX_TOOL_LIST_PAGES = 10

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

interface JsonRpcResponse {
  id?: string | number | null
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

export class McpStdioClient {
  readonly serverName: string
  readonly tools: McpToolDefinition[] = []

  private readonly child: ChildProcessWithoutNullStreams
  private readonly rl: readline.Interface
  private readonly pending = new Map<number, PendingRequest>()
  private readonly stderrChunks: string[] = []
  private nextId = 1
  private closed = false
  private closePromise: Promise<void> | null = null

  private constructor(serverName: string, child: ChildProcessWithoutNullStreams) {
    this.serverName = serverName
    this.child = child
    this.rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })

    child.stderr.on(`data`, (chunk: Buffer | string) => {
      this.stderrChunks.push(chunk.toString())
      if (this.stderrChunks.length > 50)
        this.stderrChunks.shift()
    })

    this.rl.on(`line`, (line) => {
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
      const msg = parsed as JsonRpcResponse
      if (msg.id === undefined || msg.id === null)
        return
      const numericId = typeof msg.id === `number` ? msg.id : Number(msg.id)
      const pending = this.pending.get(numericId)
      if (!pending)
        return
      this.pending.delete(numericId)
      clearTimeout(pending.timer)
      if (msg.error)
        pending.reject(new Error(msg.error.message || `MCP error (${msg.error.code ?? `unknown`})`))
      else
        pending.resolve(msg.result)
    })

    child.once(`error`, (error) => {
      this.failAllPending(new Error(`MCP server "${serverName}" failed: ${error.message}`))
    })

    child.once(`exit`, (code, signal) => {
      const stderrTail = this.stderrChunks.join(``).trim().slice(-400)
      const detail = stderrTail ? `: ${stderrTail}` : ``
      this.failAllPending(new Error(`MCP server "${serverName}" exited (code=${code ?? `null`}, signal=${signal ?? `null`})${detail}`))
    })
  }

  static async connect(server: McpServerStdio, cwd: string): Promise<McpStdioClient> {
    const env: NodeJS.ProcessEnv = { ...process.env }
    // Keep the API agent's LLM credentials out of child MCP server environments.
    delete env.MD_API_AGENT_CONFIG
    for (const entry of server.env ?? [])
      env[entry.name] = entry.value

    const child = spawn(server.command, server.args ?? [], {
      cwd,
      env,
      stdio: [`pipe`, `pipe`, `pipe`],
    })

    const client = new McpStdioClient(server.name, child)
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

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private writeMessage(payload: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable)
      throw new Error(`MCP server "${this.serverName}" stdin is closed`)
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: `2.0`, ...payload })}\n`)
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    try {
      this.writeMessage(params !== undefined ? { method, params } : { method })
    }
    catch {
      // Best-effort notification.
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error(`MCP server "${this.serverName}" is closed`))
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
          this.tools.push({
            name: rec.name.trim(),
            ...(typeof rec.title === `string` && rec.title.trim() ? { title: rec.title.trim() } : {}),
            ...(typeof rec.description === `string` ? { description: rec.description } : {}),
            ...(rec.inputSchema && typeof rec.inputSchema === `object` && !Array.isArray(rec.inputSchema)
              ? { inputSchema: rec.inputSchema as Record<string, unknown> }
              : {}),
          })
        }
      }
      if (typeof response.nextCursor === `string` && response.nextCursor)
        cursor = response.nextCursor
      else
        break
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
      text: extractTextFromMcpContent(response.content),
      isError: Boolean(response.isError),
    }
  }

  close(): Promise<void> {
    if (this.closePromise)
      return this.closePromise
    this.closed = true
    this.failAllPending(new Error(`MCP server "${this.serverName}" closed`))
    this.rl.close()
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
        this.child.kill()
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
