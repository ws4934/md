<script setup lang="ts">
import type { UnifiedDiffLine } from '@/lib/agent/unified-diff'

defineProps<{
  lines: UnifiedDiffLine[]
  maxHeightClass?: string
}>()
</script>

<template>
  <div
    class="overflow-auto py-1 text-[11.5px] leading-[19px]"
    :class="maxHeightClass ?? 'max-h-[240px]'"
    style="font-family: var(--dt-mono)"
  >
    <div
      v-for="(line, idx) in lines"
      :key="idx"
      class="agent-diff-row flex items-start gap-2 px-2.5 py-px"
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
</template>

<style scoped>
.agent-diff-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 20px;
}
</style>
