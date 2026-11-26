import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateAndSaveWorkspaceImage } from '../../agents/shared/image-client'
import { ImageGenBridge } from './image-bridge'
import { generateDesktopImage } from './image-service'

const { generateImageMock } = vi.hoisted(() => ({
  generateImageMock: vi.fn(),
}))

vi.mock(`ai`, () => ({
  generateImage: generateImageMock,
}))

// Valid 1x1 red PNG (68 bytes).
const TINY_PNG_BASE64 = `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, `base64`)
const SAMPLE_JPEG_BYTES = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01])
const SAMPLE_WEBP_BYTES = Buffer.from(`RIFF\x12\x00\x00\x00WEBPVP8 \x06\x00\x00\x00\x00\x00\x00\x00\x00\x00`, `latin1`)

const tempDirs: string[] = []
const openBridges: ImageGenBridge[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeFakeConfig() {
  return {
    providerPreset: `custom` as const,
    baseUrl: `https://api.example.com/v1`,
    hasApiKey: true,
    apiKey: `sk-test-img`,
    model: `mock-img-1`,
    size: `1024x1024`,
    quality: `auto`,
    isConfigured: true,
  }
}

afterEach(async () => {
  generateImageMock.mockReset()
  while (openBridges.length > 0)
    await openBridges.pop()!.close()
  while (tempDirs.length > 0)
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
})

describe(`imageGenBridge referenceImages`, () => {
  it(`forwards decoded reference bytes to generate and rejects >4 refs, bad mediaType, and oversized refs`, async () => {
    const receivedRefs: Array<Uint8Array[] | undefined> = []
    const bridge = new ImageGenBridge({
      getConfig: async () => makeFakeConfig(),
      generate: async ({ referenceImages }) => {
        receivedRefs.push(referenceImages)
        return {
          bytes: TINY_PNG_BYTES,
          base64: TINY_PNG_BASE64,
          mimeType: `image/png`,
        }
      },
    })
    openBridges.push(bridge)
    const conn = await bridge.ensureStarted()

    const post = (payload: Record<string, unknown>) =>
      fetch(conn.url, {
        method: `POST`,
        headers: {
          'Content-Type': `application/json`,
          'Authorization': `Bearer ${conn.token}`,
        },
        body: JSON.stringify(payload),
      })

    // Valid request with multiple reference images forwards exact decoded bytes.
    const okRes = await post({
      prompt: `Keep the character consistent`,
      referenceImages: [
        { base64: TINY_PNG_BYTES.toString(`base64`), mediaType: `image/png` },
        { base64: SAMPLE_JPEG_BYTES.toString(`base64`), mediaType: `image/jpeg` },
        { base64: SAMPLE_WEBP_BYTES.toString(`base64`), mediaType: `image/webp` },
      ],
    })
    expect(okRes.status).toBe(200)
    expect(receivedRefs).toHaveLength(1)
    expect(receivedRefs[0]).toHaveLength(3)
    expect(Buffer.from(receivedRefs[0]![0]).equals(TINY_PNG_BYTES)).toBe(true)
    expect(Buffer.from(receivedRefs[0]![1]).equals(SAMPLE_JPEG_BYTES)).toBe(true)
    expect(Buffer.from(receivedRefs[0]![2]).equals(SAMPLE_WEBP_BYTES)).toBe(true)

    // Omitting referenceImages passes undefined.
    const plainRes = await post({ prompt: `No refs` })
    expect(plainRes.status).toBe(200)
    expect(receivedRefs).toHaveLength(2)
    expect(receivedRefs[1]).toBeUndefined()

    // > 4 reference images rejected with 400.
    const tooManyRes = await post({
      prompt: `Too many`,
      referenceImages: Array.from({ length: 5 }, () => ({
        base64: TINY_PNG_BASE64,
        mediaType: `image/png`,
      })),
    })
    expect(tooManyRes.status).toBe(400)
    expect(await tooManyRes.text()).toMatch(/4/)

    // Disallowed mediaType rejected with 400.
    const badMimeRes = await post({
      prompt: `Bad mime`,
      referenceImages: [
        { base64: TINY_PNG_BASE64, mediaType: `image/gif` },
      ],
    })
    expect(badMimeRes.status).toBe(400)
    expect(await badMimeRes.text()).toMatch(/mediaType/i)

    // Oversized (> 8 MB) reference image rejected with 400.
    const oversizedBase64 = Buffer.alloc(8 * 1024 * 1024 + 1, 0x41).toString(`base64`)
    const oversizedRes = await post({
      prompt: `Too large`,
      referenceImages: [
        { base64: oversizedBase64, mediaType: `image/png` },
      ],
    })
    expect(oversizedRes.status).toBe(400)
    expect(await oversizedRes.text()).toMatch(/8 MB/i)

    // None of the invalid requests should have invoked generate.
    expect(receivedRefs).toHaveLength(2)
  })
})

