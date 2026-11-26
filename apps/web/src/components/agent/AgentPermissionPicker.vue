<script setup lang="ts">
import type { AcpPermissionLevel } from '@md/shared/types'
import { Check, SlidersHorizontal } from '@lucide/vue'
import { useSingleFloatingMenu } from '@/composables/useFloatingMenu'
import { useAcpPermissionOptions } from '@/lib/agent/permission-options'
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
  currentPermissionLevel,
  customExtraModes,
  activeCustomMode,
} = storeToRefs(agentStore)

const MENU_WIDTH = 316
const triggerRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const permissionOptions = useAcpPermissionOptions((key) => {
  void locale.value
  return t(key)
})

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
  estimateHeight: () => (permissionOptions.value.length + customExtraModes.value.length) * 52 + 44,
})

const activeOption = computed(() =>
  permissionOptions.value.find(o => o.id === currentPermissionLevel.value) ?? permissionOptions.value[0],
)

const isDangerActive = computed(() => !activeCustomMode.value && activeOption.value.id === `bypass`)

const pillIcon = computed(() => activeCustomMode.value ? SlidersHorizontal : activeOption.value.icon)
const pillLabel = computed(() => activeCustomMode.value ? activeCustomMode.value.name : activeOption.value.shortLabel)

function selectLevel(level: AcpPermissionLevel) {
  closeMenu()
  void agentStore.setSessionPermissionMode({ permissionLevel: level, modeId: null })
}

function selectCustomMode(modeId: string) {
  closeMenu()
  void agentStore.setSessionPermissionMode({ modeId })
}
</script>

<template>
  <div class="relative inline-flex shrink-0">
    <button
      ref="triggerRef"
      type="button"
      data-testid="permission-mode-pill"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      :disabled="disabled"
      :title="`${t('agent.permissionMode.menuTitle')} · ${pillLabel}`"
      class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-1.5 text-[12.5px] transition-colors disabled:opacity-50"
      :style="{
        backgroundColor: isOpen ? 'var(--dt-subtle)' : 'transparent',
        color: isDangerActive ? 'var(--dt-red)' : 'var(--dt-ink2)',
      }"
      @click="toggleMenu"
    >
      <component :is="pillIcon" class="size-3.5 shrink-0" />
      <span class="max-w-[84px] truncate">{{ pillLabel }}</span>
    </button>

    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="menuRef"
        role="menu"
        data-testid="permission-mode-menu"
        class="fixed z-50 flex w-[316px] flex-col gap-0.5 overflow-y-auto rounded-xl p-1.5"
        :style="{
          ...menuStyle,
          backgroundColor: 'var(--dt-surface)',
          border: '1px solid var(--dt-line)',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06)',
        }"
      >
        <div class="px-2.5 pb-1.5 pt-1 text-[11.5px] font-semibold" style="color: var(--dt-ink3)">
          {{ t('agent.permissionMode.menuTitle') }}
        </div>

        <button
          v-for="opt in permissionOptions"
          :key="opt.id"
          type="button"
          role="menuitemradio"
          :aria-checked="!activeCustomMode && currentPermissionLevel === opt.id"
          :data-testid="`perm-option-${opt.id}`"
          :data-active="!activeCustomMode && currentPermissionLevel === opt.id ? 'true' : undefined"
          class="flex min-h-[50px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors"
          :style="{
            backgroundColor: !activeCustomMode && currentPermissionLevel === opt.id ? 'var(--dt-subtle)' : 'transparent',
          }"
          @click="selectLevel(opt.id)"
        >
          <component
            :is="opt.icon"
            class="size-4 shrink-0"
            :style="{ color: opt.danger ? 'var(--dt-red)' : 'var(--dt-ink2)' }"
          />
          <div class="min-w-0 flex-1">
            <div
              class="truncate text-[13px] font-medium"
              :style="{ color: opt.danger ? 'var(--dt-red)' : 'var(--dt-ink)' }"
            >
              {{ opt.title }}
            </div>
            <div class="truncate text-[11.5px]" style="color: var(--dt-ink3)">
              {{ opt.desc }}
            </div>
          </div>
          <Check
            v-if="!activeCustomMode && currentPermissionLevel === opt.id"
            class="size-[15px] shrink-0"
            style="color: var(--dt-ink)"
          />
        </button>

        <!-- Agent-specific custom extra modes below a divider -->
        <template v-if="customExtraModes.length > 0">
          <div class="my-1 h-px w-full" style="background-color: var(--dt-line)" />

          <button
            v-for="mode in customExtraModes"
            :key="mode.id"
            type="button"
            role="menuitemradio"
            :aria-checked="activeCustomMode?.id === mode.id"
            :data-testid="`perm-custom-${mode.id}`"
            :data-active="activeCustomMode?.id === mode.id ? 'true' : undefined"
            class="flex min-h-[44px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors"
            :style="{
              backgroundColor: activeCustomMode?.id === mode.id ? 'var(--dt-subtle)' : 'transparent',
            }"
            @click="selectCustomMode(mode.id)"
          >
            <SlidersHorizontal class="size-4 shrink-0" style="color: var(--dt-ink2)" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px] font-medium" style="color: var(--dt-ink)">
                {{ mode.name }}
              </div>
              <div v-if="mode.description" class="truncate text-[11.5px]" style="color: var(--dt-ink3)">
                {{ mode.description }}
              </div>
            </div>
            <Check
              v-if="activeCustomMode?.id === mode.id"
              class="size-[15px] shrink-0"
              style="color: var(--dt-ink)"
            />
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>
