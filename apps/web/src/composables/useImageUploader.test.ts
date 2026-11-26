import { beforeEach, describe, expect, it, vi } from 'vitest'

const storageState = vi.hoisted(() => ({
  map: {} as Record<string, string>,
  readDelayMs: 0,
}))

const uploadCalls = vi.hoisted(() => [] as Array<{ name: string, resolve: (url: string) => void }>)

vi.mock(`@/i18n/translate`, () => ({
  t: (key: string) => key,
}))

vi.mock(`@md/shared/utils/fileHelpers`, () => ({
  toBase64: vi.fn(async () => `base64data`),
}))

vi.mock(`@/services/upload`, () => ({
  fileUpload: vi.fn((_base64: string, file: File) => new Promise<string>((resolve) => {
    uploadCalls.push({ name: file.name, resolve })
  })),
}))

vi.mock(`@/storage`, () => ({
  store: {
    get: vi.fn(async () => `s3`),
    getJSON: vi.fn(async () => {
      if (storageState.readDelayMs > 0)
        await new Promise(r => setTimeout(r, storageState.readDelayMs))
      return { ...storageState.map }
    }),
    setJSON: vi.fn(async (_key: string, val: Record<string, string>) => {
      storageState.map = { ...val }
    }),
  },
}))

describe(`useImageUploader`, () => {
  beforeEach(() => {
    storageState.map = {}
    storageState.readDelayMs = 0
    uploadCalls.length = 0
  })

  it(`scopes the file hash to the current image host`, async () => {
    const { imageUploadCacheKey } = await import(`./useImageUploader`)
    expect(imageUploadCacheKey(`s3`, `abc`)).toBe(`s3:abc`)
    expect(imageUploadCacheKey(`default`, `abc`)).not.toBe(imageUploadCacheKey(`github`, `abc`))
  })

  it(`preserves all uploaded_image_map entries and isUploading state across concurrent uploads`, async () => {
    storageState.readDelayMs = 10
    const { useImageUploader } = await import(`./useImageUploader`)
    const uploader = useImageUploader()

    const fileA = new File([new Uint8Array([1, 2, 3])], `a.png`, { type: `image/png` })
    const fileB = new File([new Uint8Array([4, 5, 6])], `b.png`, { type: `image/png` })

    const pA = uploader.upload(fileA)
    const pB = uploader.upload(fileB)
    expect(uploader.isUploading.value).toBe(true)

    await vi.waitFor(() => expect(uploadCalls).toHaveLength(2))
    uploadCalls[0].resolve(`https://cdn.example/${uploadCalls[0].name}`)
    await new Promise(r => setTimeout(r, 25))
    // Still uploading while the second file is in flight.
    expect(uploader.isUploading.value).toBe(true)

    uploadCalls[1].resolve(`https://cdn.example/${uploadCalls[1].name}`)
    const [urlA, urlB] = await Promise.all([pA, pB])

    expect(uploader.isUploading.value).toBe(false)
    expect(urlA).toBe(`https://cdn.example/a.png`)
    expect(urlB).toBe(`https://cdn.example/b.png`)
    expect(Object.values(storageState.map).sort()).toEqual([
      `https://cdn.example/a.png`,
      `https://cdn.example/b.png`,
    ])
  })
})
