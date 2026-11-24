<script setup lang="ts">
import type { AcpPermissionDecision } from '@md/shared/types'
import type { AgentTimelineItem } from '@/stores/agent'
import { AlertCircle, Check, History, LoaderCircle, Plus, Trash2, X } from '@lucide/vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAgentStore } from '@/stores/agent'
import AgentComposer from './AgentComposer.vue'
import AgentEditCard from './AgentEditCard.vue'
import AgentPermissionCard from './AgentPermissionCard.vue'
import AgentPlanSteps from './AgentPlanSteps.vue'

const { t } = useI18n()
const agentStore = useAgentStore()

const {
  activeSession,
  sessions,
  isCurrentSessionRunning,
  isWaitingPermission,
} = storeToRefs(agentStore)

const scrollRef = ref<HTMLElement | null>(null)

const sessionTitle = computed(() => activeSession.value?.title || t(`agent.panel.defaultTitle`))
const timelineItems = computed<AgentTimelineItem[]>(() => activeSession.value?.items ?? [])

/**
 * Splits plain text into regular spans and `inline code` spans so messages
 * like `initialize → session/prompt` render with the accent mono style from the design.
 */
function parseInlineSpans(text: string): Array<{ code: boolean, text: string }> {
  const parts: Array<{ code: boolean, text: string }> = []
  const regex = /`([^`\n]+)`/g
  let lastIndex = 0
  let match: RegExpExecArray | null = regex.exec(text)
  while (match !== null) {
    if (match.index > lastIndex)
      parts.push({ code: false, text: text.slice(lastIndex, match.index) })
    parts.push({ code: true, text: match[1] })
    lastIndex = match.index + match[0].length
    match = regex.exec(text)
  }
  if (lastIndex < text.length)
    parts.push({ code: false, text: text.slice(lastIndex) })
  return parts.length > 0 ? parts : [{ code: false, text }]
}

function scrollToBottom() {
  nextTick(() => {
    const el = scrollRef.value
    if (el)
      el.scrollTop = el.scrollHeight
  })
}

watch(
  () => timelineItems.value.map(i => (i.type === `assistant` ? i.text.length : i.id)).join(`,`),
  () => scrollToBottom(),
)

function onSend(payload: { text: string, attachments: string[] }) {
  void agentStore.sendPrompt(payload.text, payload.attachments)
}

function onRespondPermission(requestId: string, decision: AcpPermissionDecision) {
  void agentStore.respondPermission(requestId, decision)
}
</script>

<template>
  <aside
    class="flex h-full w-[400px] shrink-0 flex-col"
    style="
      background-color: var(--dt-surface);
      border-left: 1px solid var(--dt-line);
    "
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
      </div>
    </header>

    <!-- Messages timeline -->
    <div
      ref="scrollRef"
      class="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-5 pb-4 pt-2"
    >
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

      <template v-for="item in timelineItems" :key="item.id">
        <!-- User bubble -->
        <div v-if="item.type === 'user'" class="flex w-full flex-col items-end gap-1">
          <div
            class="max-w-[300px] whitespace-pre-wrap break-words rounded-[14px] px-3.5 py-2.5 text-[13.5px] leading-[22px]"
            style="background-color: var(--dt-subtle); color: var(--dt-ink)"
          >
            {{ item.text }}
          </div>
          <div v-if="item.attachments?.length" class="flex flex-wrap justify-end gap-1">
            <span
              v-for="file in item.attachments"
              :key="file"
              class="rounded px-1.5 py-0.5 text-[11px]"
              style="background-color: var(--dt-canvas); color: var(--dt-ink3)"
            >
              {{ file.split(/[\\/]/).pop() }}
            </span>
          </div>
        </div>

        <!-- Assistant text -->
        <div
          v-else-if="item.type === 'assistant'"
          class="w-full whitespace-pre-wrap break-words text-[13.5px] leading-[23px]"
          style="color: var(--dt-ink)"
        >
          <p v-if="!item.text && item.streaming" class="text-xs italic" style="color: var(--dt-ink3)">
            {{ t('agent.panel.thinking') }}
          </p>
          <template v-else>
            <template v-for="(span, si) in parseInlineSpans(item.text)" :key="si">
              <code
                v-if="span.code"
                class="text-[12.5px]"
                style="font-family: var(--dt-mono); color: var(--dt-accent)"
              >{{ span.text }}</code>
              <span v-else>{{ span.text }}</span>
            </template>
          </template>
        </div>

        <!-- Plan checklist -->
        <AgentPlanSteps v-else-if="item.type === 'plan'" :entries="item.entries" />

        <!-- Edit / delete / move tool call card -->
        <AgentEditCard
          v-else-if="item.type === 'tool_call' && (item.tool.toolKind === 'edit' || item.tool.toolKind === 'delete' || item.tool.toolKind === 'move')"
          :tool="item.tool"
        />

        <!-- Compact tool call row for other tool kinds -->
        <div
          v-else-if="item.type === 'tool_call'"
          class="flex h-6 items-center gap-2 text-[12.5px]"
        >
          <Check
            v-if="item.tool.status === 'completed'"
            class="size-3.5 shrink-0"
            style="color: var(--dt-ink3)"
          />
          <X
            v-else-if="item.tool.status === 'failed'"
            class="size-3.5 shrink-0"
            style="color: var(--dt-red)"
          />
          <LoaderCircle
            v-else
            class="size-3.5 shrink-0 animate-spin"
            style="color: var(--dt-accent)"
          />
          <span
            class="min-w-0 flex-1 truncate"
            :style="{
              color: item.tool.status === 'failed'
                ? 'var(--dt-red)'
                : item.tool.status === 'in_progress'
                  ? 'var(--dt-accent)'
                  : 'var(--dt-ink2)',
            }"
          >
            {{ item.tool.title }}
          </span>
        </div>

        <!-- Inline permission card -->
        <AgentPermissionCard
          v-else-if="item.type === 'permission'"
          :request="item.request"
          :resolved-outcome="item.resolvedOutcome"
          @respond="(decision) => onRespondPermission(item.request.requestId, decision)"
        />

        <!-- Error message -->
        <div
          v-else-if="item.type === 'error'"
          class="flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed"
          style="background-color: var(--dt-red-soft); color: var(--dt-red)"
        >
          <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
          <span class="break-words">{{ item.message }}</span>
        </div>
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
