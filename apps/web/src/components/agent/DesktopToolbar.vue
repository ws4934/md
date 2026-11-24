<script setup lang="ts">
import { Loader2, Palette, Send, Sparkles } from '@lucide/vue'
import { useEditorRefresh } from '@/composables/useEditorRefresh'
import { delay } from '@/lib/delay'
import { processClipboardContent } from '@/services/export'
import { useAgentStore } from '@/stores/agent'
import { usePostStore } from '@/stores/post'
import { useThemeStore } from '@/stores/theme'
import { useUIStore } from '@/stores/ui'

const emit = defineEmits<{
  startCopy: []
  endCopy: []
}>()

const { t } = useI18n()
const postStore = usePostStore()
const uiStore = useUIStore()
const themeStore = useThemeStore()
const agentStore = useAgentStore()
const { editorRefresh } = useEditorRefresh()

const { currentPost } = storeToRefs(postStore)
const { viewMode, isOpenRightSlider } = storeToRefs(uiStore)
const { primaryColor } = storeToRefs(themeStore)
const { isPanelOpen } = storeToRefs(agentStore)

const isEditingTitle = ref(false)
const titleDraft = ref(``)
const isPublishing = ref(false)

const viewOptions = computed(() => [
  { id: `edit` as const, label: t(`agent.toolbar.edit`) },
  { id: `split` as const, label: t(`agent.toolbar.split`) },
  { id: `preview` as const, label: t(`agent.toolbar.preview`) },
])

function startTitleEdit() {
  if (!currentPost.value)
    return
  titleDraft.value = currentPost.value.title
  isEditingTitle.value = true
}

function commitTitleEdit() {
  if (currentPost.value && titleDraft.value.trim())
    postStore.renamePost(currentPost.value.id, titleDraft.value.trim())
  isEditingTitle.value = false
}

async function publishToWeChat() {
  if (isPublishing.value)
    return
  isPublishing.value = true
  emit(`startCopy`)

  try {
    await nextTick()
    await delay(150)
    const processed = await processClipboardContent(primaryColor.value)
    const item = new ClipboardItem({
      'text/html': new Blob([processed.html], { type: `text/html` }),
      'text/plain': new Blob([processed.plainText], { type: `text/plain` }),
    })
    await navigator.clipboard.write([item])
    toast.success(t(`agent.toolbar.copiedToWeChat`))
    editorRefresh()
  }
  catch (error) {
    toast.error(t(`toast.copyFailed`, { message: error instanceof Error ? error.message : String(error) }))
    editorRefresh()
  }
  finally {
    emit(`endCopy`)
    isPublishing.value = false
  }
}
</script>

<template>
  <header
    class="desktop-drag-region flex h-[52px] shrink-0 items-center justify-between px-5"
    style="background-color: var(--dt-canvas)"
  >
    <!-- Document title -->
    <div class="desktop-no-drag min-w-0 max-w-[40%]">
      <input
        v-if="isEditingTitle"
        v-model="titleDraft"
        type="text"
        class="w-full rounded bg-transparent text-[13px] font-semibold outline-none"
        style="color: var(--dt-ink)"
        autofocus
        @keydown.enter="commitTitleEdit"
        @keydown.escape="isEditingTitle = false"
        @blur="commitTitleEdit"
      >
      <button
        v-else
        type="button"
        class="max-w-full cursor-text truncate text-left text-[13px] font-semibold"
        style="color: var(--dt-ink)"
        @dblclick="startTitleEdit"
      >
        {{ currentPost?.title || t('agent.newArticle.untitled') }}
      </button>
    </div>

    <!-- Right controls: Segmented view mode, Theme, Agent panel toggle, Publish -->
    <div class="desktop-no-drag flex shrink-0 items-center gap-1.5">
      <div
        class="flex items-center gap-0.5 rounded-lg p-0.5"
        style="background-color: var(--dt-subtle)"
      >
        <button
          v-for="opt in viewOptions"
          :key="opt.id"
          type="button"
          class="inline-flex h-[26px] cursor-pointer items-center rounded-[6px] px-3 text-[12.5px] font-medium transition-all"
          :style="{
            backgroundColor: viewMode === opt.id ? 'var(--dt-surface)' : 'transparent',
            color: viewMode === opt.id ? 'var(--dt-ink)' : 'var(--dt-ink2)',
            boxShadow: viewMode === opt.id ? '0 1px 2px rgba(0, 0, 0, 0.08)' : 'none',
          }"
          @click="uiStore.setViewMode(opt.id)"
        >
          {{ opt.label }}
        </button>
      </div>

      <span class="w-1.5" />

      <button
        type="button"
        :title="t('agent.toolbar.theme')"
        :aria-label="t('agent.toolbar.theme')"
        class="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg transition-colors"
        :style="{
          backgroundColor: isOpenRightSlider ? 'var(--dt-subtle)' : 'transparent',
          color: isOpenRightSlider ? 'var(--dt-ink)' : 'var(--dt-ink2)',
        }"
        @click="isOpenRightSlider = !isOpenRightSlider"
      >
        <Palette class="size-4" />
      </button>

      <button
        type="button"
        :title="t('agent.panel.togglePanel')"
        :aria-label="t('agent.panel.togglePanel')"
        class="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg transition-colors"
        :style="{
          backgroundColor: isPanelOpen ? 'var(--dt-accent-soft)' : 'transparent',
          color: isPanelOpen ? 'var(--dt-accent)' : 'var(--dt-ink2)',
        }"
        @click="isPanelOpen = !isPanelOpen"
      >
        <Sparkles class="size-4" />
      </button>

      <span class="w-1.5" />

      <button
        type="button"
        :disabled="isPublishing"
        class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
        style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
        @click="publishToWeChat"
      >
        <Loader2 v-if="isPublishing" class="size-3.5 animate-spin" />
        <Send v-else class="size-3.5" />
        <span>{{ t('agent.toolbar.publish') }}</span>
      </button>
    </div>
  </header>
</template>
