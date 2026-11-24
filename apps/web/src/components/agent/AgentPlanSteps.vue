<script setup lang="ts">
import type { AcpPlanEntry } from '@md/shared/types'
import { Check, Circle, LoaderCircle } from '@lucide/vue'

defineProps<{
  entries: AcpPlanEntry[]
}>()
</script>

<template>
  <div class="flex flex-col gap-0.5">
    <div
      v-for="(entry, idx) in entries"
      :key="`${idx}-${entry.content}`"
      class="flex h-6 items-center gap-2"
    >
      <Check
        v-if="entry.status === 'completed'"
        class="size-3.5 shrink-0"
        style="color: var(--dt-ink3)"
      />
      <LoaderCircle
        v-else-if="entry.status === 'in_progress'"
        class="size-3.5 shrink-0 animate-spin"
        style="color: var(--dt-accent)"
      />
      <Circle
        v-else
        class="size-[13px] shrink-0"
        style="color: var(--dt-line)"
      />
      <span
        class="min-w-0 flex-1 truncate text-[12.5px]"
        :style="{
          color: entry.status === 'in_progress'
            ? 'var(--dt-accent)'
            : entry.status === 'completed'
              ? 'var(--dt-ink2)'
              : 'var(--dt-ink3)',
          fontWeight: entry.status === 'in_progress' ? 500 : 400,
        }"
      >
        {{ entry.content }}
      </span>
    </div>
  </div>
</template>
