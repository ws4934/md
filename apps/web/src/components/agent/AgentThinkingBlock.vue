<script setup lang="ts">
import { ChevronDown, ChevronRight } from '@lucide/vue'

const props = defineProps<{
  thought?: string
  streaming?: boolean
  hasOutputText?: boolean
  durationMs?: number
}>()

const { t, locale } = useI18n()

const isActivelyThinking = computed(() => Boolean(props.streaming && !props.hasOutputText))
const userExpanded = ref<boolean | null>(null)
const previewRef = ref<HTMLElement | null>(null)

const isExpanded = computed(() => {
  if (userExpanded.value !== null)
    return userExpanded.value
  return isActivelyThinking.value && Boolean(props.thought?.trim())
})

const hasThoughtContent = computed(() => Boolean(props.thought?.trim()))

const headerLabel = computed(() => {
  void locale.value
  if (isActivelyThinking.value)
    return t(`agent.panel.thinking`)
  const seconds = props.durationMs !== undefined ? Math.max(1, Math.round(props.durationMs / 1000)) : null
  if (seconds !== null)
    return t(`agent.chat.thoughtForSeconds`, { seconds })
  return t(`agent.chat.thoughtProcess`)
})

watch(
  () => props.thought?.length ?? 0,
  () => {
    if (!isActivelyThinking.value || !isExpanded.value)
      return
    nextTick(() => {
      const el = previewRef.value
      if (el)
        el.scrollTop = el.scrollHeight
    })
  },
)

function toggle() {
  if (!hasThoughtContent.value)
    return
  userExpanded.value = !isExpanded.value
}
</script>

<template>
  <div class="flex w-full flex-col gap-1" data-testid="agent-thinking-block">
    <button
      type="button"
      class="group inline-flex max-w-full items-center gap-1.5 self-start rounded-md py-0.5 text-left text-[12px] transition-colors"
      :class="hasThoughtContent ? 'cursor-pointer hover:opacity-85' : 'cursor-default'"
      :aria-expanded="hasThoughtContent ? isExpanded : undefined"
      @click="toggle"
    >
      <span
        v-if="isActivelyThinking"
        class="agent-thinking-shimmer font-medium"
      >
        {{ headerLabel }}
      </span>
      <span
        v-else
        class="font-medium"
        style="color: var(--dt-ink3)"
      >
        {{ headerLabel }}
      </span>

      <component
        :is="isExpanded ? ChevronDown : ChevronRight"
        v-if="hasThoughtContent"
        class="size-3.5 shrink-0 transition-opacity"
        :class="isExpanded ? 'opacity-80' : 'opacity-60 group-hover:opacity-100'"
        style="color: var(--dt-ink3)"
      />
    </button>

    <div
      v-if="hasThoughtContent && isExpanded"
      ref="previewRef"
      class="ml-1 overflow-y-auto whitespace-pre-wrap break-words pl-3 text-[12px] leading-[19px]"
      :class="isActivelyThinking ? 'max-h-[96px]' : 'max-h-[260px]'"
      style="
        border-left: 1.5px solid var(--dt-line);
        color: var(--dt-ink2);
      "
    >
      {{ thought }}
    </div>
  </div>
</template>
