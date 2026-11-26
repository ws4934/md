import type { Post } from '@/types/post'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { useEditorPostSync } from './useEditorPostSync'

function makePost(id: string, title: string, content: string, updatedAt = 1_700_000_000_000): Post {
  return {
    id,
    title,
    content,
    history: [],
    createDatetime: new Date(updatedAt),
    updateDatetime: new Date(updatedAt),
  }
}

describe(`useEditorPostSync`, () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it(`switches between posts without overwriting the previous post even when currentPost is observed earlier`, async () => {
    const oldTimeA = 1_700_000_000_000
    const oldTimeB = 1_700_000_100_000
    const posts = ref<Post[]>([
      makePost(`post-a`, `内容1`, `# 探索 Markdown 的奇妙世界`, oldTimeA),
      makePost(`post-b`, `未命名文章`, ``, oldTimeB),
    ])
    const currentPostId = ref(`post-a`)
    const currentPost = computed(() => posts.value.find(p => p.id === currentPostId.value))
    // Mirror DesktopToolbar reading currentPost before EditorPanel mounts.
    void currentPost.value?.title

    let editorDoc = posts.value[0].content
    const applied: Array<{ content: string, isPostSwitch: boolean }> = []
    let activePostId: string | null = null

    const sync = useEditorPostSync({
      currentPostId,
      currentPost,
      getPostById: id => posts.value.find(p => p.id === id),
      hasEditor: () => true,
      getEditorContent: () => editorDoc,
      applyContentToEditor: (content, opts) => {
        // Programmatic store->editor sync must run with isSyncingFromStore() === true.
        expect(sync.isSyncingFromStore()).toBe(true)
        editorDoc = content
        applied.push({ content, isPostSwitch: opts.isPostSwitch })
      },
      onActivePostChange: (id) => { activePostId = id },
    })

    sync.bindLoadedPost(`post-a`)
    expect(activePostId).toBe(`post-a`)

    // Switch A -> B: A must keep its original content and timestamp; editor loads B.
    currentPostId.value = `post-b`
    await nextTick()

    expect(posts.value[0].content).toBe(`# 探索 Markdown 的奇妙世界`)
    expect(posts.value[0].updateDatetime.getTime()).toBe(oldTimeA)
    expect(posts.value[1].content).toBe(``)
    expect(editorDoc).toBe(``)
    expect(activePostId).toBe(`post-b`)
    expect(applied).toEqual([{ content: ``, isPostSwitch: true }])

    // Switch B -> A: B stays empty; editor restores A's full content.
    currentPostId.value = `post-a`
    await nextTick()

    expect(posts.value[1].content).toBe(``)
    expect(posts.value[1].updateDatetime.getTime()).toBe(oldTimeB)
    expect(editorDoc).toBe(`# 探索 Markdown 的奇妙世界`)
    expect(activePostId).toBe(`post-a`)
  })

  it(`flushes pending unsaved edits to the exact previous post before loading the target post`, async () => {
    const posts = ref<Post[]>([
      makePost(`post-a`, `Post A`, `Initial A`),
      makePost(`post-b`, `Post B`, `Initial B`),
    ])
    const currentPostId = ref(`post-a`)
    const currentPost = computed(() => posts.value.find(p => p.id === currentPostId.value))

    let editorDoc = `Initial A`
    const sync = useEditorPostSync({
      currentPostId,
      currentPost,
      getPostById: id => posts.value.find(p => p.id === id),
      hasEditor: () => true,
      getEditorContent: () => editorDoc,
      applyContentToEditor: (content) => {
        editorDoc = content
      },
    })
    sync.bindLoadedPost(`post-a`)

    // User types in A and switches to B before the 300ms persist debounce fires.
    editorDoc = `Edited A`
    sync.schedulePersist()
    currentPostId.value = `post-b`
    await nextTick()

    expect(posts.value[0].content).toBe(`Edited A`)
    expect(posts.value[1].content).toBe(`Initial B`)
    expect(editorDoc).toBe(`Initial B`)

    // Advancing past the old 300ms debounce timer must not overwrite B with anything stale.
    vi.advanceTimersByTime(500)
    expect(posts.value[0].content).toBe(`Edited A`)
    expect(posts.value[1].content).toBe(`Initial B`)
  })

  it(`does not corrupt neighboring posts when deleting a post shifts array indices`, async () => {
    const posts = ref<Post[]>([
      makePost(`post-0`, `Zero`, `Content 0`),
      makePost(`post-1`, `One`, `Content 1`),
      makePost(`post-2`, `Two`, `Content 2`),
    ])
    const currentPostId = ref(`post-1`)
    const currentPost = computed(() => posts.value.find(p => p.id === currentPostId.value))

    let editorDoc = `Content 1`
    const sync = useEditorPostSync({
      currentPostId,
      currentPost,
      getPostById: id => posts.value.find(p => p.id === id),
      hasEditor: () => true,
      getEditorContent: () => editorDoc,
      applyContentToEditor: (content) => {
        editorDoc = content
      },
    })
    sync.bindLoadedPost(`post-1`)

    // Delete post-0 while editing post-1 (index shifts 1 -> 0, post-2 moves to index 1).
    posts.value.splice(0, 1)
    await nextTick()

    expect(posts.value[0].id).toBe(`post-1`)
    expect(posts.value[1].id).toBe(`post-2`)
    expect(posts.value[1].content).toBe(`Content 2`)
    expect(editorDoc).toBe(`Content 1`)

    // Delete the currently active post-1: switches to post-2 without writing post-1's doc into post-2.
    editorDoc = `Unsaved edit on deleted post-1`
    posts.value.splice(0, 1)
    currentPostId.value = `post-2`
    await nextTick()

    expect(posts.value[0].id).toBe(`post-2`)
    expect(posts.value[0].content).toBe(`Content 2`)
    expect(editorDoc).toBe(`Content 2`)
  })

  it(`cancels pending debounced persist when the active post is updated externally`, async () => {
    const posts = ref<Post[]>([
      makePost(`post-a`, `Post A`, `Initial A`),
    ])
    const currentPostId = ref(`post-a`)
    const currentPost = computed(() => posts.value.find(p => p.id === currentPostId.value))

    let editorDoc = `Initial A`
    const sync = useEditorPostSync({
      currentPostId,
      currentPost,
      getPostById: id => posts.value.find(p => p.id === id),
      hasEditor: () => true,
      getEditorContent: () => editorDoc,
      applyContentToEditor: (content, opts) => {
        expect(opts.isPostSwitch).toBe(false)
        editorDoc = content
      },
    })
    sync.bindLoadedPost(`post-a`)

    editorDoc = `Local typing`
    sync.schedulePersist()

    // External update (e.g. cloud sync or agent article_synced) arrives within the 300ms window.
    posts.value[0].content = `Synced from agent`
    await nextTick()

    expect(editorDoc).toBe(`Synced from agent`)
    vi.advanceTimersByTime(500)
    expect(posts.value[0].content).toBe(`Synced from agent`)
  })

  it(`marks delayed post hydration as isPostSwitch when target post arrives after currentPostId changes`, async () => {
    const posts = ref<Post[]>([
      makePost(`post-a`, `Post A`, `Same Body`),
    ])
    const currentPostId = ref(`post-a`)
    const currentPost = computed(() => posts.value.find(p => p.id === currentPostId.value))

    let editorDoc = `Same Body`
    const switchFlags: boolean[] = []
    const sync = useEditorPostSync({
      currentPostId,
      currentPost,
      getPostById: id => posts.value.find(p => p.id === id),
      hasEditor: () => true,
      getEditorContent: () => editorDoc,
      applyContentToEditor: (content, opts) => {
        editorDoc = content
        switchFlags.push(opts.isPostSwitch)
      },
    })
    sync.bindLoadedPost(`post-a`)

    // Switch to post-b before post-b exists in `posts` (e.g. async sync hydration).
    currentPostId.value = `post-b`
    await nextTick()
    expect(switchFlags).toEqual([])

    posts.value.push(makePost(`post-b`, `Post B`, `Same Body`))
    await nextTick()
    expect(switchFlags).toEqual([true])
  })
})
