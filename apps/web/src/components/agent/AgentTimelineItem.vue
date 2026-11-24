<script setup lang="ts">
import type { AcpPermissionDecision } from '@md/shared/types'
import type { AgentTimelineItem } from '@/stores/agent'
import { AlertCircle, Check, LoaderCircle, X } from '@lucide/vue'
import { formatShortFilePath } from '@md/shared/utils/compact-diff'
import AgentEditCard from './AgentEditCard.vue'
import AgentPermissionCard from './AgentPermissionCard.vue'
import AgentPlanSteps from './AgentPlanSteps.vue'

const props = defineProps<{
  item: AgentTimelineItem
}>()

const emit = defineEmits<{
  respondPermission: [requestId: string, decision: AcpPermissionDecision]
}>()

const { t } = useI18n()

function onRespondPermission(decision: AcpPermissionDecision) {
  if (props.item.type === `permission`)
    emit(`respondPermission`, props.item.request.requestId, decision)
}

/**
 * Splits plain text into regular spans and `inline code` spans so messages
 * like `initialize → session/prompt` render with the accent mono style from the design.
 * Memoized per timeline item component so streaming only re-parses the active item.
 */
const assistantSpans = computed<Array<{ code: boolean, text: string }>>(() => {
  if (props.item.type !== `assistant` || !props.item.text)
    return []
  const text = props.item.text
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
})
</script>

<template>
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
        {{ formatShortFilePath(file) }}
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
      <template v-for="(span, si) in assistantSpans" :key="si">
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
    @respond="onRespondPermission"
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
