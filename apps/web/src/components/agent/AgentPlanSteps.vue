<script setup lang="ts">
import type { AcpPlanEntry } from '@md/shared/types'
import { Check, ChevronDown, ChevronRight, Circle, LoaderCircle } from '@lucide/vue'

const props = defineProps<{
  entries: AcpPlanEntry[]
}>()

const { t } = useI18n()
const collapsed = ref(false)

const completedCount = computed(() =>
  props.entries.filter(entry => entry.status === `completed`).length,
)

const totalCount = computed(() => props.entries.length)

const progressPercent = computed(() =>
  totalCount.value > 0 ? Math.round((completedCount.value / totalCount.value) * 100) : 0,
)

const isAllCompleted = computed(() =>
  totalCount.value > 0 && completedCount.value === totalCount.value,
)
</script>

<template>
  <div
    class="flex flex-col gap-1 rounded-[10px] px-3 py-2"
    style="
      background-color: var(--dt-canvas);
      border: 1px solid var(--dt-line);
    "
  >
    <button
      type="button"
      data-testid="plan-steps-toggle"
      :aria-expanded="!collapsed"
      class="flex h-5 w-full cursor-pointer items-center gap-2 rounded-md text-left transition-opacity hover:opacity-85"
      @click="collapsed = !collapsed"
    >
      <component
        :is="collapsed ? ChevronRight : ChevronDown"
        class="size-3.5 shrink-0"
        style="color: var(--dt-ink3)"
      />
      <span class="shrink-0 text-[12px] font-medium" style="color: var(--dt-ink2)">
        {{ t('agent.panel.planProgress', { completed: completedCount, total: totalCount }) }}
      </span>
      <div
        class="h-[3px] max-w-[140px] flex-1 overflow-hidden rounded-full"
        style="background-color: var(--dt-subtle)"
      >
        <div
          class="h-full rounded-full transition-all duration-200"
          :style="{
            width: `${progressPercent}%`,
            backgroundColor: isAllCompleted ? 'var(--dt-green)' : 'var(--dt-accent)',
          }"
        />
      </div>
    </button>

    <div v-if="!collapsed" data-testid="plan-steps-list" class="flex flex-col gap-0.5 pl-1">
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
  </div>
</template>
