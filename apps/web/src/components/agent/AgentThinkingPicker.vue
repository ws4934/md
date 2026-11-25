<script setup lang="ts">
import type { AcpThinkingOption } from '@md/shared/types'
import { Brain, Check } from '@lucide/vue'
import { formatThinkingFallbackLabel, isKnownThinkingLevel } from '@md/shared/utils/acp-thinking'
import { useSingleFloatingMenu } from '@/composables/useFloatingMenu'
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

const MENU_WIDTH = 208
const triggerRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

const {
  isOpen,
  menuStyle,
  closeMenu,
  toggleMenu,
} = useSingleFloatingMenu({
  triggerRef,
  menuRef,
  placement: () => props.placement,
  disabled: () => props.disabled,
  closeOnChange: () => agentStore.activeSessionId,
  menuWidth: MENU_WIDTH,
  estimateHeight: () => availableThinkingOptions.value.length * 40 + 42,
})

watch(
  () => availableThinkingOptions.value.length,
  (count) => {
    if (count <= 1 && isOpen.value)
      closeMenu()
  },
)

function formatLevelLabel(option: AcpThinkingOption): string {
  const key = option.id.trim().toLowerCase()
  if (isKnownThinkingLevel(key))
    return t(`agent.thinking.levels.${key}`)
  return formatThinkingFallbackLabel(option)
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

function selectLevel(level: string) {
  closeMenu()
  void agentStore.setSessionThinkingLevel(level)
}
</script>

<template>
  <div v-if="availableThinkingOptions.length > 1" class="relative inline-flex shrink-0">
    <button
      ref="triggerRef"
      type="button"
      data-testid="thinking-level-pill"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      :disabled="disabled"
      :title="`${t('agent.thinking.menuTitle')} · ${pillLabel}`"
      class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-1.5 text-[12.5px] transition-colors disabled:opacity-50"
      :style="{
        backgroundColor: isOpen ? 'var(--dt-subtle)' : 'transparent',
        color: 'var(--dt-ink2)',
      }"
      @click="toggleMenu"
    >
      <Brain class="size-3.5 shrink-0" />
      <span class="max-w-[64px] truncate">{{ pillLabel }}</span>
    </button>

    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="menuRef"
        role="menu"
        data-testid="thinking-level-menu"
        class="fixed z-50 flex w-[208px] flex-col gap-0.5 overflow-y-auto rounded-xl p-1.5"
        :style="{
          ...menuStyle,
          backgroundColor: 'var(--dt-surface)',
          border: '1px solid var(--dt-line)',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06)',
        }"
      >
        <div class="px-2.5 pb-1.5 pt-1 text-[11.5px] font-semibold" style="color: var(--dt-ink3)">
          {{ t('agent.thinking.menuTitle') }}
        </div>

        <button
          v-for="opt in availableThinkingOptions"
          :key="opt.id"
          type="button"
          role="menuitemradio"
          :aria-checked="selectedThinkingLevel === opt.id"
          :data-testid="`thinking-option-${opt.id}`"
          :data-active="selectedThinkingLevel === opt.id ? 'true' : undefined"
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
    </Teleport>
  </div>
</template>
