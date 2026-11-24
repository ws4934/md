<script setup lang="ts">
import type { AcpToolCallItem } from '@md/shared/types'
import { Check, ChevronDown, ChevronRight, LoaderCircle, PencilLine, X } from '@lucide/vue'
import { formatShortFilePath, getDiffLines, getDiffStats } from '@/lib/agent/unified-diff'

const props = defineProps<{
  tool: AcpToolCallItem
}>()

const { t } = useI18n()
const expanded = ref(false)

const stats = computed(() =>
  getDiffStats({
    oldText: props.tool.oldText,
    newText: props.tool.newText,
    unifiedDiff: props.tool.unifiedDiff,
    diffStats: props.tool.diffStats,
  }),
)

// Parse diff rows lazily only when the card is actually expanded.
const diffLines = computed(() =>
  expanded.value && stats.value.hasChanges
    ? getDiffLines({
        oldText: props.tool.oldText,
        newText: props.tool.newText,
        unifiedDiff: props.tool.unifiedDiff,
      })
    : [],
)

const displayPath = computed(() =>
  formatShortFilePath(props.tool.filePath, props.tool.title),
)
</script>

<template>
  <div
    class="w-full overflow-hidden rounded-[10px]"
    style="
      background-color: var(--dt-canvas);
      border: 1px solid var(--dt-line);
    "
  >
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left text-[12.5px] transition-opacity hover:opacity-85"
      :disabled="!stats.hasChanges"
      @click="stats.hasChanges && (expanded = !expanded)"
    >
      <Check
        v-if="tool.status === 'completed'"
        class="size-3.5 shrink-0"
        style="color: var(--dt-green)"
      />
      <X
        v-else-if="tool.status === 'failed'"
        class="size-3.5 shrink-0"
        style="color: var(--dt-red)"
      />
      <LoaderCircle
        v-else
        class="size-3.5 shrink-0 animate-spin"
        style="color: var(--dt-accent)"
      />

      <PencilLine class="size-3.5 shrink-0" style="color: var(--dt-ink3)" />

      <span class="shrink-0 text-[12.5px]" style="color: var(--dt-ink2)">
        {{ t('agent.editCard.label') }}
      </span>

      <span
        class="min-w-0 flex-1 truncate font-medium"
        style="color: var(--dt-ink); font-family: var(--dt-mono)"
        :title="tool.filePath || tool.title"
      >
        {{ displayPath }}
      </span>

      <span v-if="stats.hasChanges" class="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium" style="font-family: var(--dt-mono)">
        <span v-if="stats.added > 0" style="color: var(--dt-green)">+{{ stats.added }}</span>
        <span v-if="stats.removed > 0" style="color: var(--dt-red)">−{{ stats.removed }}</span>
      </span>

      <component
        :is="expanded ? ChevronDown : ChevronRight"
        v-if="stats.hasChanges"
        class="size-3.5 shrink-0"
        style="color: var(--dt-ink3)"
      />
    </button>

    <div
      v-if="expanded && stats.hasChanges"
      class="max-h-[240px] overflow-auto py-1.5 text-[11.5px] leading-[19px]"
      style="
        background-color: var(--dt-surface);
        border-top: 1px solid var(--dt-line);
        font-family: var(--dt-mono);
      "
    >
      <div
        v-for="(line, idx) in diffLines"
        :key="idx"
        class="flex items-start gap-2 px-2.5 py-px"
        :style="{
          backgroundColor: line.kind === 'add'
            ? 'var(--dt-green-soft)'
            : line.kind === 'remove'
              ? 'var(--dt-red-soft)'
              : 'transparent',
        }"
      >
        <span
          class="w-2.5 shrink-0 select-none"
          :style="{
            color: line.kind === 'add'
              ? 'var(--dt-green)'
              : line.kind === 'remove'
                ? 'var(--dt-red)'
                : 'var(--dt-ink3)',
          }"
        >
          {{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : line.kind === 'ellipsis' ? '' : ' ' }}
        </span>
        <span
          class="min-w-0 flex-1 whitespace-pre-wrap break-all"
          :class="line.kind === 'remove' ? 'line-through' : ''"
          :style="{
            color: line.kind === 'remove' || line.kind === 'ellipsis'
              ? 'var(--dt-ink3)'
              : 'var(--dt-ink)',
          }"
        >{{ line.text || ' ' }}</span>
      </div>
    </div>

    <div
      v-if="tool.status === 'failed' && tool.error"
      class="px-2.5 py-1.5 text-[11.5px]"
      style="
        border-top: 1px solid var(--dt-line);
        background-color: var(--dt-red-soft);
        color: var(--dt-red);
      "
    >
      {{ tool.error }}
    </div>
  </div>
</template>
