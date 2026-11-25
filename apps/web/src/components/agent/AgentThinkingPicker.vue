<script setup lang="ts">
import type { AcpThinkingOption } from '@md/shared/types'
import type { CSSProperties } from 'vue'
import { Brain, Check } from '@lucide/vue'
import { formatThinkingFallbackLabel, isKnownThinkingLevel } from '@md/shared/utils/acp-thinking'
import { useFloatingMenu } from '@/composables/useFloatingMenu'
import { computeFloatingMenuPosition } from '@/lib/agent/floating-menu'
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

const isOpen = ref(false)
const triggerRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const menuStyle = ref<CSSProperties>({})

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

function updateMenuPosition() {
  const trigger = triggerRef.value
  if (!trigger)
    return
  const anchor = trigger.getBoundingClientRect()
  const rect = menuRef.value?.getBoundingClientRect()
  const pos = computeFloatingMenuPosition({
    anchor,
    menu: {
      width: rect?.width || MENU_WIDTH,
      height: rect?.height || availableThinkingOptions.value.length * 40 + 42,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    preferredSide: props.placement === `up` ? `top` : `bottom`,
    preferredAlign: `start`,
  })
  menuStyle.value = {
    left: `${pos.left}px`,
    top: `${pos.top}px`,
    maxHeight: `${pos.maxHeight}px`,
    maxWidth: `${pos.maxWidth}px`,
  }
}

function closeMenu() {
  isOpen.value = false
}

function toggleMenu() {
  if (props.disabled)
    return
  if (isOpen.value) {
    closeMenu()
    return
  }
  updateMenuPosition()
  isOpen.value = true
}

function selectLevel(level: string) {
  closeMenu()
  void agentStore.setSessionThinkingLevel(level)
}

useFloatingMenu({
  isOpen,
  triggerRef,
  menuRefs: [menuRef],
  onReposition: updateMenuPosition,
  onClose: closeMenu,
})
</script>

<template>
  <div v-if="availableThinkingOptions.length > 1" class="relative inline-flex shrink-0">
    <button
      ref="triggerRef"
      type="button"
      data-testid="thinking-level-pill"
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
        data-testid="thinking-level-menu"
        class="fixed z-[120] flex w-[208px] flex-col gap-0.5 overflow-y-auto rounded-xl p-1.5"
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
    </Teleport>
  </div>
</template>
