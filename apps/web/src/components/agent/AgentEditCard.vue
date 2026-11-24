<script setup lang="ts">
import type { AcpToolCallItem } from '@md/shared/types'
import { Check, ChevronDown, ChevronRight, FileDiff, LoaderCircle, X } from '@lucide/vue'
import { buildUnifiedDiff, formatShortFilePath } from '@/lib/agent/unified-diff'

const props = defineProps<{
  tool: AcpToolCallItem
}>()

const expanded = ref(false)

const diff = computed(() =>
  buildUnifiedDiff({
    oldText: props.tool.oldText,
    newText: props.tool.newText,
    unifiedDiff: props.tool.unifiedDiff,
  }),
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
      :disabled="!diff.hasChanges"
      @click="diff.hasChanges && (expanded = !expanded)"
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

      <FileDiff class="size-3.5 shrink-0" style="color: var(--dt-ink3)" />

      <span
        class="min-w-0 flex-1 truncate font-medium"
        style="color: var(--dt-ink); font-family: var(--dt-mono)"
        :title="tool.filePath || tool.title"
      >
        {{ displayPath }}
      </span>

      <span v-if="diff.hasChanges" class="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium" style="font-family: var(--dt-mono)">
        <span v-if="diff.added > 0" style="color: var(--dt-green)">+{{ diff.added }}</span>
        <span v-if="diff.removed > 0" style="color: var(--dt-red)">−{{ diff.removed }}</span>
      </span>

      <component
        :is="expanded ? ChevronDown : ChevronRight"
        v-if="diff.hasChanges"
        class="size-3.5 shrink-0"
        style="color: var(--dt-ink3)"
      />
    </button>

    <div
      v-if="expanded && diff.hasChanges"
      class="max-h-[240px] overflow-auto py-1.5 text-[11.5px] leading-[19px]"
      style="
        background-color: var(--dt-surface);
        border-top: 1px solid var(--dt-line);
        font-family: var(--dt-mono);
      "
    >
      <div
        v-for="(line, idx) in diff.lines"
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
