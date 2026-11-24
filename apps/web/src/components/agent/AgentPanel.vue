<script setup lang="ts">
import type { AcpPermissionDecision } from '@md/shared/types'
import type { AgentTimelineItem as TimelineItem } from '@/stores/agent'
import { History, PanelRightClose, Plus, Trash2 } from '@lucide/vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAgentStore } from '@/stores/agent'
import AgentComposer from './AgentComposer.vue'
import AgentTimelineItem from './AgentTimelineItem.vue'

const { t } = useI18n()
const agentStore = useAgentStore()

const {
  activeSession,
  sessions,
  isPanelOpen,
  isCurrentSessionRunning,
  isWaitingPermission,
} = storeToRefs(agentStore)

const NEAR_BOTTOM_THRESHOLD_PX = 80

const scrollRef = ref<HTMLElement | null>(null)
const isNearBottom = ref(true)
let savedScrollTop = 0
let scrollRaf = 0

const sessionTitle = computed(() => activeSession.value?.title || t(`agent.panel.defaultTitle`))
const timelineItems = computed<TimelineItem[]>(() => activeSession.value?.items ?? [])

function handleTimelineScroll() {
  const el = scrollRef.value
  if (!el || !isPanelOpen.value)
    return
  isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX
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

// Track only active tail changes (length + last item text) when the panel is open.
watch(
  () => {
    if (!isPanelOpen.value)
      return null
    const items = timelineItems.value
    const len = items.length
    const last = len > 0 ? items[len - 1] : null
    const tailSig = last?.type === `assistant` ? last.text.length : (last?.id ?? ``)
    return `${len}:${tailSig}`
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
    class="flex h-full w-full flex-col overflow-hidden"
    style="background-color: var(--dt-surface)"
  >
    <!-- Header (52px) -->
    <header
      class="desktop-drag-region flex h-[52px] shrink-0 items-center justify-between pl-5 pr-3"
    >
      <span
        class="min-w-0 flex-1 truncate text-[13px] font-semibold"
        style="color: var(--dt-ink)"
      >
        {{ sessionTitle }}
      </span>

      <div class="desktop-no-drag flex shrink-0 items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              :title="t('agent.panel.history')"
              :aria-label="t('agent.panel.history')"
              class="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg transition-colors hover:opacity-80"
              style="color: var(--dt-ink3)"
            >
              <History class="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-h-72 w-64 overflow-y-auto">
            <DropdownMenuItem v-if="sessions.length === 0" disabled class="text-xs">
              {{ t('agent.panel.noHistory') }}
            </DropdownMenuItem>
            <DropdownMenuItem
              v-for="s in sessions"
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
          class="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg transition-colors hover:opacity-80"
          style="color: var(--dt-ink3)"
          @click="agentStore.startNewSession()"
        >
          <Plus class="size-4" />
        </button>

        <button
          type="button"
          data-testid="agent-panel-collapse"
          :title="t('agent.panel.collapsePanel')"
          :aria-label="t('agent.panel.collapsePanel')"
          class="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg transition-colors hover:opacity-80"
          style="color: var(--dt-ink3)"
          @click="agentStore.setPanelOpen(false)"
        >
          <PanelRightClose class="size-4" />
        </button>
      </div>
    </header>

    <!-- Messages timeline (skips DOM/reactive work entirely while collapsed) -->
    <div
      ref="scrollRef"
      class="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-5 pb-4 pt-2"
      @scroll.passive="handleTimelineScroll"
    >
      <template v-if="isPanelOpen">
        <div
          v-if="timelineItems.length === 0"
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
          v-for="item in timelineItems"
          :key="item.id"
          :item="item"
          @respond-permission="onRespondPermission"
        />
      </template>
    </div>

    <!-- Bottom Composer -->
    <div class="shrink-0 px-4 pb-4 pt-2">
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
