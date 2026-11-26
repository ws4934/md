// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const renderCalls = vi.hoisted(() => [] as Array<{ content: string, options?: unknown }>)
const markDirtyMock = vi.hoisted(() => vi.fn())
const uiState = vi.hoisted(() => ({ isDark: true, viewMode: `edit` as `edit` | `split` | `preview` }))

vi.mock(`@/lib/preview/preview-ready`, () => ({
  waitForPreviewReady: vi.fn(async () => true),
  stripUnresolvedAsyncPlaceholders: vi.fn(),
}))

vi.mock(`@/services/export`, () => ({
  getHtmlContent: vi.fn(() => `<section class="container"><p>Snapshot</p></section>`),
  getShareExportStyles: vi.fn(async () => `<style></style>`),
}))

vi.mock(`@/stores/editor`, () => ({
  useEditorStore: () => ({
    getContent: () => `# Snapshot`,
  }),
}))

vi.mock(`@/stores/theme`, () => ({
  useThemeStore: () => ({
    updateCodeTheme: vi.fn(),
  }),
}))

vi.mock(`@/stores/ui`, () => ({
  useUIStore: () => ({
    get isDark() {
      return uiState.isDark
    },
    get viewMode() {
      return uiState.viewMode
    },
  }),
}))

vi.mock(`@/stores/render`, () => ({
  useRenderStore: () => ({
    isDirty: false,
    output: `<p>Old</p>`,
    markDirty: markDirtyMock,
    render: (content: string, options?: unknown) => {
      renderCalls.push({ content, options })
    },
  }),
}))

describe(`captureShareSnapshot`, () => {
  it(`forces light render and defers dark restoration in edit-only mode`, async () => {
    renderCalls.length = 0
    markDirtyMock.mockClear()
    uiState.isDark = true
    uiState.viewMode = `edit`

    const { captureShareSnapshot } = await import(`./capture-snapshot`)
    const res = await captureShareSnapshot()

    expect(res.bodyHtml).toContain(`Snapshot`)
    expect(renderCalls).toEqual([
      { content: `# Snapshot`, options: { themeMode: `light`, force: true } },
    ])
    expect(markDirtyMock).toHaveBeenCalledTimes(1)

    // In split mode, dark mode is restored immediately with force: true.
    renderCalls.length = 0
    markDirtyMock.mockClear()
    uiState.viewMode = `split`
    await captureShareSnapshot()
    expect(renderCalls).toEqual([
      { content: `# Snapshot`, options: { themeMode: `light`, force: true } },
      { content: `# Snapshot`, options: { themeMode: `dark`, force: true } },
    ])
    expect(markDirtyMock).not.toHaveBeenCalled()
  })
})
