<script setup lang="ts">
import type { Post } from '@/types/post'
import { Ellipsis, PanelLeft, Search, Settings, SquarePen, Trash2 } from '@lucide/vue'
import { ctrlSign, shiftSign } from '@md/shared/configs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { useAgentStore } from '@/stores/agent'
import { useConfirmStore } from '@/stores/confirm'
import { useEditorStore } from '@/stores/editor'
import { usePostStore } from '@/stores/post'
import { useUIStore } from '@/stores/ui'
import { isImeComposing } from './agent-ui-helpers'

const { t, locale } = useI18n()
const postStore = usePostStore()
const editorStore = useEditorStore()
const uiStore = useUIStore()
const agentStore = useAgentStore()
const confirmStore = useConfirmStore()

const { posts, currentPostId } = storeToRefs(postStore)
const { writingPostIds } = storeToRefs(agentStore)

const isMac = computed(() => window.mdDesktop?.platform === `darwin`)
const sidebarShortcutHint = `${ctrlSign}\\`
const commandPaletteShortcutHint = `${ctrlSign}${shiftSign}.`

function toTimestamp(value: Date | string | number): number {
  if (value instanceof Date)
    return value.getTime()
  if (typeof value === `number`)
    return value
  return Date.parse(value) || 0
}

const sortedPosts = computed(() =>
  [...posts.value].sort((a, b) => toTimestamp(b.updateDatetime) - toTimestamp(a.updateDatetime)),
)

const renamingId = ref<string | null>(null)
const renameDraft = ref(``)

function createNewArticle() {
  editorStore.flushContentToPostStore()
  postStore.addPost(t(`agent.newArticle.untitled`), null)
  if (postStore.currentPost)
    postStore.updatePostContent(postStore.currentPost.id, ``)
  agentStore.syncSessionForPost(postStore.currentPostId)
  agentStore.isNewArticleHero = true
}

function selectPost(post: Post) {
  editorStore.flushContentToPostStore()
  postStore.currentPostId = post.id
  agentStore.syncSessionForPost(post.id)
  agentStore.isNewArticleHero = false
}

function beginRename(post: Post) {
  renamingId.value = post.id
  renameDraft.value = post.title
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>(`[data-rename-post-id="${CSS.escape(post.id)}"]`)
    input?.focus()
    input?.select()
  })
}

function cancelRename() {
  renamingId.value = null
  renameDraft.value = ``
}

function commitRename(id: string) {
  if (renamingId.value !== id)
    return
  const next = renameDraft.value.trim()
  renamingId.value = null
  if (next)
    postStore.renamePost(id, next)
}

function onRenameKeydown(event: KeyboardEvent, id: string) {
  if (isImeComposing(event))
    return
  if (event.key === `Enter`) {
    event.preventDefault()
    commitRename(id)
  }
  else if (event.key === `Escape`) {
    event.preventDefault()
    event.stopPropagation()
    cancelRename()
  }
}

function deletePost(post: Post) {
  confirmStore.confirm({
    title: t(`confirm.tip`),
    description: t(`confirm.deleteItem`, { name: post.title }),
    confirmText: t(`post.confirmDelete`),
    destructive: true,
    onConfirm: () => {
      postStore.delPost(post.id)
      if (posts.value.length === 0)
        createNewArticle()
      else
        agentStore.syncSessionForPost(postStore.currentPostId)
    },
  })
}

function formatMeta(post: Post): string {
  void locale.value
  const diffMs = Date.now() - toTimestamp(post.updateDatetime)
  if (diffMs < 60_000)
    return t(`agent.sidebar.justNow`)
  return formatRelativeTime(post.updateDatetime)
}
</script>

