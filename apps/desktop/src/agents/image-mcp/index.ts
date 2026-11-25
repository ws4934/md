import process from 'node:process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { generateAndSaveWorkspaceImage } from '../shared/image-client'

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value)
    throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function main(): Promise<void> {
  const bridgeUrl = readRequiredEnv(`MD_IMAGE_BRIDGE_URL`)
  const bridgeToken = readRequiredEnv(`MD_IMAGE_BRIDGE_TOKEN`)
  const workspaceDir = readRequiredEnv(`MD_WORKSPACE_DIR`)

  const server = new McpServer({
    name: `md-image`,
    version: `1.0.0`,
  })

  server.registerTool(
    `generate_image`,
    {
      title: `Generate Image`,
      description: `Generate an illustration using the configured image generation API and save it under images/ inside the article workspace. Reference the returned relative path in article.md using ![alt](images/<name>.png).`,
      inputSchema: {
        prompt: z.string().min(1).describe(`Detailed visual description of the image to generate`),
        filename: z.string().optional().describe(`Optional short filename slug without directory, e.g. "architecture-diagram"`),
        size: z.string().optional().describe(`Optional image size such as "1024x1024", "1536x1024", or "1024x1536"`),
      },
    },
    async ({ prompt, filename, size }, extra) => {
      try {
        const result = await generateAndSaveWorkspaceImage({
          bridgeUrl,
          bridgeToken,
          workspaceDir,
          prompt,
          filename,
          size,
          abortSignal: extra.signal,
        })
        return {
          content: [
            {
              type: `text`,
              text: `Image saved to ${result.relativePath}. Insert it in article.md with ![description](${result.relativePath}).`,
            },
          ],
        }
      }
      catch (error) {
        return {
          isError: true,
          content: [
            {
              type: `text`,
              text: `Failed to generate image: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  process.stderr.write(`[md-image-mcp] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
