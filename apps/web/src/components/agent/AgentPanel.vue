<script setup lang="ts">
import type { AcpPermissionDecision } from '@md/shared/types'
import type { AgentTimelineItem as TimelineItem } from '@/stores/agent'
import { ArrowDown, History, LoaderCircle, PanelRightClose, Plus, Trash2 } from '@lucide/vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { groupTimelineItems } from '@/lib/agent/timeline-blocks'
import { useAgentStore } from '@/stores/agent'
import { usePostStore } from '@/stores/post'
import { createTimelineBlockStabilizer, filterSessionsForPost } from './agent-ui-helpers'
import AgentAvatar from './AgentAvatar.vue'
import AgentComposer from './AgentComposer.vue'
import AgentTimelineItem from './AgentTimelineItem.vue'

const { t, locale } = useI18n()
const agentStore = useAgentStore()
const postStore = usePostStore()

const {
  activeSession,
  sessions,
  isPanelOpen,
  isCurrentSessionRunning,
  isWaitingPermission,
  selectedAgent,
  currentActivityLabel,
} = storeToRefs(agentStore)
const { currentPostId } = storeToRefs(postStore)

const articleSessions = computed(() => filterSessionsForPost(sessions.value, currentPostId.value))

const NEAR_BOTTOM_THRESHOLD_PX = 80

const scrollRef = ref<HTMLElement | null>(null)
const isNearBottom = ref(true)
let savedScrollTop = 0
let scrollRaf = 0
let scrollMeasureRaf = 0

const stabilizeBlocks = createTimelineBlockStabilizer()

const sessionTitle = computed(() => {
  void locale.value
  return activeSession.value?.title || t(`agent.panel.defaultTitle`)
})
const timelineItems = computed<TimelineItem[]>(() => activeSession.value?.items ?? [])
const displayBlocks = computed(() =>
  stabilizeBlocks(activeSession.value?.id, groupTimelineItems(timelineItems.value)),
)

// Show a subtle live activity footer when running and the last block is not already displaying an active spinner.
const showRunningFooter = computed(() => {
  if (!isCurrentSessionRunning.value || isWaitingPermission.value)
    return false
  const last = displayBlocks.value[displayBlocks.value.length - 1]
  if (!last)
    return true
  if (last.kind === `assistant` && last.item.streaming)
    return false
  if (last.kind === `tool_group` && last.hasRunning)
    return false
  if (last.kind === `edit_tool` && (last.item.tool.status === `in_progress` || last.item.tool.status === `pending`))
    return false
  return true
})

function handleTimelineScroll() {
  if (!isPanelOpen.value || scrollMeasureRaf)
    return
  scrollMeasureRaf = requestAnimationFrame(() => {
    scrollMeasureRaf = 0
    const el = scrollRef.value
    if (!el || !isPanelOpen.value)
      return
    isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX
  })
}

function scrollToBottomNow() {
  isNearBottom.value = true
  nextTick(() => {
    const el = scrollRef.value
    if (el)
      el.scrollTo({ top: el.scrollHeight, behavior: `smooth` })
  })
}

function scheduleScrollToBottom() {
  if (!isPanelOpen.value || !isNearBottom.value)
    return
  if (scrollRaf)
    return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const el = scrollRef.value
    if (el && isPanelOpen.value && isNearBottom.value)
      el.scrollTop = el.scrollHeight
  })
}

watch(
  () => activeSession.value?.id ?? null,
  () => {
    isNearBottom.value = true
    savedScrollTop = 0
    if (isPanelOpen.value) {
      nextTick(() => {
        const el = scrollRef.value
        if (el)
          el.scrollTop = el.scrollHeight
      })
    }
  },
)

// Track only active tail changes (length + last item text/thought/status) when the panel is open.
watch(
  () => {
    if (!isPanelOpen.value)
      return null
    const items = timelineItems.value
    const len = items.length
    const last = len > 0 ? items[len - 1] : null
    let tailSig = ``
    if (last?.type === `assistant`)
      tailSig = `${last.text.length}:${last.thought?.length ?? 0}:${last.streaming ? 1 : 0}`
    else if (last?.type === `tool_call`)
      tailSig = `${last.id}:${last.tool.status}`
    else if (last)
      tailSig = last.id
    return `${len}:${tailSig}:${isCurrentSessionRunning.value ? 1 : 0}`
  },
  (sig) => {
    if (sig !== null)
      scheduleScrollToBottom()
  },
)

watch(isPanelOpen, (open) => {
  if (!open) {
    if (scrollRef.value)
      savedScrollTop = scrollRef.value.scrollTop
    if (scrollRaf) {
      cancelAnimationFrame(scrollRaf)
      scrollRaf = 0
    }
    if (scrollMeasureRaf) {
      cancelAnimationFrame(scrollMeasureRaf)
      scrollMeasureRaf = 0
    }
    return
  }
  nextTick(() => {
    const el = scrollRef.value
    if (!el)
      return
    el.scrollTop = isNearBottom.value ? el.scrollHeight : savedScrollTop
  })
})

onUnmounted(() => {
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf)
    scrollRaf = 0
  }
  if (scrollMeasureRaf) {
    cancelAnimationFrame(scrollMeasureRaf)
    scrollMeasureRaf = 0
  }
})

function onSend(payload: { text: string, attachments: string[] }) {
  isNearBottom.value = true
  void agentStore.sendPrompt(payload.text, payload.attachments)
}

