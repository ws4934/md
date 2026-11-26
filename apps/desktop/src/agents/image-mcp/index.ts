import process from 'node:process'
import { redactSecret } from '../../main/ai/sanitize'
import { generateAndSaveWorkspaceImage } from '../shared/image-client'
import { readNdjsonLines } from '../shared/ndjson'

const DEFAULT_MCP_PROTOCOL_VERSION = `2024-11-05`

const GENERATE_IMAGE_TOOL = {
  name: `generate_image`,
  title: `Generate Image`,
  description: `Generate an illustration using the configured image generation API and save it under images/ inside the article workspace. Reference the returned relative path in article.md using ![alt](images/<name>.png).`,
  inputSchema: {
    type: `object`,
    properties: {
      prompt: {
        type: `string`,
        minLength: 1,
        description: `Detailed visual description of the image to generate`,
      },
      filename: {
        type: `string`,
        description: `Optional short filename slug without directory, e.g. "architecture-diagram"`,
      },
      size: {
        type: `string`,
        description: `Optional image size such as "1024x1024", "1536x1024", or "1024x1536"`,
      },
      reference_images: {
        type: `array`,
        items: {
          type: `string`,
          minLength: 1,
        },
        maxItems: 4,
        description: `Optional workspace-relative paths of existing png/jpg/jpeg/webp images (max 4): reference images that the generated image should stay consistent with, e.g. the recurring character's reference image or the approved cover`,
      },
    },
    required: [`prompt`],
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
  const bridgeUrl = readRequiredEnv(`MD_IMAGE_BRIDGE_URL`)
  const bridgeToken = readRequiredEnv(`MD_IMAGE_BRIDGE_TOKEN`)
  const workspaceDir = readRequiredEnv(`MD_WORKSPACE_DIR`)

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
          name: `md-image`,
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
      writeResult(id, { tools: [GENERATE_IMAGE_TOOL] })
      return
    }

    if (method === `tools/call`) {
      const toolName = typeof msg.params?.name === `string` ? msg.params.name : ``
      if (toolName !== `generate_image`) {
        writeError(id, -32602, `Unknown tool: ${toolName}`)
        return
      }

      const rawArgs = typeof msg.params?.arguments === `object` && msg.params.arguments !== null && !Array.isArray(msg.params.arguments)
        ? (msg.params.arguments as Record<string, unknown>)
        : {}
      const prompt = typeof rawArgs.prompt === `string` ? rawArgs.prompt.trim() : ``
      if (!prompt) {
        writeResult(id, {
          isError: true,
          content: [{ type: `text`, text: `Failed to generate image: prompt is required` }],
        })
        return
      }
      const filename = typeof rawArgs.filename === `string` ? rawArgs.filename : undefined
      const size = typeof rawArgs.size === `string` ? rawArgs.size : undefined
      let referenceImages: string[] | undefined
      if (rawArgs.reference_images !== undefined) {
        if (!Array.isArray(rawArgs.reference_images) || !rawArgs.reference_images.every(item => typeof item === `string`)) {
          writeResult(id, {
            isError: true,
            content: [{ type: `text`, text: `Failed to generate image: reference_images must be an array of workspace-relative image paths` }],
          })
          return
        }
        referenceImages = rawArgs.reference_images
      }

      const controller = new AbortController()
      const key = rpcIdKey(id)
      inFlight.set(key, controller)
      try {
        const result = await generateAndSaveWorkspaceImage({
          bridgeUrl,
          bridgeToken,
          workspaceDir,
          prompt,
          filename,
          size,
          referenceImages,
          abortSignal: controller.signal,
        })
        writeResult(id, {
          content: [
            {
              type: `text`,
              text: `Image saved to ${result.relativePath}. Insert it in article.md with ![description](${result.relativePath}).`,
            },
          ],
        })
      }
      catch (error) {
        const rawErr = error instanceof Error ? error.message : String(error)
        writeResult(id, {
          isError: true,
          content: [
            {
              type: `text`,
              text: `Failed to generate image: ${redactSecret(rawErr, bridgeToken)}`,
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
  process.stderr.write(`[md-image-mcp] fatal: ${redactSecret(raw, process.env.MD_IMAGE_BRIDGE_TOKEN)}\n`)
  process.exit(1)
})
