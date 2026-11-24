<script setup lang="ts">
import type { PendingArticleEdit } from '@/stores/agent'
import { ChevronLeft, ChevronRight } from '@lucide/vue'

const props = defineProps<{
  edit: PendingArticleEdit
}>()

const emit = defineEmits<{
  keep: []
  undo: []
  keepAll: []
  undoAll: []
  selectHunk: [index: number]
}>()

const { t } = useI18n()

const currentHunk = computed(() => props.edit.hunks[props.edit.activeHunkIndex] ?? props.edit.hunks[0])
const totalHunks = computed(() => props.edit.hunks.length)
</script>

<template>
  <div
    v-if="currentHunk"
    class="mx-auto my-3 w-full max-w-[780px] overflow-hidden rounded-[10px]"
    style="
      background-color: var(--dt-surface);
      border: 1px solid var(--dt-line);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.06);
    "
  >
    <div class="max-h-[300px] overflow-y-auto py-2">
      <div
        v-for="(line, idx) in currentHunk.lines"
        :key="idx"
        class="flex items-start gap-2.5 px-3.5 py-0.5"
        :style="{
          backgroundColor: line.kind === 'add'
            ? 'var(--dt-green-soft)'
            : line.kind === 'remove'
              ? 'var(--dt-red-soft)'
              : 'transparent',
        }"
      >
        <span
          class="w-2.5 shrink-0 select-none text-[12.5px] leading-[22px]"
          :style="{
            fontFamily: 'var(--dt-mono)',
            color: line.kind === 'add'
              ? 'var(--dt-green)'
              : line.kind === 'remove'
                ? 'var(--dt-red)'
                : 'transparent',
          }"
        >
          {{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ' }}
        </span>
        <span
          class="min-w-0 flex-1 whitespace-pre-wrap break-words leading-[22px]"
          :class="[
            line.mono ? 'text-[12.5px]' : 'text-[14px]',
            line.kind === 'remove' ? 'line-through' : '',
          ]"
          :style="{
            fontFamily: line.mono ? 'var(--dt-mono)' : 'inherit',
            color: line.kind === 'remove' ? 'var(--dt-ink3)' : 'var(--dt-ink)',
          }"
        >{{ line.text || ' ' }}</span>
      </div>
    </div>

    <div
      class="flex h-11 items-center gap-2 px-3"
      style="border-top: 1px solid var(--dt-line)"
    >
      <div class="flex min-w-0 flex-1 items-center gap-1.5 text-xs" style="color: var(--dt-ink3)">
        <span>
          {{ t('agent.diff.counter', { current: edit.activeHunkIndex + 1, total: totalHunks }) }}
        </span>
        <template v-if="totalHunks > 1">
          <button
            type="button"
            class="inline-flex size-5 cursor-pointer items-center justify-center rounded hover:opacity-80 disabled:opacity-30"
            :disabled="edit.activeHunkIndex <= 0"
            :aria-label="t('agent.diff.prevHunk')"
            @click="emit('selectHunk', edit.activeHunkIndex - 1)"
          >
            <ChevronLeft class="size-3.5" />
          </button>
          <button
            type="button"
            class="inline-flex size-5 cursor-pointer items-center justify-center rounded hover:opacity-80 disabled:opacity-30"
            :disabled="edit.activeHunkIndex >= totalHunks - 1"
            :aria-label="t('agent.diff.nextHunk')"
            @click="emit('selectHunk', edit.activeHunkIndex + 1)"
          >
            <ChevronRight class="size-3.5" />
          </button>
        </template>
      </div>

      <button
        v-if="totalHunks > 1"
        type="button"
        class="inline-flex h-7 cursor-pointer items-center rounded-lg px-2 text-xs font-medium transition-opacity hover:opacity-80"
        style="color: var(--dt-ink3)"
        @click="emit('undoAll')"
      >
        {{ t('agent.diff.undoAll') }}
      </button>

      <button
        type="button"
        class="inline-flex h-7 cursor-pointer items-center justify-center rounded-lg px-3 text-xs font-semibold transition-opacity hover:opacity-85"
        style="
          background-color: var(--dt-surface);
          color: var(--dt-ink);
          border: 1px solid var(--dt-line);
        "
        @click="emit('undo')"
      >
        {{ t('agent.diff.undo') }}
      </button>

      <button
        type="button"
        class="inline-flex h-7 cursor-pointer items-center justify-center rounded-lg px-3 text-xs font-semibold transition-opacity hover:opacity-90"
        style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
        @click="emit('keep')"
      >
        {{ t('agent.diff.keep') }}
      </button>

      <button
        v-if="totalHunks > 1"
        type="button"
        class="inline-flex h-7 cursor-pointer items-center rounded-lg px-2 text-xs font-medium transition-opacity hover:opacity-80"
        style="color: var(--dt-accent)"
        @click="emit('keepAll')"
      >
        {{ t('agent.diff.keepAll') }}
      </button>
    </div>
  </div>
</template>
