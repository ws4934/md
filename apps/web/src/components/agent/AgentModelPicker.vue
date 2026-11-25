<script setup lang="ts">
import type { AcpAgentStatus } from '@md/shared/types'
import { Check, ChevronDown, ChevronRight, Loader2, Settings2 } from '@lucide/vue'
import { parseVariantModelId } from '@md/shared/utils/acp-thinking'
import { useAgentStore } from '@/stores/agent'
import { useUIStore } from '@/stores/ui'
import AgentAvatar from './AgentAvatar.vue'

const props = withDefaults(defineProps<{
  placement?: `up` | `down`
  disabled?: boolean
}>(), {
  placement: `up`,
  disabled: false,
})

const { t } = useI18n()
const agentStore = useAgentStore()
const uiStore = useUIStore()

const {
  agents,
  selectedAgent,
  selectedModel,
  probeByAgent,
  probingAgents,
} = storeToRefs(agentStore)

const isOpen = ref(false)
const hoveredAgentId = ref<string | null>(null)
const containerRef = ref<HTMLElement | null>(null)

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
    ?? probe?.currentModelId
    ?? submenuModels.value[0]?.id
    ?? null
  return parseVariantModelId(raw, probe?.models ?? []).baseModelId
})

const isDefaultModelSelected = computed(() =>
  selectedModel.value?.id.trim().toLowerCase() === `default`,
)

const pillTooltip = computed(() => {
  const agentName = selectedAgent.value?.name ?? t(`agent.composer.selectAgent`)
  const modelName = selectedModel.value?.name
  return modelName ? `${agentName} · ${modelName}` : agentName
})

const scheduleProbe = useDebounceFn((agentId: string) => {
  void agentStore.probeAgent(agentId)
}, 120)

function toggleMenu() {
  if (props.disabled)
    return
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    const initial = selectedAgent.value?.installed ? selectedAgent.value.id : agents.value.find(a => a.installed)?.id ?? null
    hoveredAgentId.value = initial
    if (initial && !probeByAgent.value[initial])
      scheduleProbe(initial)
  }
}

function closeMenu() {
  isOpen.value = false
}

function onHoverAgent(agent: AcpAgentStatus) {
  if (!agent.installed)
    return
  // Never spawn CLI probes on pointer hover; probe only on menu open or explicit click.
  hoveredAgentId.value = agent.id
}

function onClickAgent(agent: AcpAgentStatus) {
  if (!agent.installed) {
    closeMenu()
    uiStore.openPreferencesDialog(`agents`)
    return
  }
  hoveredAgentId.value = agent.id
  const probe = probeByAgent.value[agent.id]
  if (!probe) {
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

onClickOutside(containerRef, () => {
  if (isOpen.value)
    closeMenu()
})

onKeyStroke(`Escape`, () => {
  if (isOpen.value)
    closeMenu()
})
</script>

<template>
  <div ref="containerRef" class="relative inline-flex max-w-full min-w-0 shrink">
    <button
      type="button"
      data-testid="agent-model-pill"
      :disabled="disabled"
      :title="pillTooltip"
      class="agent-model-trigger inline-flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg pl-1 pr-2 text-[12.5px] transition-colors disabled:opacity-50"
      :class="{
        'has-model': Boolean(selectedModel),
        'is-default-model': isDefaultModelSelected,
      }"
      :style="{
        backgroundColor: isOpen ? 'var(--dt-subtle)' : 'transparent',
        color: 'var(--dt-ink)',
      }"
      @click="toggleMenu"
    >
      <AgentAvatar v-if="selectedAgent" :avatar="selectedAgent.avatar" :size="18" class="shrink-0" />
      <span class="agent-model-agent-name min-w-0 truncate font-medium">
        {{ selectedAgent?.name ?? t('agent.composer.selectAgent') }}
      </span>
      <span
        v-if="selectedModel"
        class="agent-model-name min-w-0 truncate"
        style="color: var(--dt-ink3)"
      >
        {{ selectedModel.name }}
      </span>
      <span
        v-if="isDefaultModelSelected"
        class="agent-model-default-short min-w-0 truncate"
        style="color: var(--dt-ink3)"
      >
        {{ t('agent.thinking.levels.default') }}
      </span>
      <ChevronDown class="size-3.5 shrink-0" style="color: var(--dt-ink3)" />
    </button>

    <div
      v-if="isOpen"
      class="absolute z-40 flex gap-1.5"
      :class="placement === 'up' ? 'bottom-full mb-2 right-0 flex-row-reverse items-end' : 'top-full mt-2 left-0 flex-row items-start'"
    >
      <!-- Agent list menu -->
      <div
        class="max-h-[340px] w-[260px] overflow-y-auto rounded-xl p-1.5"
        style="
          background-color: var(--dt-surface);
          border: 1px solid var(--dt-line);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
        "
      >
        <button
          v-for="agent in agents"
          :key="agent.id"
          type="button"
          :data-testid="`agent-option-${agent.id}`"
          class="flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors"
          :class="agent.installed ? 'cursor-pointer' : 'cursor-pointer opacity-55'"
          :style="{
            backgroundColor: activeSubmenuAgent?.id === agent.id ? 'var(--dt-subtle)' : 'transparent',
            color: 'var(--dt-ink)',
          }"
          @mouseenter="onHoverAgent(agent)"
          @click="onClickAgent(agent)"
        >
          <AgentAvatar :avatar="agent.avatar" :size="20" />
          <span class="min-w-0 flex-1 truncate font-medium">{{ agent.name }}</span>
          <span v-if="!agent.installed" class="shrink-0 text-xs" style="color: var(--dt-ink3)">
            {{ t('agent.composer.notInstalled') }}
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
        v-if="activeSubmenuAgent"
        class="max-h-[340px] w-[240px] overflow-y-auto rounded-xl p-1.5"
        style="
          background-color: var(--dt-surface);
          border: 1px solid var(--dt-line);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
        "
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
            :data-testid="`model-option-${model.id}`"
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
    </div>
  </div>
</template>

<style scoped>
.agent-model-agent-name {
  flex-shrink: 0;
  max-width: 128px;
}

.agent-model-default-short {
  display: none;
}

/* At default 400px panel width (single-row composer), avoid double-truncating both agent and model:
 * show avatar + model name for concrete models, or avatar + agent + short Default for generic defaults. */
@container composer (min-width: 336px) and (max-width: 439px) {
  .agent-model-trigger.has-model:not(.is-default-model) .agent-model-agent-name {
    display: none;
  }

  .agent-model-trigger.has-model:not(.is-default-model) .agent-model-name {
    color: var(--dt-ink) !important;
    font-weight: 500;
  }

  .agent-model-trigger.is-default-model .agent-model-agent-name {
    flex-shrink: 1;
  }

  .agent-model-trigger.is-default-model .agent-model-name {
    display: none;
  }

  .agent-model-trigger.is-default-model .agent-model-default-short {
    display: inline;
    flex-shrink: 0;
  }
}
</style>
