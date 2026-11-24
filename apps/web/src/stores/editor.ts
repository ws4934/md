import type { EditorView } from '@codemirror/view'
import { t } from '@/i18n/translate'

/** CodeMirror editor instance and basic document operations. */
export const useEditorStore = defineStore(`editor`, () => {
  const editor = shallowRef<EditorView | null>(null)

  let flushPendingContent: (() => void) | null = null

  function registerContentFlush(fn: () => void) {
    flushPendingContent = fn
  }

  function unregisterContentFlush() {
    flushPendingContent = null
  }

  /** Sync debounced editor content to post store (call before page refresh). */
  function flushContentToPostStore() {
    flushPendingContent?.()
  }

  const formatContent = async () => {
    if (!editor.value)
      return

    const { formatDoc } = await import('@md/shared/utils/formatDoc')
    const doc = await formatDoc(editor.value.state.doc.toString())
    editor.value.dispatch({
      changes: { from: 0, to: editor.value.state.doc.length, insert: doc },
    })
    return doc
  }

  const importContent = (content: string) => {
    if (!editor.value)
      return

    editor.value.dispatch({
      changes: { from: 0, to: editor.value.state.doc.length, insert: content },
    })
  }

  /**
   * Replaces only the minimal differing range (stripping common prefix/suffix)
   * so CodeMirror preserves selection, scroll position, and incremental parse state.
   */
  const applyMinimalContent = (content: string) => {
    const view = editor.value
    if (!view)
      return

    const prev = view.state.doc.toString()
    if (prev === content)
      return

    let prefix = 0
    const minLen = Math.min(prev.length, content.length)
    while (prefix < minLen && prev.charCodeAt(prefix) === content.charCodeAt(prefix))
      prefix++

    let suffix = 0
    while (
      suffix < minLen - prefix
      && prev.charCodeAt(prev.length - 1 - suffix) === content.charCodeAt(content.length - 1 - suffix)
    ) {
      suffix++
    }

    const from = prefix
    const to = prev.length - suffix
    const insert = content.slice(prefix, content.length - suffix)
    const prevScrollTop = view.scrollDOM.scrollTop

    view.dispatch({
      changes: { from, to, insert },
    })

    if (view.scrollDOM.scrollTop !== prevScrollTop)
      view.scrollDOM.scrollTop = prevScrollTop
  }

  const clearContent = () => {
    if (!editor.value)
      return

    editor.value.dispatch({
      changes: { from: 0, to: editor.value.state.doc.length, insert: `` },
    })
    toast.success(t('store.editor.contentCleared'))
  }

  const getContent = () => {
    return editor.value?.state.doc.toString() ?? ``
  }

  const getSelection = () => {
    if (!editor.value)
      return ``

    const selection = editor.value.state.selection.main
    return editor.value.state.doc.sliceString(selection.from, selection.to)
  }

  const replaceSelection = (text: string) => {
    if (!editor.value)
      return

    editor.value.dispatch(editor.value.state.replaceSelection(text))
  }

  const replaceText = (oldText: string, newText: string) => {
    if (!editor.value || !oldText)
      return false

    const content = editor.value.state.doc.toString()
    const cursor = editor.value.state.selection.main.head

    let bestFrom = -1
    let bestDist = Infinity
    let pos = 0
    while (true) {
      const idx = content.indexOf(oldText, pos)
      if (idx === -1)
        break
      const dist = Math.abs(idx - cursor)
      if (dist < bestDist) {
        bestDist = dist
        bestFrom = idx
      }
      pos = idx + 1
    }

    if (bestFrom === -1)
      return false

    editor.value.dispatch({
      changes: { from: bestFrom, to: bestFrom + oldText.length, insert: newText },
    })
    editor.value.focus()
    return true
  }

  const insertAtCursor = (text: string) => {
    if (!editor.value)
      return

    const selection = editor.value.state.selection.main
    editor.value.dispatch({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: { anchor: selection.from + text.length },
    })
    editor.value.focus()
  }

  return {
    editor,
    registerContentFlush,
    unregisterContentFlush,
    flushContentToPostStore,
    formatContent,
    importContent,
    applyMinimalContent,
    clearContent,
    getContent,
    getSelection,
    replaceSelection,
    replaceText,
    insertAtCursor,
  }
})
