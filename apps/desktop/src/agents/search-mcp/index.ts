import process from 'node:process'
import { redactSecret } from '../../main/ai/sanitize'
import { readNdjsonLines } from '../shared/ndjson'
import { formatWebSearchResult, MAX_SEARCH_QUERY_CHARS, searchViaBridge } from '../shared/search-client'

const DEFAULT_MCP_PROTOCOL_VERSION = `2024-11-05`

const WEB_SEARCH_TOOL = {
  name: `web_search`,
  title: `Web Search`,
  description: `Search the web through the search provider configured in the md app. Returns a short answer followed by a numbered list of sources (title and URL). Use one focused query per call; call again for follow-up questions.`,
  inputSchema: {
    type: `object`,
    properties: {
      query: {
        type: `string`,
        minLength: 1,
        maxLength: MAX_SEARCH_QUERY_CHARS,
        description: `What to search for, written as a specific question or keyword query`,
      },
    },
    required: [`query`],
    additionalProperties: false,
  },
}

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: Record<string, unknown>
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value)
    throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function rpcIdKey(id: string | number): string {
  return typeof id === `number` ? `n:${id}` : `s:${id}`
}

function isValidRpcId(id: unknown): id is string | number | null | undefined {
  return id === undefined || id === null || typeof id === `string` || (typeof id === `number` && Number.isFinite(id))
}

async function main(): Promise<void> {
  const bridgeUrl = readRequiredEnv(`MD_SEARCH_BRIDGE_URL`)
  const bridgeToken = readRequiredEnv(`MD_SEARCH_BRIDGE_TOKEN`)

  process.stdout.on(`error`, () => {})
  process.stdin.on(`error`, () => {})

  let closed = false
  const writeJsonRpc = (payload: Record<string, unknown>): void => {
    if (closed || process.stdout.destroyed || !process.stdout.writable)
      return
    process.stdout.write(`${JSON.stringify({ jsonrpc: `2.0`, ...payload })}\n`)
  }
  const writeResult = (id: string | number | null, result: unknown): void => {
    writeJsonRpc({ id, result })
  }
  const writeError = (id: string | number | null, code: number, message: string): void => {
    writeJsonRpc({ id, error: { code, message } })
  }

  const inFlight = new Map<string, AbortController>()

  const handleMessage = async (msg: JsonRpcMessage): Promise<void> => {
    if (!isValidRpcId(msg.id)) {
      writeError(null, -32600, `Invalid Request`)
      return
    }

    const method = typeof msg.method === `string` ? msg.method : ``

    if (msg.id === undefined || msg.id === null) {
      if (method === `notifications/cancelled`) {
        const requestId = msg.params?.requestId
        if (typeof requestId === `string` || (typeof requestId === `number` && Number.isFinite(requestId)))
          inFlight.get(rpcIdKey(requestId))?.abort()
      }
      return
    }

    const id = msg.id
    if (method === `initialize`) {
      const requestedVersion = typeof msg.params?.protocolVersion === `string` && msg.params.protocolVersion.trim()
        ? msg.params.protocolVersion.trim()
        : DEFAULT_MCP_PROTOCOL_VERSION
      writeResult(id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: `md-search`,
          version: `1.0.0`,
        },
      })
      return
    }

    if (method === `ping`) {
      writeResult(id, {})
      return
    }

    if (method === `tools/list`) {
      writeResult(id, { tools: [WEB_SEARCH_TOOL] })
      return
    }

    if (method === `tools/call`) {
      const toolName = typeof msg.params?.name === `string` ? msg.params.name : ``
      if (toolName !== `web_search`) {
        writeError(id, -32602, `Unknown tool: ${toolName}`)
        return
      }

      const rawArgs = typeof msg.params?.arguments === `object` && msg.params.arguments !== null && !Array.isArray(msg.params.arguments)
        ? (msg.params.arguments as Record<string, unknown>)
        : {}
      const query = typeof rawArgs.query === `string` ? rawArgs.query.trim() : ``
      if (!query || query.length > MAX_SEARCH_QUERY_CHARS) {
        writeResult(id, {
          isError: true,
          content: [{ type: `text`, text: `Web search failed: query must be 1-${MAX_SEARCH_QUERY_CHARS} characters` }],
        })
        return
      }

      const controller = new AbortController()
      const key = rpcIdKey(id)
      inFlight.set(key, controller)
      try {
        const result = await searchViaBridge({
          bridgeUrl,
          bridgeToken,
          query,
          abortSignal: controller.signal,
        })
        writeResult(id, {
          content: [{ type: `text`, text: formatWebSearchResult(result) }],
        })
      }
      catch (error) {
        const rawErr = error instanceof Error ? error.message : String(error)
        writeResult(id, {
          isError: true,
          content: [
            {
              type: `text`,
              text: `Web search failed: ${redactSecret(rawErr, bridgeToken)}`,
            },
          ],
        })
      }
      finally {
        if (inFlight.get(key) === controller)
          inFlight.delete(key)
      }
      return
    }

    writeError(id, -32601, `Method not found: ${method}`)
  }

  await new Promise<void>((resolve) => {
    readNdjsonLines(process.stdin, {
      onLine: (line) => {
        const trimmed = line.trim()
        if (!trimmed)
          return
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        }
        catch {
          writeError(null, -32700, `Parse error`)
          return
        }
        if (typeof parsed !== `object` || parsed === null || Array.isArray(parsed)) {
          writeError(null, -32600, `Invalid Request`)
          return
        }
        void handleMessage(parsed as JsonRpcMessage)
      },
      onOversizedLine: () => {
        writeError(null, -32600, `Invalid Request: message too large`)
      },
      onClose: () => {
        closed = true
        for (const ctrl of inFlight.values())
          ctrl.abort()
        inFlight.clear()
        resolve()
      },
    })
  })
}

main().catch((error) => {
  const raw = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`[md-search-mcp] fatal: ${redactSecret(raw, process.env.MD_SEARCH_BRIDGE_TOKEN)}\n`)
  process.exit(1)
})
