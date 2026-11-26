<script setup lang="ts">
import type { AcpAgentStatus } from '@md/shared/types'
import type { CSSProperties } from 'vue'
import { Check, ChevronDown, ChevronRight, Loader2, Settings2 } from '@lucide/vue'
import { API_MODEL_AGENT_ID } from '@md/shared/types'
import { parseVariantModelId } from '@md/shared/utils/acp-thinking'
import { useFloatingMenu } from '@/composables/useFloatingMenu'
import {
  computeCascadingMenuLayout,
  resolveModelPillDisplayMode,
  scrollActiveOptionIntoView,
  toFloatingBoxStyle,
} from '@/lib/agent/floating-menu'
import { useAgentStore } from '@/stores/agent'
import { useUIStore } from '@/stores/ui'
import AgentAvatar from './AgentAvatar.vue'

const props = withDefaults(defineProps<{
  placement?: `up` | `down`
  disabled?: boolean
  availableWidth?: number | null
}>(), {
  placement: `up`,
  disabled: false,
  availableWidth: null,
})

const { t, locale } = useI18n()
const agentStore = useAgentStore()
const uiStore = useUIStore()

const {
  agents,
  selectedAgent,
  selectedModel,
  probeByAgent,
  probingAgents,
} = storeToRefs(agentStore)

const PRIMARY_MENU_WIDTH = 260
const SUBMENU_WIDTH = 240
const MAX_MENU_HEIGHT = 340

const isOpen = ref(false)
const hoveredAgentId = ref<string | null>(null)
const triggerRef = ref<HTMLElement | null>(null)
const primaryMenuRef = ref<HTMLElement | null>(null)
const submenuRef = ref<HTMLElement | null>(null)
const measureFullRef = ref<HTMLElement | null>(null)
const measuredFullWidth = ref<number>(0)

const primaryStyle = ref<CSSProperties>({})
const submenuStyle = ref<CSSProperties>({})

const activeSubmenuAgent = computed<AcpAgentStatus | null>(() => {
  const id = hoveredAgentId.value ?? selectedAgent.value?.id ?? null
  if (!id)
    return null
  const found = agents.value.find(a => a.id === id)
  return found?.installed ? found : null
})

const submenuModels = computed(() => {
  const agent = activeSubmenuAgent.value
  if (!agent)
    return []
  return probeByAgent.value[agent.id]?.models ?? []
})

const isSubmenuProbing = computed(() => {
  const agent = activeSubmenuAgent.value
  return Boolean(agent && probingAgents.value[agent.id])
})

const activeModelIdForSubmenu = computed(() => {
  const agent = activeSubmenuAgent.value
  if (!agent)
    return null
  const probe = probeByAgent.value[agent.id]
  const raw = agentStore.selectedModelByAgent[agent.id]
    ?? agentStore.settings.lastModelByAgent[agent.id]
    ?? probe?.currentModelId
    ?? submenuModels.value[0]?.id
    ?? null
  return parseVariantModelId(raw, probe?.models ?? []).baseModelId
})

const isDefaultModelSelected = computed(() =>
  selectedModel.value?.id.trim().toLowerCase() === `default`,
)

const pillTooltip = computed(() => {
  void locale.value
  const agentName = selectedAgent.value?.name ?? t(`agent.composer.selectAgent`)
  const modelName = selectedModel.value?.name
  return modelName ? `${agentName} · ${modelName}` : agentName
})

const pillDisplayMode = computed(() =>
  resolveModelPillDisplayMode({
    availableWidth: props.availableWidth,
    fullWidth: measuredFullWidth.value,
    hasModel: Boolean(selectedModel.value),
    isDefaultModel: isDefaultModelSelected.value,
  }),
)

function measureFullPill() {
  const el = measureFullRef.value
  if (!el)
    return
  measuredFullWidth.value = Math.ceil(el.getBoundingClientRect().width)
}

onMounted(() => {
  nextTick(measureFullPill)
})