describe(`generateAndSaveWorkspaceImage referenceImages`, () => {
  it(`reads workspace refs for the bridge and rejects traversal, absolute paths, and outside symlinks`, async () => {
    const workspaceDir = await makeTempDir(`md-ref-ws-`)
    const outsideDir = await makeTempDir(`md-ref-outside-`)

    await fs.mkdir(path.join(workspaceDir, `refs`), { recursive: true })
    await fs.writeFile(path.join(workspaceDir, `refs`, `character.png`), TINY_PNG_BYTES)
    await fs.writeFile(path.join(workspaceDir, `refs`, `cover.jpg`), SAMPLE_JPEG_BYTES)
    await fs.writeFile(path.join(workspaceDir, `refs`, `palette.webp`), SAMPLE_WEBP_BYTES)

    const outsidePng = path.join(outsideDir, `secret.png`)
    await fs.writeFile(outsidePng, TINY_PNG_BYTES)
    await fs.symlink(outsidePng, path.join(workspaceDir, `refs`, `escape.png`))

    const receivedRefs: Array<Uint8Array[] | undefined> = []
    const bridge = new ImageGenBridge({
      getConfig: async () => makeFakeConfig(),
      generate: async ({ referenceImages }) => {
        receivedRefs.push(referenceImages)
        return {
          bytes: TINY_PNG_BYTES,
          base64: TINY_PNG_BASE64,
          mimeType: `image/png`,
        }
      },
    })
    openBridges.push(bridge)
    const conn = await bridge.ensureStarted()

    // Valid workspace-relative refs are read and forwarded as decoded bytes.
    const saved = await generateAndSaveWorkspaceImage({
      bridgeUrl: conn.url,
      bridgeToken: conn.token,
      workspaceDir,
      prompt: `Scene featuring the same character`,
      filename: `scene-1`,
      referenceImages: [`refs/character.png`, `refs/cover.jpg`, `refs/palette.webp`],
    })
    expect(saved.relativePath).toBe(`images/scene-1.png`)
    expect(receivedRefs).toHaveLength(1)
    expect(receivedRefs[0]).toHaveLength(3)
    expect(Buffer.from(receivedRefs[0]![0]).equals(TINY_PNG_BYTES)).toBe(true)
    expect(Buffer.from(receivedRefs[0]![1]).equals(SAMPLE_JPEG_BYTES)).toBe(true)
    expect(Buffer.from(receivedRefs[0]![2]).equals(SAMPLE_WEBP_BYTES)).toBe(true)

    // Parent traversal rejected before calling the bridge.
    await expect(generateAndSaveWorkspaceImage({
      bridgeUrl: conn.url,
      bridgeToken: conn.token,
      workspaceDir,
      prompt: `Traversal`,
      referenceImages: [`../x.png`],
    })).rejects.toThrow(/\.\./)

    // Absolute path rejected before calling the bridge.
    await expect(generateAndSaveWorkspaceImage({
      bridgeUrl: conn.url,
      bridgeToken: conn.token,
      workspaceDir,
      prompt: `Absolute`,
      referenceImages: [outsidePng],
    })).rejects.toThrow(/workspace-relative/i)

    // Symlink pointing outside workspace rejected before calling the bridge.
    await expect(generateAndSaveWorkspaceImage({
      bridgeUrl: conn.url,
      bridgeToken: conn.token,
      workspaceDir,
      prompt: `Symlink escape`,
      referenceImages: [`refs/escape.png`],
    })).rejects.toThrow(/outside workspace/i)

    expect(receivedRefs).toHaveLength(1)
  })
})

describe(`generateDesktopImage referenceImages`, () => {
  it(`passes prompt: { text, images } only when referenceImages are provided`, async () => {
    generateImageMock.mockResolvedValue({
      image: {
        uint8Array: new Uint8Array(TINY_PNG_BYTES),
        base64: TINY_PNG_BASE64,
        mediaType: `image/png`,
      },
    })

    // Without referenceImages -> plain string prompt.
    await generateDesktopImage({
      baseUrl: `https://api.example.com/v1`,
      apiKey: `sk-test`,
      model: `gpt-image-1`,
      prompt: `  A quiet tea shop  `,
    })
    expect(generateImageMock).toHaveBeenCalledTimes(1)
    expect(generateImageMock.mock.calls[0][0].prompt).toBe(`A quiet tea shop`)

    // Empty referenceImages array -> still plain string prompt.
    await generateDesktopImage({
      baseUrl: `https://api.example.com/v1`,
      apiKey: `sk-test`,
      model: `gpt-image-1`,
      prompt: `A quiet tea shop`,
      referenceImages: [],
    })
    expect(generateImageMock).toHaveBeenCalledTimes(2)
    expect(generateImageMock.mock.calls[1][0].prompt).toBe(`A quiet tea shop`)

    // Non-empty referenceImages -> object prompt { text, images }.
    const ref1 = new Uint8Array(TINY_PNG_BYTES)
    const ref2 = new Uint8Array(SAMPLE_JPEG_BYTES)
    await generateDesktopImage({
      baseUrl: `https://api.example.com/v1`,
      apiKey: `sk-test`,
      model: `gpt-image-1`,
      prompt: `  Same character at the tea shop  `,
      referenceImages: [ref1, ref2],
    })
    expect(generateImageMock).toHaveBeenCalledTimes(3)
    expect(generateImageMock.mock.calls[2][0].prompt).toEqual({
      text: `Same character at the tea shop`,
      images: [ref1, ref2],
    })
  })
})
