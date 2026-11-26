<script setup lang="ts">
import type { AcpPermissionDecision } from '@md/shared/types'
import type { TimelineDisplayBlock } from '@/lib/agent/timeline-blocks'
import { Check, Copy, Paperclip } from '@lucide/vue'
import { cleanDisplayPath } from '@/lib/agent/timeline-blocks'
import { copyPlain } from '@/lib/browser/clipboard'
import AgentEditCard from './AgentEditCard.vue'
import AgentErrorGroup from './AgentErrorGroup.vue'
import AgentMarkdown from './AgentMarkdown.vue'
import AgentPermissionCard from './AgentPermissionCard.vue'
import AgentPlanSteps from './AgentPlanSteps.vue'
import AgentThinkingBlock from './AgentThinkingBlock.vue'
import AgentToolGroup from './AgentToolGroup.vue'

const props = defineProps<{
  block: TimelineDisplayBlock
  acpSessionId?: string | null
}>()

const emit = defineEmits<{
  respondPermission: [requestId: string, decision: AcpPermissionDecision]
}>()

const { t } = useI18n()
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

function onRespondPermission(decision: AcpPermissionDecision) {
  if (props.block.kind === `permission`)
    emit(`respondPermission`, props.block.item.request.requestId, decision)
}

async function copyText(value: string) {
  if (!value)
    return
  try {
    await copyPlain(value)
    copied.value = true
    if (copyTimer)
      clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 1500)
  }
  catch {
    // Ignore clipboard errors.
  }
}

onBeforeUnmount(() => {
  if (copyTimer)
    clearTimeout(copyTimer)
})
</script>

<template>
  <!-- Cursor-style full-width subtle user prompt card -->
  <div
    v-if="block.kind === 'user'"
    class="group relative flex w-full flex-col gap-1.5"
    :class="block.isTurnStart ? 'mt-3' : ''"
  >
    <div
      class="relative w-full whitespace-pre-wrap break-words rounded-[11px] px-3 py-2.5 text-[13.5px] leading-[21px]"
      style="
        background-color: var(--dt-canvas);
        border: 1px solid var(--dt-line);
        color: var(--dt-ink);
      "
    >
      <div class="pr-6">
        {{ block.item.text }}
      </div>

      <button
        type="button"
        :title="copied ? t('agent.chat.copied') : t('agent.chat.copy')"
        :aria-label="copied ? t('agent.chat.copied') : t('agent.chat.copy')"
        class="absolute right-2 top-2 inline-flex size-6 cursor-pointer items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        :class="copied ? '!opacity-100' : ''"
        style="color: var(--dt-ink3); background-color: var(--dt-canvas)"
        @click="copyText(block.item.text)"
      >
        <Check v-if="copied" class="size-3.5" style="color: var(--dt-green)" />
        <Copy v-else class="size-3.5" />
      </button>

      <div v-if="block.item.attachments?.length" class="mt-2 flex flex-wrap gap-1">
        <span
          v-for="file in block.item.attachments"
          :key="file"
          class="inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]"
          style="
            background-color: var(--dt-subtle);
            color: var(--dt-ink2);
            font-family: var(--dt-mono);
          "
          :title="file"
        >
          <Paperclip class="size-2.5 shrink-0 opacity-70" />
          <span class="truncate">{{ cleanDisplayPath(file) }}</span>
        </span>
      </div>
    </div>
  </div>

  <!-- Assistant turn: collapsible thinking + rendered Markdown + subtle copy action -->
  <div
    v-else-if="block.kind === 'assistant'"
    class="group flex w-full flex-col gap-2"
  >
    <AgentThinkingBlock
      v-if="block.item.thought || (!block.item.text && block.item.streaming)"
      :thought="block.item.thought"
      :streaming="block.item.streaming"
      :has-output-text="Boolean(block.item.text)"
      :duration-ms="block.item.thoughtDurationMs"
    />

    <AgentMarkdown
      v-if="block.item.text"
      :content="block.item.text"
      :streaming="block.item.streaming"
    />

    <div
      v-if="block.item.text && !block.item.streaming"
      class="flex items-center gap-1 pt-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
      :class="copied ? '!opacity-100' : ''"
    >
      <button
        type="button"
        :title="copied ? t('agent.chat.copied') : t('agent.chat.copy')"
        :aria-label="copied ? t('agent.chat.copied') : t('agent.chat.copy')"
        class="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11.5px] transition-colors hover:bg-[var(--dt-subtle)]"
        style="color: var(--dt-ink3)"
        @click="copyText(block.item.text)"
      >
        <Check v-if="copied" class="size-3" style="color: var(--dt-green)" />
        <Copy v-else class="size-3" />
        <span>{{ copied ? t('agent.chat.copied') : t('agent.chat.copy') }}</span>
      </button>
    </div>
  </div>

  <!-- Plan checklist -->
  <AgentPlanSteps v-else-if="block.kind === 'plan'" :entries="block.item.entries" />

  <!-- Edit / delete / move tool call card -->
  <AgentEditCard
    v-else-if="block.kind === 'edit_tool'"
    :tool="block.item.tool"
  />

  <!-- Collapsible Cursor-style tool execution group -->
  <AgentToolGroup
    v-else-if="block.kind === 'tool_group'"
    :items="block.items"
    :has-running="block.hasRunning"
    :has-failed="block.hasFailed"
    :failed-count="block.failedCount"
    :followed-by-content="block.followedByContent"
    :acp-session-id="acpSessionId"
  />

  <!-- Inline permission card -->
  <AgentPermissionCard
    v-else-if="block.kind === 'permission'"
    :request="block.item.request"
    :resolved-outcome="block.item.resolvedOutcome"
    @respond="onRespondPermission"
  />

  <!-- Grouped / deduplicated error card -->
  <AgentErrorGroup
    v-else-if="block.kind === 'error_group'"
    :items="block.items"
  />
</template>