function onRespondPermission(requestId: string, decision: AcpPermissionDecision) {
  void agentStore.respondPermission(requestId, decision)
}
</script>

<template>
  <aside
    data-testid="agent-panel"
    class="relative flex h-full w-full flex-col overflow-hidden"
    style="background-color: var(--dt-surface)"
  >
    <!-- Header (48px, Cursor-style restrained chrome) -->
    <header
      class="desktop-drag-region flex h-[48px] shrink-0 items-center justify-between gap-2 pl-4 pr-2.5"
      style="border-bottom: 1px solid var(--dt-line)"
    >
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <AgentAvatar
          v-if="selectedAgent"
          :avatar="selectedAgent.avatar"
          :size="18"
        />
        <span
          class="min-w-0 flex-1 truncate text-[13px] font-semibold"
          style="color: var(--dt-ink)"
        >
          {{ sessionTitle }}
        </span>
      </div>

      <div class="desktop-no-drag flex shrink-0 items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              :title="t('agent.panel.history')"
              :aria-label="t('agent.panel.history')"
              class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--dt-subtle)]"
              style="color: var(--dt-ink3)"
            >
              <History class="size-[15px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-h-72 w-64 overflow-y-auto">
            <DropdownMenuItem v-if="articleSessions.length === 0" disabled class="text-xs">
              {{ t('agent.panel.noHistory') }}
            </DropdownMenuItem>
            <DropdownMenuItem
              v-for="s in articleSessions"
              :key="s.id"
              class="flex cursor-pointer items-center justify-between gap-2"
              @click="agentStore.switchSession(s.id)"
            >
              <span class="min-w-0 flex-1 truncate text-xs">{{ s.title }}</span>
              <button
                type="button"
                class="inline-flex size-5 shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100"
                :aria-label="t('agent.panel.deleteSession')"
                @click.stop="agentStore.deleteSession(s.id)"
              >
                <Trash2 class="size-3" />
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          :title="t('agent.panel.newSession')"
          :aria-label="t('agent.panel.newSession')"
          class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--dt-subtle)]"
          style="color: var(--dt-ink3)"
          @click="agentStore.startNewSession()"
        >
          <Plus class="size-[15px]" />
        </button>

        <button
          type="button"
          data-testid="agent-panel-collapse"
          :title="t('agent.panel.collapsePanel')"
          :aria-label="t('agent.panel.collapsePanel')"
          class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--dt-subtle)]"
          style="color: var(--dt-ink3)"
          @click="agentStore.setPanelOpen(false)"
        >
          <PanelRightClose class="size-[15px]" />
        </button>
      </div>
    </header>

    <!-- Messages timeline (skips DOM/reactive work entirely while collapsed) -->
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div
        ref="scrollRef"
        class="agent-timeline-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6 pt-3.5"
        @scroll.passive="handleTimelineScroll"
      >
        <template v-if="isPanelOpen">
          <div
            v-if="displayBlocks.length === 0"
            class="my-auto flex flex-col items-center gap-2 px-4 text-center"
          >
            <p class="text-[14px] font-semibold" style="color: var(--dt-ink)">
              {{ t('agent.panel.emptyTitle') }}
            </p>
            <p class="text-[12.5px] leading-relaxed" style="color: var(--dt-ink3)">
              {{ t('agent.panel.emptyHint') }}
            </p>
          </div>

          <AgentTimelineItem
            v-for="block in displayBlocks"
            :key="`${activeSession?.id ?? ''}:${block.id}`"
            v-memo="[block, activeSession?.acpSessionId, locale]"
            :block="block"
            :acp-session-id="activeSession?.acpSessionId"
            @respond-permission="onRespondPermission"
          />

          <div
            v-if="showRunningFooter"
            class="flex items-center gap-2 py-1 text-[12px]"
          >
            <LoaderCircle class="size-3.5 shrink-0 animate-spin" style="color: var(--dt-accent)" />
            <span class="agent-thinking-shimmer truncate font-medium">{{ currentActivityLabel }}</span>
          </div>
        </template>
      </div>

      <!-- Subtle bottom fade so scrolled content melts cleanly into the composer -->
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-5"
        style="background: linear-gradient(to bottom, transparent, var(--dt-surface))"
      />

      <!-- Floating scroll-to-bottom button -->
      <button
        v-if="!isNearBottom && displayBlocks.length > 0"
        type="button"
        :title="t('agent.chat.scrollToBottom')"
        :aria-label="t('agent.chat.scrollToBottom')"
        class="absolute bottom-3 left-1/2 z-10 inline-flex h-7 -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium transition-opacity hover:opacity-95"
        style="
          background-color: var(--dt-surface);
          color: var(--dt-ink2);
          border: 1px solid var(--dt-line);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.1);
        "
        @click="scrollToBottomNow"
      >
        <ArrowDown class="size-3.5" />
      </button>
    </div>

    <!-- Bottom Composer -->
    <div class="shrink-0 px-3.5 pb-3.5 pt-1.5">
      <AgentComposer
        :running="isCurrentSessionRunning"
        :disabled="isWaitingPermission"
        :placeholder="isWaitingPermission ? t('agent.composer.waitingPlaceholder') : t('agent.composer.placeholder')"
        menu-placement="up"
        size="panel"
        @send="onSend"
        @stop="agentStore.stopTurn()"
      />
    </div>
  </aside>
</template>
