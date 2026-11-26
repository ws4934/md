// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { uiMock, editorMock, postMock, agentMock, localeMock } = vi.hoisted(() => ({
  uiMock: {
    isOpenRightSlider: false,
    isOpenPostSlider: false,
    isOpenFolderPanel: false,
    isShowCssEditor: false,
    toggleShowPreferencesDialog: vi.fn(),
    toggleShowKeyboardShortcutsDialog: vi.fn(),
    toggleShowMarkdownHelpDialog: vi.fn(),
    setViewMode: vi.fn(),
    toggleDark: vi.fn(),
    toggleShowImportMdDialog: vi.fn(),
    toggleShowTemplateDialog: vi.fn(),
    toggleShowEditorStateDialog: vi.fn(),
    openPdfExportDialog: vi.fn(),
    openSearchTab: vi.fn(),
    requestCopy: vi.fn(),
    toggleShowUploadImgDialog: vi.fn(),
    openTableEditDialog: vi.fn(),
    openFormulaEditor: vi.fn(),
    toggleShowComponentDialog: vi.fn(),
    toggleShowAccountDialog: vi.fn(),
    toggleShowSyncDialog: vi.fn(),
    openShareDialog: vi.fn(),
  },
  editorMock: {
    editor: null,
    getContent: vi.fn(() => `# doc`),
    flushContentToPostStore: vi.fn(),
  },
  postMock: {
    currentPostId: `post-1`,
    currentPost: { id: `post-1`, content: `# doc` } as { id: string, content: string } | undefined,
    addPost: vi.fn((title: string, _parentId?: string | null) => {
      postMock.currentPostId = `post-new`
      postMock.currentPost = { id: `post-new`, content: `# ${title}` }
    }),
    updatePostContent: vi.fn((_id: string, content: string) => {
      if (postMock.currentPost)
        postMock.currentPost.content = content
    }),
  },
  agentMock: {
    isNewArticleHero: false,
    toggleSidebar: vi.fn(),
    togglePanel: vi.fn(),
    setPanelOpen: vi.fn(),
    syncSessionForPost: vi.fn(),
  },
  localeMock: {
    cycleLocale: vi.fn(),
  },
}))

vi.mock(`@/i18n/translate`, () => ({
  t: (key: string) => key,
}))

vi.mock(`@/composables/useEditorDocumentActions`, () => ({
  useEditorDocumentActions: () => ({ formatContent: vi.fn() }),
}))

vi.mock(`@/services/account/config`, () => ({
  isAccountUiEnabled: () => true,
}))

vi.mock(`@/services/sync/client`, () => ({
  isSyncUiEnabled: () => true,
}))

vi.mock(`@/services/share/client`, () => ({
  isShareUiEnabled: () => true,
}))

vi.mock(`@/stores/ui`, () => ({
  useUIStore: () => uiMock,
}))

vi.mock(`@/stores/editor`, () => ({
  useEditorStore: () => editorMock,
}))

vi.mock(`@/stores/export`, () => ({
  useExportStore: () => ({ exportEditorContent2MD: vi.fn() }),
}))

vi.mock(`@/stores/post`, () => ({
  usePostStore: () => postMock,
}))

vi.mock(`@/stores/locale`, () => ({
  useLocaleStore: () => localeMock,
}))

vi.mock(`@/stores/agent`, () => ({
  useAgentStore: () => agentMock,
}))

describe(`useCommandPalette desktop alignment`, () => {
  const originalDesktop = window.mdDesktop

  beforeEach(() => {
    vi.clearAllMocks()
    agentMock.isNewArticleHero = false
    postMock.currentPostId = `post-1`
    postMock.currentPost = { id: `post-1`, content: `# doc` }
  })

  afterEach(() => {
    window.mdDesktop = originalDesktop
  })

  it(`hides unmounted web-only panel and cloud commands on desktop while keeping them on web`, async () => {
    const { useCommandPalette } = await import(`./useCommandPalette`)
    const { buildCommands } = useCommandPalette()

    window.mdDesktop = undefined
    const webIds = buildCommands().map(c => c.id)
    expect(webIds).toContain(`toggle-post-slider`)
    expect(webIds).toContain(`toggle-folder-panel`)
    expect(webIds).toContain(`open-css-editor`)
    expect(webIds).toContain(`editor-state`)
    expect(webIds).toContain(`open-account`)
    expect(webIds).toContain(`open-sync`)
    expect(webIds).toContain(`open-share`)

    window.mdDesktop = { isDesktop: true } as never
    const desktopIds = buildCommands().map(c => c.id)
    expect(desktopIds).not.toContain(`toggle-post-slider`)
    expect(desktopIds).not.toContain(`toggle-folder-panel`)
    expect(desktopIds).not.toContain(`open-css-editor`)
    expect(desktopIds).not.toContain(`editor-state`)
    expect(desktopIds).not.toContain(`open-account`)
    expect(desktopIds).not.toContain(`open-sync`)
    expect(desktopIds).not.toContain(`open-share`)
    expect(desktopIds).toContain(`toggle-desktop-sidebar`)
    expect(desktopIds).toContain(`toggle-agent-panel`)
    expect(desktopIds).toContain(`toggle-style-panel`)
  })

  it(`aligns new-document on desktop with DesktopSidebar createNewArticle`, async () => {
    const { useCommandPalette } = await import(`./useCommandPalette`)
    window.mdDesktop = { isDesktop: true } as never

    const { buildCommands } = useCommandPalette()
    const newDoc = buildCommands().find(c => c.id === `new-document`)!
    await newDoc.action()

    expect(editorMock.flushContentToPostStore).toHaveBeenCalledTimes(1)
    expect(postMock.addPost).toHaveBeenCalledWith(`agent.newArticle.untitled`, null)
    expect(postMock.updatePostContent).toHaveBeenCalledWith(`post-new`, ``)
    expect(agentMock.syncSessionForPost).toHaveBeenCalledWith(`post-new`)
    expect(agentMock.isNewArticleHero).toBe(true)
  })
})
