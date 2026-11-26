import type { ComputedRef, Ref } from 'vue'
import type { Post } from '@/types/post'
import { watch } from 'vue'

export interface EditorPostSyncOptions {
  currentPostId: Ref<string>
  currentPost: ComputedRef<Post | undefined>
  getPostById: (id: string) => Post | undefined
  hasEditor: () => boolean
  getEditorContent: () => string
  applyContentToEditor: (content: string, options: { isPostSwitch: boolean }) => void
  onActivePostChange?: (postId: string | null) => void
  persistDelayMs?: number
}

/**
 * Coordinates CodeMirror document state with `usePostStore` using a single unified
 * watcher and explicit `loadedPostId` tracking.
 *
 * Keeping post-id and content changes in one watcher prevents Vue's subscriber
 * notification order from syncing the new post's content into CodeMirror before
 * flushing the previous post (which previously overwrote the previous post with
 * the newly selected post's content on every switch). Tracking by post ID instead
 * of array index also prevents `delPost` index shifts from corrupting neighbors.
 */
export function useEditorPostSync(options: EditorPostSyncOptions) {
  const persistDelayMs = options.persistDelayMs ?? 300
  let loadedPostId: string | null = null
  let pendingPostSwitch = false
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  let syncingDepth = 0

  function cancelPendingPersist() {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer)
      persistTimer = undefined
    }
  }

  function isSyncingFromStore(): boolean {
    return syncingDepth > 0
  }

  function runStoreSync(fn: () => void) {
    syncingDepth++
    try {
      fn()
    }
    finally {
      syncingDepth--
    }
  }

  function bindLoadedPost(postId: string | null) {
    loadedPostId = postId || null
    pendingPostSwitch = false
    options.onActivePostChange?.(loadedPostId)
  }

  function unbindLoadedPost() {
    cancelPendingPersist()
    loadedPostId = null
    pendingPostSwitch = false
    options.onActivePostChange?.(null)
  }

  function flushLoadedPostContent() {
    cancelPendingPersist()
    if (!options.hasEditor() || !loadedPostId)
      return

    const post = options.getPostById(loadedPostId)
    if (!post)
      return

    const value = options.getEditorContent()
    if (value === post.content)
      return

    post.updateDatetime = new Date()
    post.content = value
  }

  function schedulePersist() {
    cancelPendingPersist()
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      flushLoadedPostContent()
    }, persistDelayMs)
  }

  watch(
    [options.currentPostId, () => options.currentPost.value?.content] as const,
    ([nextPostId, nextContent]) => {
      if (!options.hasEditor())
        return

      const normalizedNextId = nextPostId || null
      if (normalizedNextId !== loadedPostId) {
        flushLoadedPostContent()
        bindLoadedPost(normalizedNextId)
        if (nextContent != null) {
          runStoreSync(() => {
            options.applyContentToEditor(nextContent, { isPostSwitch: true })
          })
        }
        else {
          pendingPostSwitch = true
        }
        return
      }

      // Same post updated externally (cloud sync, agent sync, import, template):
      // cancel any stale debounced persist so it cannot revert the external update.
      cancelPendingPersist()
      if (nextContent != null) {
        const isPostSwitch = pendingPostSwitch
        pendingPostSwitch = false
        runStoreSync(() => {
          options.applyContentToEditor(nextContent, { isPostSwitch })
        })
      }
    },
  )

  return {
    getLoadedPostId: () => loadedPostId,
    isSyncingFromStore,
    bindLoadedPost,
    unbindLoadedPost,
    flushLoadedPostContent,
    schedulePersist,
    cancelPendingPersist,
  }
}
