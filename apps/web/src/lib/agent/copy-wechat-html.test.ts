// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  processClipboardContent: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock(`vue-sonner`, () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

vi.mock(`@/i18n/translate`, () => ({
  t: (key: string) => key,
}))

vi.mock(`@/services/export`, () => ({
  processClipboardContent: mocks.processClipboardContent,
}))

describe(`copyWeChatHtmlToClipboard`, () => {
  const originalClipboard = navigator.clipboard
  const originalClipboardItem = globalThis.ClipboardItem
  const clipboardWrite = vi.fn()

  beforeEach(() => {
    mocks.processClipboardContent.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    clipboardWrite.mockReset()

    Object.defineProperty(navigator, `clipboard`, {
      configurable: true,
      value: { write: clipboardWrite },
    })

    globalThis.ClipboardItem = class MockClipboardItem {
      readonly items: Record<string, Blob>
      constructor(items: Record<string, Blob>) {
        this.items = items
      }
    } as unknown as typeof ClipboardItem
  })

  afterEach(() => {
    Object.defineProperty(navigator, `clipboard`, {
      configurable: true,
      value: originalClipboard,
    })
    globalThis.ClipboardItem = originalClipboardItem
  })

  it(`does not write an empty clipboard or toast success when rendered HTML is empty`, async () => {
    const { copyWeChatHtmlToClipboard } = await import(`./copy-wechat-html`)
    mocks.processClipboardContent.mockResolvedValue({
      html: `   `,
      plainText: ``,
      hasPendingAsyncContent: false,
    })

    const onStart = vi.fn()
    const onEnd = vi.fn()
    const onRefresh = vi.fn()

    const ok = await copyWeChatHtmlToClipboard({
      primaryColor: `#07c160`,
      onStart,
      onEnd,
      onRefresh,
    })

    expect(ok).toBe(false)
    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(`agent.publish.errors.emptyContent`)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it(`writes HTML and plain text to clipboard and toasts success for non-empty content`, async () => {
    const { copyWeChatHtmlToClipboard } = await import(`./copy-wechat-html`)
    mocks.processClipboardContent.mockResolvedValue({
      html: `<section><p>Hello WeChat</p></section>`,
      plainText: `Hello WeChat`,
      hasPendingAsyncContent: false,
    })

    const onStart = vi.fn()
    const onEnd = vi.fn()
    const onRefresh = vi.fn()

    const ok = await copyWeChatHtmlToClipboard({
      primaryColor: `#07c160`,
      onStart,
      onEnd,
      onRefresh,
    })

    expect(ok).toBe(true)
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    expect(mocks.toastSuccess).toHaveBeenCalledWith(`agent.toolbar.copiedToWeChat`)
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})
