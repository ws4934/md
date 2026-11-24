<script setup lang="ts">
import type { AcpThinkingOption } from '@md/shared/types'
import { Brain, Check } from '@lucide/vue'
import { isKnownThinkingLevel } from '@md/shared/utils/acp-thinking'
import { useAgentStore } from '@/stores/agent'

const props = withDefaults(defineProps<{
  placement?: `up` | `down`
  disabled?: boolean
}>(), {
  placement: `up`,
  disabled: false,
})

const { t, locale } = useI18n()
const agentStore = useAgentStore()

const {
  availableThinkingOptions,
  selectedThinkingLevel,
} = storeToRefs(agentStore)

const isOpen = ref(false)
const containerRef = ref<HTMLElement | null>(null)

function formatLevelLabel(option: AcpThinkingOption): string {
  const key = option.id.trim().toLowerCase()
  if (isKnownThinkingLevel(key))
    return t(`agent.thinking.levels.${key}`)
  return option.name || option.id
}

const activeOption = computed<AcpThinkingOption | null>(() => {
  const options = availableThinkingOptions.value
  if (options.length === 0)
    return null
  return options.find(o => o.id === selectedThinkingLevel.value) ?? options[0]
})

const pillLabel = computed(() => {
  void locale.value
  return activeOption.value ? formatLevelLabel(activeOption.value) : ``
})

function toggleMenu() {
  if (props.disabled)
    return
  isOpen.value = !isOpen.value
}

function selectLevel(level: string) {
  isOpen.value = false
  void agentStore.setSessionThinkingLevel(level)
}

onClickOutside(containerRef, () => {
  if (isOpen.value)
    isOpen.value = false
})

onKeyStroke(`Escape`, () => {
  if (isOpen.value)
    isOpen.value = false
})
</script>

<template>
  <div v-if="availableThinkingOptions.length > 1" ref="containerRef" class="relative inline-flex shrink-0">
    <button
      type="button"
      data-testid="thinking-level-pill"
      :disabled="disabled"
      :title="t('agent.thinking.menuTitle')"
      class="inline-flex h-7 cursor-pointer items-center gap-[5px] rounded-lg px-[7px] text-[12.5px] transition-colors disabled:opacity-50"
      :style="{
        backgroundColor: isOpen ? 'var(--dt-subtle)' : 'transparent',
        color: 'var(--dt-ink2)',
      }"
      @click="toggleMenu"
    >
      <Brain class="size-3.5 shrink-0" />
      <span class="max-w-[64px] truncate">{{ pillLabel }}</span>
    </button>

    <div
      v-if="isOpen"
      data-testid="thinking-level-menu"
      class="absolute z-40 flex w-[208px] flex-col gap-0.5 rounded-xl p-1.5"
      :class="placement === 'up' ? 'bottom-full mb-2 right-[-76px]' : 'top-full mt-2 left-0'"
      style="
        background-color: var(--dt-surface);
        border: 1px solid var(--dt-line);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
      "
    >
      <div class="px-2.5 pb-1.5 pt-1 text-[11.5px] font-semibold" style="color: var(--dt-ink3)">
        {{ t('agent.thinking.menuTitle') }}
      </div>

      <button
        v-for="opt in availableThinkingOptions"
        :key="opt.id"
        type="button"
        :data-testid="`thinking-option-${opt.id}`"
        class="flex min-h-[36px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors"
        :style="{
          backgroundColor: selectedThinkingLevel === opt.id ? 'var(--dt-subtle)' : 'transparent',
        }"
        @click="selectLevel(opt.id)"
      >
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13px] font-medium" style="color: var(--dt-ink)">
            {{ formatLevelLabel(opt) }}
          </div>
          <div v-if="opt.description" class="truncate text-[11.5px]" style="color: var(--dt-ink3)">
            {{ opt.description }}
          </div>
        </div>
        <Check
          v-if="selectedThinkingLevel === opt.id"
          class="size-[15px] shrink-0"
          style="color: var(--dt-ink)"
        />
      </button>
    </div>
  </div>
</template>
