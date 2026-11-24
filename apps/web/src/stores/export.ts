import type { PdfExportOptions } from '@/services/export'
import { t } from '@/i18n/translate'
import {
  DEFAULT_PNG_SEGMENT_HEIGHT,
  downloadMD,
  exportHTML,
  exportPDF,
  exportPNG,
  exportPNGSegments,
  exportPureHTML,
  getHtmlContent,
} from '@/services/export'
import { useEditorStore } from './editor'
import { usePostStore } from './post'
import { useRenderStore } from './render'
import { useThemeStore } from './theme'
import { useUIStore } from './ui'

/** Export helpers: HTML, PDF, Markdown, card image, etc. */
export const useExportStore = defineStore(`export`, () => {
  const editorStore = useEditorStore()
  const postStore = usePostStore()
  const renderStore = useRenderStore()
  const themeStore = useThemeStore()
  const uiStore = useUIStore()

  async function flushPreviewForExport() {
    if (!renderStore.isDirty && renderStore.output)
      return
    themeStore.updateCodeTheme()
    renderStore.render(editorStore.getContent())
    // Wait for PreviewPanel's flush: 'post' watcher to patch #output before DOM export reads it.
    await nextTick()
  }

  const editorContent2HTML = async () => {
    await flushPreviewForExport()
    return getHtmlContent()
  }

  const exportEditorContent2HTML = async () => {
    const currentPost = postStore.currentPost
    if (!currentPost)
      return

    await flushPreviewForExport()
    await exportHTML(currentPost.title)
  }

  const exportEditorContent2PureHTML = (content: string) => {
    const currentPost = postStore.currentPost
    if (!currentPost)
      return

    exportPureHTML(content, currentPost.title)
  }

  const downloadAsCardImage = async () => {
    const currentPost = postStore.currentPost
    if (!currentPost)
      return

    await flushPreviewForExport()
    await exportPNG(currentPost.title, {
      previewDevice: uiStore.previewDevice,
    })
  }

  const downloadAsSegmentedImages = async (maxSegmentHeight = DEFAULT_PNG_SEGMENT_HEIGHT) => {
    const currentPost = postStore.currentPost
    if (!currentPost)
      return

    await flushPreviewForExport()
    const toastId = toast.loading(t(`store.png.segmentsStart`))
    try {
      const count = await exportPNGSegments(currentPost.title, {
        previewDevice: uiStore.previewDevice,
        maxSegmentHeight,
        onProgress: (done, total) => {
          toast.loading(t(`store.png.segmentsProgress`, { done, total }), { id: toastId })
        },
      })

      if (count === 0)
        toast.error(t(`store.png.segmentsEmpty`), { id: toastId })
      else
        toast.success(t(`store.png.segmentsDone`, { count }), { id: toastId })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t(`store.png.segmentsFailed`, { message }), { id: toastId })
    }
  }

  const exportEditorContent2PDF = async (options?: Partial<PdfExportOptions>) => {
    const currentPost = postStore.currentPost
    if (!currentPost)
      return

    await flushPreviewForExport()
    await exportPDF(currentPost.title, options)
  }

  const exportEditorContent2MD = (content: string) => {
    const currentPost = postStore.currentPost
    if (!currentPost)
      return

    downloadMD(content, currentPost.title)
  }

  return {
    editorContent2HTML,
    exportEditorContent2HTML,
    exportEditorContent2PureHTML,
    downloadAsCardImage,
    downloadAsSegmentedImages,
    exportEditorContent2PDF,
    exportEditorContent2MD,
  }
})
