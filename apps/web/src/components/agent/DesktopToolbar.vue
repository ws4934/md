<script setup lang="ts">
import { Palette, PanelLeft, Send, Sparkles } from '@lucide/vue'
import { ctrlSign } from '@md/shared/configs'
import { useAgentStore } from '@/stores/agent'
import { usePostStore } from '@/stores/post'
import { useUIStore } from '@/stores/ui'
import { isImeComposing } from './agent-ui-helpers'

const emit = defineEmits<{
  openPublish: []
}>()

const { t, locale } = useI18n()
const postStore = usePostStore()
const uiStore = useUIStore()
const agentStore = useAgentStore()

const { currentPost } = storeToRefs(postStore)
const { viewMode, isOpenRightSlider } = storeToRefs(uiStore)
const { isPanelOpen, isSidebarOpen, isCurrentSessionRunning, isWaitingPermission } = storeToRefs(agentStore)
const isMac = computed(() => window.mdDesktop?.platform === `darwin`)
const toggleShortcutHint = `${ctrlSign}J`
const sidebarShortcutHint = `${ctrlSign}\\`
const showCollapsedActivityDot = computed(
  () => !isPanelOpen.value && (isCurrentSessionRunning.value || isWaitingPermission.value),
)

const isEditingTitle = ref(false)
const editingPostId = ref<string | null>(null)
const titleDraft = ref(``)
const titleInputRef = ref<HTMLInputElement | null>(null)

const viewOptions = computed(() => {
  void locale.value
  return [
    { id: `edit` as const, label: t(`agent.toolbar.edit`) },
    { id: `split` as const, label: t(`agent.toolbar.split`) },
    { id: `preview` as const, label: t(`agent.toolbar.preview`) },
  ]
})

function startTitleEdit() {
  if (!currentPost.value)
    return
  editingPostId.value = currentPost.value.id
  titleDraft.value = currentPost.value.title
  isEditingTitle.value = true
  nextTick(() => {
    titleInputRef.value?.focus()
    titleInputRef.value?.select()
  })
}

function cancelTitleEdit() {
  editingPostId.value = null
  isEditingTitle.value = false
}

function commitTitleEdit() {
  if (!isEditingTitle.value)
    return
  const targetId = editingPostId.value
  const nextTitle = titleDraft.value.trim()
  editingPostId.value = null
  isEditingTitle.value = false
  if (targetId && nextTitle && postStore.getPostById(targetId))
    postStore.renamePost(targetId, nextTitle)
}

function onTitleKeydown(event: KeyboardEvent) {
  if (isImeComposing(event))
    return
  if (event.key === `Enter`) {
    event.preventDefault()
    commitTitleEdit()
  }
  else if (event.key === `Escape`) {
    event.preventDefault()
    event.stopPropagation()
    cancelTitleEdit()
  }
}

watch(() => currentPost.value?.id ?? null, (id) => {
  if (isEditingTitle.value && id !== editingPostId.value)
    cancelTitleEdit()
})
</script>

<template>
  <header
    data-testid="desktop-toolbar"
    class="desktop-drag-region flex h-[52px] shrink-0 items-center justify-between pr-5"
    :class="!isSidebarOpen && isMac ? 'pl-[78px]' : 'pl-5'"
    style="background-color: var(--dt-canvas)"
  >
    <!-- Left controls: Sidebar toggle (when collapsed) + Document title -->
    <div class="desktop-no-drag flex min-w-0 max-w-[45%] items-center gap-2">
      <button
        v-if="!isSidebarOpen"
        type="button"
        data-testid="toolbar-sidebar-toggle"
        :title="`${t('agent.sidebar.toggleSidebar')} (${sidebarShortcutHint})`"
        :aria-label="t('agent.sidebar.toggleSidebar')"
        class="inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:opacity-80"
        style="color: var(--dt-ink2)"
        @click="agentStore.toggleSidebar()"
      >
        <PanelLeft class="size-4" />
      </button>

      <input
        v-if="isEditingTitle"
        ref="titleInputRef"
        v-model="titleDraft"
        type="text"
        :aria-label="t('agent.sidebar.rename')"
        class="w-full min-w-0 rounded bg-transparent text-[13px] font-semibold outline-none"
        style="color: var(--dt-ink)"
        @keydown="onTitleKeydown"
        @blur="commitTitleEdit"
      >
      <button
        v-else
        type="button"
        class="min-w-0 max-w-full cursor-text truncate text-left text-[13px] font-semibold"
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
          :aria-pressed="viewMode === opt.id"
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
        :aria-pressed="isOpenRightSlider"
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
        data-testid="desktop-agent-panel-toggle"
        :title="`${t('agent.panel.togglePanel')} (${toggleShortcutHint})`"
        :aria-label="t('agent.panel.togglePanel')"
        :aria-expanded="isPanelOpen"
        class="relative inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg transition-colors"
        :style="{
          backgroundColor: isPanelOpen ? 'var(--dt-accent-soft)' : 'transparent',
          color: isPanelOpen ? 'var(--dt-accent)' : 'var(--dt-ink2)',
        }"
        @click="agentStore.togglePanel()"
      >
        <Sparkles class="size-4" />
        <span
          v-if="showCollapsedActivityDot"
          data-testid="toolbar-agent-status-dot"
          class="absolute right-[3px] top-[4px] size-[7px] rounded-full"
          :style="{
            backgroundColor: isWaitingPermission ? 'var(--dt-amber)' : 'var(--dt-accent)',
            boxShadow: '0 0 0 1.5px var(--dt-canvas)',
          }"
        />
      </button>

      <span class="w-1.5" />

      <button
        type="button"
        data-testid="desktop-publish-trigger"
        class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition-opacity hover:opacity-90"
        style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
        @click="emit('openPublish')"
      >
        <Send class="size-3.5" />
        <span>{{ t('agent.toolbar.publish') }}</span>
      </button>
    </div>
  </header>
</template>
