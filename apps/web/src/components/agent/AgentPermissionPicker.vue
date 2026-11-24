<script setup lang="ts">
import type { AcpPermissionLevel } from '@md/shared/types'
import { Check, NotebookPen, Shield, ShieldCheck, ShieldOff, SlidersHorizontal } from '@lucide/vue'
import { useAgentStore } from '@/stores/agent'

const props = withDefaults(defineProps<{
  placement?: `up` | `down`
  disabled?: boolean
}>(), {
  placement: `up`,
  disabled: false,
})

const { t } = useI18n()
const agentStore = useAgentStore()

const {
  currentPermissionLevel,
  customExtraModes,
  activeCustomMode,
} = storeToRefs(agentStore)

const isOpen = ref(false)
const containerRef = ref<HTMLElement | null>(null)

interface PermissionOptionItem {
  id: AcpPermissionLevel
  icon: typeof Shield
  shortLabel: string
  title: string
  desc: string
  danger?: boolean
}

const permissionOptions = computed<PermissionOptionItem[]>(() => [
  {
    id: `ask`,
    icon: Shield,
    shortLabel: t(`agent.permissionMode.shortAsk`),
    title: t(`agent.permissionMode.askTitle`),
    desc: t(`agent.permissionMode.askDesc`),
  },
  {
    id: `auto_edits`,
    icon: ShieldCheck,
    shortLabel: t(`agent.permissionMode.shortAutoEdits`),
    title: t(`agent.permissionMode.autoEditsTitle`),
    desc: t(`agent.permissionMode.autoEditsDesc`),
  },
  {
    id: `plan`,
    icon: NotebookPen,
    shortLabel: t(`agent.permissionMode.shortPlan`),
    title: t(`agent.permissionMode.planTitle`),
    desc: t(`agent.permissionMode.planDesc`),
  },
  {
    id: `bypass`,
    icon: ShieldOff,
    shortLabel: t(`agent.permissionMode.shortBypass`),
    title: t(`agent.permissionMode.bypassTitle`),
    desc: t(`agent.permissionMode.bypassDesc`),
    danger: true,
  },
])

const activeOption = computed(() =>
  permissionOptions.value.find(o => o.id === currentPermissionLevel.value) ?? permissionOptions.value[0],
)

const isDangerActive = computed(() => !activeCustomMode.value && activeOption.value.id === `bypass`)

const pillIcon = computed(() => activeCustomMode.value ? SlidersHorizontal : activeOption.value.icon)
const pillLabel = computed(() => activeCustomMode.value ? activeCustomMode.value.name : activeOption.value.shortLabel)

function toggleMenu() {
  if (props.disabled)
    return
  isOpen.value = !isOpen.value
}

function selectLevel(level: AcpPermissionLevel) {
  isOpen.value = false
  void agentStore.setSessionPermissionMode({ permissionLevel: level, modeId: null })
}

function selectCustomMode(modeId: string) {
  isOpen.value = false
  void agentStore.setSessionPermissionMode({ modeId })
}

function onClickOutside(event: MouseEvent) {
  if (!isOpen.value)
    return
  const target = event.target as Node | null
  if (containerRef.value && target && !containerRef.value.contains(target))
    isOpen.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (isOpen.value && event.key === `Escape`)
    isOpen.value = false
}

onMounted(() => {
  document.addEventListener(`mousedown`, onClickOutside)
  document.addEventListener(`keydown`, onKeydown)
})

onUnmounted(() => {
  document.removeEventListener(`mousedown`, onClickOutside)
  document.removeEventListener(`keydown`, onKeydown)
})
</script>

<template>
  <div ref="containerRef" class="relative inline-flex">
    <button
      type="button"
      data-testid="permission-mode-pill"
      :disabled="disabled"
      :title="t('agent.permissionMode.menuTitle')"
      class="inline-flex h-7 cursor-pointer items-center gap-[5px] rounded-lg px-[7px] text-[12.5px] transition-colors disabled:opacity-50"
      :style="{
        backgroundColor: isOpen ? 'var(--dt-subtle)' : 'transparent',
        color: isDangerActive ? 'var(--dt-red)' : 'var(--dt-ink2)',
      }"
      @click="toggleMenu"
    >
      <component :is="pillIcon" class="size-3.5 shrink-0" />
      <span class="max-w-[84px] truncate">{{ pillLabel }}</span>
    </button>

    <div
      v-if="isOpen"
      data-testid="permission-mode-menu"
      class="absolute z-40 flex w-[316px] flex-col gap-0.5 rounded-xl p-1.5"
      :class="placement === 'up' ? 'bottom-full mb-2 right-[-44px]' : 'top-full mt-2 left-0'"
      style="
        background-color: var(--dt-surface);
        border: 1px solid var(--dt-line);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
      "
    >
      <div class="px-2.5 pb-1.5 pt-1 text-[11.5px] font-semibold" style="color: var(--dt-ink3)">
        {{ t('agent.permissionMode.menuTitle') }}
      </div>

      <button
        v-for="opt in permissionOptions"
        :key="opt.id"
        type="button"
        :data-testid="`perm-option-${opt.id}`"
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
          :data-testid="`perm-custom-${mode.id}`"
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
  </div>
</template>
