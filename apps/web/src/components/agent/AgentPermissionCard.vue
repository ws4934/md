<script setup lang="ts">
import type { AcpPermissionDecision, AcpPermissionRequest } from '@md/shared/types'
import { FilePenLine, ShieldAlert, Terminal } from '@lucide/vue'
import { buildUnifiedDiff, formatShortFilePath } from '@/lib/agent/unified-diff'

const props = defineProps<{
  request: AcpPermissionRequest
  resolvedOutcome?: AcpPermissionDecision | `cancelled`
}>()

const emit = defineEmits<{
  respond: [decision: AcpPermissionDecision]
}>()

const { t } = useI18n()

const isEditRequest = computed(() =>
  props.request.toolKind === `edit` || props.request.toolKind === `delete` || props.request.toolKind === `move`,
)

const headingText = computed(() => {
  if (props.request.toolKind === `execute`)
    return t(`agent.permission.titleExecute`)
  if (isEditRequest.value)
    return t(`agent.permission.titleEdit`)
  return props.request.title || t(`agent.permission.titleGeneric`)
})

const iconComp = computed(() => {
  if (props.request.toolKind === `execute`)
    return Terminal
  if (isEditRequest.value)
    return FilePenLine
  return ShieldAlert
})

const diff = computed(() =>
  isEditRequest.value
    ? buildUnifiedDiff({
        oldText: props.request.oldText,
        newText: props.request.newText,
        unifiedDiff: props.request.unifiedDiff,
      })
    : { lines: [], added: 0, removed: 0, hasChanges: false },
)

const shortPath = computed(() => formatShortFilePath(props.request.filePath, props.request.title))
const codeBody = computed(() => props.request.command || props.request.filePath || props.request.detail || props.request.title)

const resolvedLabel = computed(() => {
  switch (props.resolvedOutcome) {
    case `allow_once`:
      return t(`agent.permission.statusAllowed`)
    case `allow_always`:
      return t(`agent.permission.statusAlwaysAllowed`)
    case `reject`:
      return t(`agent.permission.statusRejected`)
    case `cancelled`:
      return t(`agent.permission.statusCancelled`)
    default:
      return ``
  }
})
</script>

<template>
  <div
    class="flex w-full flex-col gap-3 rounded-xl p-3.5"
    style="
      background-color: var(--dt-surface);
      border: 1px solid var(--dt-line);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);
    "
  >
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <component :is="iconComp" class="size-[15px] shrink-0" style="color: var(--dt-amber)" />
        <span class="text-[13px] font-semibold" style="color: var(--dt-ink)">
          {{ headingText }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span
          v-if="diff.hasChanges"
          class="flex shrink-0 items-center gap-1.5 text-xs font-medium"
          style="font-family: var(--dt-mono)"
        >
          <span v-if="diff.added > 0" style="color: var(--dt-green)">+{{ diff.added }}</span>
          <span v-if="diff.removed > 0" style="color: var(--dt-red)">−{{ diff.removed }}</span>
        </span>
        <span
          v-if="resolvedOutcome"
          class="rounded-md px-2 py-0.5 text-[11px] font-medium"
          :style="{
            backgroundColor: resolvedOutcome === 'reject' || resolvedOutcome === 'cancelled'
              ? 'var(--dt-red-soft)'
              : 'var(--dt-green-soft)',
            color: resolvedOutcome === 'reject' || resolvedOutcome === 'cancelled'
              ? 'var(--dt-red)'
              : 'var(--dt-green)',
          }"
        >
          {{ resolvedLabel }}
        </span>
      </div>
    </div>

    <!-- Diff preview for edit/delete/move permissions -->
    <div
      v-if="diff.hasChanges"
      class="overflow-hidden rounded-lg"
      style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
    >
      <div
        class="flex h-7 items-center px-2.5 text-[11.5px]"
        style="border-bottom: 1px solid var(--dt-line); font-family: var(--dt-mono)"
      >
        <span class="min-w-0 flex-1 truncate font-medium" style="color: var(--dt-ink2)" :title="request.filePath">
          {{ shortPath }}
        </span>
      </div>
      <div
        class="max-h-[200px] overflow-auto py-1 text-[11.5px] leading-[19px]"
        style="font-family: var(--dt-mono)"
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
    </div>

    <!-- Command / detail box for non-diff permissions -->
    <div
      v-else
      class="w-full overflow-x-auto rounded-lg px-2.5 py-2 text-xs leading-[19px]"
      style="
        background-color: var(--dt-canvas);
        color: var(--dt-ink2);
        font-family: var(--dt-mono);
      "
    >
      <code class="whitespace-pre-wrap break-all">{{ codeBody }}</code>
    </div>

    <div v-if="!resolvedOutcome" class="flex items-center gap-2">
      <button
        type="button"
        class="inline-flex h-[30px] cursor-pointer items-center justify-center rounded-lg px-3 text-[12.5px] font-semibold transition-opacity hover:opacity-90"
        style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
        @click="emit('respond', 'allow_once')"
      >
        {{ t('agent.permission.allow') }}
      </button>
      <button
        type="button"
        class="inline-flex h-[30px] cursor-pointer items-center justify-center rounded-lg px-3 text-[12.5px] font-semibold transition-colors hover:opacity-85"
        style="
          background-color: var(--dt-surface);
          color: var(--dt-ink);
          border: 1px solid var(--dt-line);
        "
        @click="emit('respond', 'allow_always')"
      >
        {{ t('agent.permission.allowAlways') }}
      </button>
      <span class="flex-1" />
      <button
        type="button"
        class="inline-flex h-[30px] cursor-pointer items-center justify-center rounded-lg px-3 text-[12.5px] font-semibold transition-colors hover:opacity-80"
        style="color: var(--dt-ink2)"
        @click="emit('respond', 'reject')"
      >
        {{ t('agent.permission.reject') }}
      </button>
    </div>
  </div>
</template>
