import { useEditorStore } from '@/stores/editor'
import { useRenderStore } from '@/stores/render'
import { useThemeStore } from '@/stores/theme'
import { useUIStore } from '@/stores/ui'

/** Debounce after the last keystroke before preview refresh */
const EDITOR_REFRESH_DEBOUNCE_MS = 300
/** Cap so continuous typing still refreshes preview periodically */
const EDITOR_REFRESH_MAX_WAIT_MS = 800

/**
 * Trigger editor preview re-render (current theme and style config).
 * scheduleEditorRefresh coalesces rapid edits via debounce + max-wait.
 * While `viewMode === 'edit'`, rendering is deferred (marked dirty) until
 * the preview becomes visible or a forced flush runs before copy/publish/export.
 */
export function useEditorRefresh(options?: {
  debounceMs?: number
  maxWaitMs?: number
}) {
  const themeStore = useThemeStore()
  const editorStore = useEditorStore()
  const renderStore = useRenderStore()
  const uiStore = useUIStore()
  const debounceMs = options?.debounceMs ?? EDITOR_REFRESH_DEBOUNCE_MS
  const maxWaitMs = options?.maxWaitMs ?? EDITOR_REFRESH_MAX_WAIT_MS
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined

  function clearTimers() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer)
      maxWaitTimer = undefined
    }
  }

  function editorRefresh(refreshOptions?: { force?: boolean }) {
    if (!refreshOptions?.force && uiStore.viewMode === `edit`) {
      renderStore.markDirty()
      return
    }
    themeStore.updateCodeTheme()
    const raw = editorStore.getContent()
    renderStore.render(raw, refreshOptions)
  }

  function flushScheduledRefresh(refreshOptions?: { force?: boolean }) {
    clearTimers()
    editorRefresh(refreshOptions)
  }

  function scheduleEditorRefresh() {
    if (uiStore.viewMode === `edit`) {
      clearTimers()
      renderStore.markDirty()
      return
    }

    if (debounceTimer)
      clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      if (maxWaitTimer) {
        clearTimeout(maxWaitTimer)
        maxWaitTimer = undefined
      }
      editorRefresh()
    }, debounceMs)

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = undefined
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = undefined
        }
        editorRefresh()
      }, maxWaitMs)
    }
  }

  onUnmounted(() => {
    if (debounceTimer || maxWaitTimer) {
      clearTimers()
      editorRefresh()
    }
  })

  return { editorRefresh, scheduleEditorRefresh, flushScheduledRefresh }
}