<template>
  <aside
    data-testid="desktop-sidebar"
    class="flex h-full w-full flex-col overflow-hidden select-none"
    style="background-color: var(--dt-sidebar)"
  >
    <!-- Titlebar area: reserves macOS traffic lights inset on the left -->
    <div
      class="desktop-drag-region flex h-[52px] shrink-0 items-center justify-between pr-2.5"
      :class="isMac ? 'pl-[80px]' : 'pl-2.5'"
    >
      <button
        type="button"
        data-testid="sidebar-collapse-btn"
        :title="`${t('agent.sidebar.toggleSidebar')} (${sidebarShortcutHint})`"
        :aria-label="t('agent.sidebar.toggleSidebar')"
        class="desktop-no-drag inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg transition-colors hover:opacity-80"
        style="color: var(--dt-ink2)"
        @click="agentStore.toggleSidebar()"
      >
        <PanelLeft class="size-4" />
      </button>

      <button
        type="button"
        :title="t('agent.sidebar.newArticle')"
        :aria-label="t('agent.sidebar.newArticle')"
        class="desktop-no-drag inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg transition-colors hover:opacity-80"
        style="color: var(--dt-ink2)"
        @click="createNewArticle"
      >
        <SquarePen class="size-4" />
      </button>
    </div>

    <!-- Search row opening Command Palette -->
    <div class="shrink-0 px-2.5 pb-1">
      <button
        type="button"
        class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left transition-colors hover:opacity-85"
        style="color: var(--dt-ink3)"
        @click="uiStore.toggleShowCommandPalette(true)"
      >
        <Search class="size-3.5 shrink-0" />
        <span class="flex-1 text-[13px]">{{ t('agent.sidebar.search') }}</span>
        <span class="text-[11.5px]">{{ commandPaletteShortcutHint }}</span>
      </button>
    </div>

    <!-- Document list ONLY -->
    <div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 py-1">
      <div
        v-for="post in sortedPosts"
        :key="post.id"
        v-memo="[
          post.id === currentPostId,
          post.title,
          toTimestamp(post.updateDatetime),
          renamingId === post.id,
          renamingId === post.id ? renameDraft : '',
          writingPostIds.has(post.id),
          locale,
        ]"
        class="group relative flex w-full rounded-lg transition-colors"
        :style="{
          backgroundColor: post.id === currentPostId ? 'var(--dt-subtle)' : 'transparent',
        }"
      >
        <div v-if="renamingId === post.id" class="flex w-full flex-col gap-0.5 px-3 py-[9px]">
          <input
            v-model="renameDraft"
            :data-rename-post-id="post.id"
            type="text"
            class="w-full rounded bg-transparent text-[13px] font-medium outline-none"
            style="color: var(--dt-ink)"
            @click.stop
            @keydown="onRenameKeydown($event, post.id)"
            @blur="commitRename(post.id)"
          >
          <div class="flex items-center gap-1.5">
            <template v-if="writingPostIds.has(post.id)">
              <span class="size-[5px] shrink-0 rounded-full" style="background-color: var(--dt-accent)" />
              <span class="text-[11.5px]" style="color: var(--dt-accent)">
                {{ t('agent.panel.writingBadge') }}
              </span>
            </template>
            <span v-else class="text-[11.5px]" style="color: var(--dt-ink3)">
              {{ formatMeta(post) }}
            </span>
          </div>
        </div>

        <template v-else>
          <button
            type="button"
            :aria-current="post.id === currentPostId ? 'true' : undefined"
            class="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-[9px] pr-8 text-left"
            @click="selectPost(post)"
          >
            <span
              class="w-full truncate text-[13px]"
              :style="{
                color: 'var(--dt-ink)',
                fontWeight: post.id === currentPostId ? 600 : 500,
              }"
            >
              {{ post.title }}
            </span>

            <span class="flex items-center gap-1.5">
              <template v-if="writingPostIds.has(post.id)">
                <span class="size-[5px] shrink-0 rounded-full" style="background-color: var(--dt-accent)" />
                <span class="text-[11.5px]" style="color: var(--dt-accent)">
                  {{ t('agent.panel.writingBadge') }}
                </span>
              </template>
              <span v-else class="text-[11.5px]" style="color: var(--dt-ink3)">
                {{ formatMeta(post) }}
              </span>
            </span>
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                :aria-label="t('common.moreActions')"
                class="absolute right-2 top-[9px] inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                style="color: var(--dt-ink3)"
                @click.stop
              >
                <Ellipsis class="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-36">
              <DropdownMenuItem class="cursor-pointer text-xs" @click.stop="beginRename(post)">
                {{ t('agent.sidebar.rename') }}
              </DropdownMenuItem>
              <DropdownMenuItem
                class="cursor-pointer text-xs text-destructive"
                @click.stop="deletePost(post)"
              >
                <Trash2 class="mr-1.5 size-3.5" />
                {{ t('agent.sidebar.delete') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </template>
      </div>
    </div>

    <!-- Bottom settings trigger -->
    <div class="flex shrink-0 items-center px-2.5 pb-2.5 pt-1">
      <button
        type="button"
        :title="t('agent.sidebar.settings')"
        :aria-label="t('agent.sidebar.settings')"
        class="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg transition-colors hover:opacity-80"
        style="color: var(--dt-ink3)"
        @click="uiStore.openPreferencesDialog('general')"
      >
        <Settings class="size-4" />
      </button>
    </div>
  </aside>
</template>