watch(
  [() => selectedAgent.value?.name, () => selectedModel.value?.name, locale],
  () => nextTick(measureFullPill),
)

// Re-measure when an initially collapsed panel (`v-show="false"`) becomes visible.
watch(
  () => props.availableWidth,
  (width, prevWidth) => {
    if (width && width > 0 && (measuredFullWidth.value <= 0 || !prevWidth || prevWidth <= 0))
      nextTick(measureFullPill)
  },
)

function updateMenuPositions() {
  const trigger = triggerRef.value
  if (!trigger)
    return
  const anchor = trigger.getBoundingClientRect()
  const primaryRect = primaryMenuRef.value?.getBoundingClientRect()
  const submenuRect = submenuRef.value?.getBoundingClientRect()

  const layout = computeCascadingMenuLayout({
    anchor,
    primary: {
      width: primaryRect?.width || PRIMARY_MENU_WIDTH,
      height: primaryRect?.height || Math.min(MAX_MENU_HEIGHT, agents.value.length * 38 + 60),
    },
    submenu: activeSubmenuAgent.value
      ? {
          width: submenuRect?.width || SUBMENU_WIDTH,
          height: submenuRect?.height || Math.min(MAX_MENU_HEIGHT, Math.max(1, submenuModels.value.length) * 44 + 48),
        }
      : null,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    preferredSide: props.placement === `up` ? `top` : `bottom`,
  })

  primaryStyle.value = toFloatingBoxStyle(layout.primary, MAX_MENU_HEIGHT)
  if (layout.submenu)
    submenuStyle.value = toFloatingBoxStyle(layout.submenu, MAX_MENU_HEIGHT)
}

const scheduleProbe = useDebounceFn((agentId: string) => {
  void agentStore.probeAgent(agentId)
}, 120)

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
  const initial = selectedAgent.value?.installed
    ? selectedAgent.value.id
    : agents.value.find(a => a.installed)?.id ?? null
  hoveredAgentId.value = initial
  if (initial && agentStore.needsProbe(initial))
    scheduleProbe(initial)
  // Pre-compute approximate coordinates before mount to prevent any (0, 0) flash.
  updateMenuPositions()
  isOpen.value = true
}

useFloatingMenu({
  isOpen,
  triggerRef,
  menuRefs: [primaryMenuRef, submenuRef],
  onReposition: updateMenuPositions,
  onClose: closeMenu,
  disabled: () => props.disabled,
  closeOnChange: () => agentStore.activeSessionId,
})

watch(
  [activeSubmenuAgent, () => submenuModels.value.length, isSubmenuProbing],
  () => {
    if (!isOpen.value)
      return
    nextTick(() => {
      updateMenuPositions()
      scrollActiveOptionIntoView(submenuRef.value)
    })
  },
)

function onHoverAgent(agent: AcpAgentStatus) {
  if (!agent.installed)
    return
  // Never spawn CLI probes on pointer hover; probe only on menu open or explicit click.
  hoveredAgentId.value = agent.id
}

function onClickAgent(agent: AcpAgentStatus) {
  if (!agent.installed) {
    closeMenu()
    uiStore.openPreferencesDialog(agent.id === API_MODEL_AGENT_ID ? `modelApi` : `agents`)
    return
  }
  hoveredAgentId.value = agent.id
  const probe = probeByAgent.value[agent.id]
  if (agentStore.needsProbe(agent.id)) {
    scheduleProbe(agent.id)
  }
  // If no selectable models exist, select the agent immediately and close.
  if (probe && probe.models.length === 0) {
    void agentStore.selectAgentAndModel(agent.id)
    closeMenu()
  }
  else {
    void agentStore.selectAgentAndModel(agent.id, activeModelIdForSubmenu.value ?? undefined)
  }
}

function onSelectModel(agentId: string, modelId: string) {
  void agentStore.selectAgentAndModel(agentId, modelId)
  closeMenu()
}

