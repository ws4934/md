import { stripUnresolvedAsyncPlaceholders, waitForPreviewReady } from '@/lib/preview/preview-ready'
import { getHtmlContent, getShareExportStyles } from '@/services/export'
import { useEditorStore } from '@/stores/editor'
import { useRenderStore } from '@/stores/render'
import { useThemeStore } from '@/stores/theme'
import { useUIStore } from '@/stores/ui'

/** Capture a light-theme share snapshot (re-renders temporarily if editor is in dark mode). */
export async function captureShareSnapshot(): Promise<{ bodyHtml: string, stylesHtml: string }> {
  const renderStore = useRenderStore()
  const editorStore = useEditorStore()
  const themeStore = useThemeStore()
  const uiStore = useUIStore()
  const content = editorStore.getContent()
  const rerenderForLight = uiStore.isDark
  const shareThemeMode = `light` as const

  if (rerenderForLight || renderStore.isDirty || !renderStore.output) {
    themeStore.updateCodeTheme()
    renderStore.render(content, { themeMode: shareThemeMode, force: rerenderForLight })
  }

  const ready = await waitForPreviewReady(undefined, { themeMode: shareThemeMode })

  try {
    let bodyHtml = getHtmlContent({ themeMode: shareThemeMode })
    if (!ready) {
      const wrapper = document.createElement(`div`)
      wrapper.innerHTML = bodyHtml
      stripUnresolvedAsyncPlaceholders(wrapper)
      bodyHtml = wrapper.innerHTML
    }

    return {
      bodyHtml,
      stylesHtml: await getShareExportStyles(),
    }
  }
  finally {
    if (rerenderForLight) {
      if (uiStore.viewMode === `edit`)
        renderStore.markDirty()
      else
        renderStore.render(content, { themeMode: `dark`, force: true })
    }
  }
}