function openManageAgents() {
  closeMenu()
  uiStore.openPreferencesDialog(`agents`)
}
</script>

<template>
  <div class="relative inline-flex max-w-full min-w-0 shrink">
    <!-- Hidden offscreen probe measuring intrinsic full (agent + model) pill width for zero-truncation switching -->
    <span
      ref="measureFullRef"
      aria-hidden="true"
      class="pointer-events-none invisible fixed -left-[9999px] -top-[9999px] inline-flex h-7 items-center gap-1.5 whitespace-nowrap pl-1 pr-2 text-[12.5px]"
    >
      <span v-if="selectedAgent" class="inline-block size-[18px] shrink-0" />
      <span class="font-medium">{{ selectedAgent?.name ?? t('agent.composer.selectAgent') }}</span>
      <span v-if="selectedModel">{{ selectedModel.name }}</span>
      <span class="inline-block size-3.5 shrink-0" />
    </span>

    <button
      ref="triggerRef"
      type="button"
      data-testid="agent-model-pill"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      :disabled="disabled"
      :title="pillTooltip"
      class="inline-flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg pl-1 pr-2 text-[12.5px] transition-colors disabled:opacity-50"
      :style="{
        backgroundColor: isOpen ? 'var(--dt-subtle)' : 'transparent',
        color: 'var(--dt-ink)',
      }"
      @click="toggleMenu"
    >
      <AgentAvatar v-if="selectedAgent" :avatar="selectedAgent.avatar" :size="18" class="shrink-0" />

      <template v-if="pillDisplayMode === 'model-only' && selectedModel">
        <span class="min-w-0 truncate font-medium">
          {{ selectedModel.name }}
        </span>
      </template>

      <template v-else-if="pillDisplayMode === 'agent-default'">
        <span class="min-w-0 truncate font-medium">
          {{ selectedAgent?.name ?? t('agent.composer.selectAgent') }}
        </span>
        <span class="shrink-0" style="color: var(--dt-ink3)">
          {{ t('agent.thinking.levels.default') }}
        </span>
      </template>

      <template v-else>
        <span class="shrink-0 font-medium">
          {{ selectedAgent?.name ?? t('agent.composer.selectAgent') }}
        </span>
        <span
          v-if="selectedModel"
          class="min-w-0 truncate"
          style="color: var(--dt-ink3)"
        >
          {{ selectedModel.name }}
        </span>
      </template>

      <ChevronDown class="size-3.5 shrink-0" style="color: var(--dt-ink3)" />
    </button>

    <Teleport to="body">
      <!-- Agent list menu -->
      <div
        v-if="isOpen"
        ref="primaryMenuRef"
        role="menu"
        data-testid="agent-picker-menu"
        class="fixed z-50 w-[260px] overflow-y-auto rounded-xl p-1.5"
        :style="{
          ...primaryStyle,
          backgroundColor: 'var(--dt-surface)',
          border: '1px solid var(--dt-line)',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06)',
        }"
      >
        <button
          v-for="agent in agents"
          :key="agent.id"
          type="button"
          role="menuitem"
          :data-testid="`agent-option-${agent.id}`"
          :data-active="activeSubmenuAgent?.id === agent.id ? 'true' : undefined"
          class="flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors"
          :class="agent.installed ? 'cursor-pointer' : 'cursor-pointer opacity-55'"
          :style="{
            backgroundColor: activeSubmenuAgent?.id === agent.id ? 'var(--dt-subtle)' : 'transparent',
            color: 'var(--dt-ink)',
          }"
          @mouseenter="onHoverAgent(agent)"
          @focus="onHoverAgent(agent)"
          @click="onClickAgent(agent)"
        >
          <AgentAvatar :avatar="agent.avatar" :size="20" />
          <span class="min-w-0 flex-1 truncate font-medium">{{ agent.name }}</span>
          <span v-if="!agent.installed" class="shrink-0 text-xs" style="color: var(--dt-ink3)">
            {{ agent.id === API_MODEL_AGENT_ID ? t('agent.composer.notConfigured') : t('agent.composer.notInstalled') }}
          </span>
          <ChevronRight
            v-else-if="activeSubmenuAgent?.id === agent.id"
            class="size-3.5 shrink-0"
            style="color: var(--dt-ink3)"
          />
          <Check
            v-else-if="selectedAgent?.id === agent.id"
            class="size-3.5 shrink-0"
            style="color: var(--dt-ink3)"
          />
        </button>

        <div class="my-1.5 h-px w-full" style="background-color: var(--dt-line)" />

        <button
          type="button"
          class="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors hover:opacity-85"
          style="color: var(--dt-ink2)"
          @click="openManageAgents"
        >
          <Settings2 class="size-3.5 shrink-0" style="color: var(--dt-ink3)" />
          <span>{{ t('agent.composer.manageAgents') }}</span>
        </button>
      </div>

      <!-- Cascading models menu for hovered/selected installed agent -->
      <div
        v-if="isOpen && activeSubmenuAgent"
        ref="submenuRef"
        role="menu"
        data-testid="model-picker-submenu"
        class="fixed z-50 w-[240px] overflow-y-auto rounded-xl p-1.5"
        :style="{
          ...submenuStyle,
          backgroundColor: 'var(--dt-surface)',
          border: '1px solid var(--dt-line)',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06)',
        }"
      >
        <div class="px-2.5 pb-1.5 pt-1 text-[11.5px] font-semibold" style="color: var(--dt-ink3)">
          {{ t('agent.composer.modelsOf', { agent: activeSubmenuAgent.name }) }}
        </div>

        <div
          v-if="isSubmenuProbing && submenuModels.length === 0"
          class="flex items-center gap-2 px-2.5 py-3 text-xs"
          style="color: var(--dt-ink3)"
        >
          <Loader2 class="size-3.5 animate-spin" />
          <span>{{ t('agent.composer.loadingModels') }}</span>
        </div>

        <template v-else-if="submenuModels.length > 0">
          <button
            v-for="model in submenuModels"
            :key="model.id"
            type="button"
            role="menuitemradio"
            :aria-checked="activeModelIdForSubmenu === model.id && selectedAgent?.id === activeSubmenuAgent.id"
            :data-testid="`model-option-${model.id}`"
            :data-active="activeModelIdForSubmenu === model.id && selectedAgent?.id === activeSubmenuAgent.id ? 'true' : undefined"
            class="flex min-h-[42px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors"
            :style="{
              backgroundColor: activeModelIdForSubmenu === model.id && selectedAgent?.id === activeSubmenuAgent.id
                ? 'var(--dt-subtle)'
                : 'transparent',
            }"
            @click="onSelectModel(activeSubmenuAgent.id, model.id)"
          >
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px] font-medium" style="color: var(--dt-ink)">
                {{ model.name }}
              </div>
              <div v-if="model.description" class="truncate text-[11.5px]" style="color: var(--dt-ink3)">
                {{ model.description }}
              </div>
            </div>
            <Check
              v-if="activeModelIdForSubmenu === model.id && selectedAgent?.id === activeSubmenuAgent.id"
              class="size-3.5 shrink-0"
              style="color: var(--dt-ink)"
            />
          </button>
        </template>

        <button
          v-else
          type="button"
          class="flex h-10 w-full cursor-pointer items-center justify-between rounded-lg px-2.5 text-left text-[13px]"
          style="background-color: var(--dt-subtle); color: var(--dt-ink)"
          @click="onSelectModel(activeSubmenuAgent.id, '')"
        >
          <span>{{ t('agent.composer.defaultModel') }}</span>
          <Check v-if="selectedAgent?.id === activeSubmenuAgent.id" class="size-3.5" />
        </button>
      </div>
    </Teleport>
  </div>
</template>
