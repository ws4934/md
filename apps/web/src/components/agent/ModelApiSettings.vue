<script setup lang="ts">
import type { DesktopAiProtocol, DesktopModelApiConfig } from '@md/shared/types'
import { Check, Eye, EyeOff, Info, Plus, RefreshCw, Search, Trash2 } from '@lucide/vue'
import { serviceOptions } from '@md/shared/configs/ai-service-options'
import { API_MODEL_AGENT_ID, DEFAULT_PROTOCOL_BASE_URLS } from '@md/shared/types'
import PanelSelect from '@/components/shared/panel-dialog/PanelSelect.vue'
import { Label } from '@/components/ui/label'
import { useAgentStore } from '@/stores/agent'

const { t, locale } = useI18n()
const agentStore = useAgentStore()

const openAiPresets = serviceOptions.filter(option => option.value !== `default`)

const protocol = ref<DesktopAiProtocol>(`openai-compatible`)
const providerPreset = ref(`openai`)
const baseUrl = ref(DEFAULT_PROTOCOL_BASE_URLS[`openai-compatible`])
const hasSavedKey = ref(false)
const apiKeyInput = ref(``)
const clearSavedKey = ref(false)
const showKey = ref(false)

const availableModels = ref<string[]>([])
const enabledModels = ref<string[]>([])
const defaultModel = ref(``)
const modelSearch = ref(``)
const customModelInput = ref(``)

const isFetchingModels = ref(false)
const isSaving = ref(false)
const fetchError = ref(``)

const protocolOptions = computed(() => {
  void locale.value
  return [
    { value: `openai-compatible`, label: t(`agent.modelApi.protocols.openaiCompatible`) },
    { value: `anthropic`, label: t(`agent.modelApi.protocols.anthropic`) },
    { value: `google`, label: t(`agent.modelApi.protocols.google`) },
  ]
})

const presetOptions = computed(() => {
  void locale.value
  return openAiPresets.map(option => ({
    value: option.value,
    label: option.value === `custom` ? t(`agent.modelApi.customProvider`) : option.label,
  }))
})

const allListedModels = computed(() => {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const id of [...enabledModels.value, ...availableModels.value]) {
    if (!seen.has(id)) {
      seen.add(id)
      merged.push(id)
    }
  }
  return merged
})

const filteredModels = computed(() => {
  const q = modelSearch.value.trim().toLowerCase()
  if (!q)
    return allListedModels.value
  return allListedModels.value.filter(id => id.toLowerCase().includes(q))
})

const enabledSet = computed(() => new Set(enabledModels.value))

const defaultModelOptions = computed(() =>
  enabledModels.value.map(id => ({ value: id, label: id })),
)

const effectiveHasKey = computed(() =>
  Boolean(apiKeyInput.value.trim()) || (hasSavedKey.value && !clearSavedKey.value),
)

const isReady = computed(() =>
  effectiveHasKey.value && Boolean(baseUrl.value.trim()) && enabledModels.value.length > 0,
)

function applyLoadedConfig(cfg: DesktopModelApiConfig) {
  protocol.value = cfg.protocol
  providerPreset.value = cfg.providerPreset || (cfg.protocol === `openai-compatible` ? `openai` : cfg.protocol)
  baseUrl.value = cfg.baseUrl || DEFAULT_PROTOCOL_BASE_URLS[cfg.protocol]
  hasSavedKey.value = cfg.hasApiKey
  apiKeyInput.value = ``
  clearSavedKey.value = false
  enabledModels.value = [...cfg.enabledModels]
  availableModels.value = [...cfg.availableModels]
  defaultModel.value = cfg.defaultModel || cfg.enabledModels[0] || ``
}

onMounted(async () => {
  if (!window.mdDesktop?.ai)
    return
  const configs = await window.mdDesktop.ai.getConfigs()
  applyLoadedConfig(configs.modelApi)
})

function onProtocolChange(next: string) {
  const nextProtocol = next as DesktopAiProtocol
  if (nextProtocol === protocol.value)
    return
  const prevDefault = DEFAULT_PROTOCOL_BASE_URLS[protocol.value]
  const prevPresetEndpoint = openAiPresets.find(p => p.value === providerPreset.value)?.endpoint.replace(/\/+$/, ``)
  const normalizedCurrent = baseUrl.value.trim().replace(/\/+$/, ``)
  protocol.value = nextProtocol
  if (!normalizedCurrent || normalizedCurrent === prevDefault || normalizedCurrent === prevPresetEndpoint) {
    baseUrl.value = DEFAULT_PROTOCOL_BASE_URLS[nextProtocol]
    if (nextProtocol === `openai-compatible`)
      providerPreset.value = `openai`
  }
  fetchError.value = ``
}

function onPresetChange(nextPreset: string) {
  providerPreset.value = nextPreset
  const found = openAiPresets.find(p => p.value === nextPreset)
  if (found && found.endpoint)
    baseUrl.value = found.endpoint.replace(/\/+$/, ``)
  fetchError.value = ``
}

function onBaseUrlInput() {
  if (protocol.value !== `openai-compatible`)
    return
  const normalized = baseUrl.value.trim().replace(/\/+$/, ``)
  const matched = openAiPresets.find(p => p.endpoint && p.endpoint.replace(/\/+$/, ``) === normalized)
  providerPreset.value = matched ? matched.value : `custom`
}

function onApiKeyInput() {
  if (apiKeyInput.value.trim())
    clearSavedKey.value = false
}

function markClearSavedKey() {
  apiKeyInput.value = ``
  clearSavedKey.value = true
}

function toggleModel(modelId: string) {
  if (enabledSet.value.has(modelId)) {
    enabledModels.value = enabledModels.value.filter(id => id !== modelId)
    if (defaultModel.value === modelId)
      defaultModel.value = enabledModels.value[0] ?? ``
  }
  else {
    enabledModels.value = [...enabledModels.value, modelId]
    if (!defaultModel.value)
      defaultModel.value = modelId
  }
}

function addManualModel() {
  const id = customModelInput.value.trim()
  if (!id)
    return
  if (!availableModels.value.includes(id))
    availableModels.value = [id, ...availableModels.value]
  if (!enabledSet.value.has(id))
    enabledModels.value = [...enabledModels.value, id]
  if (!defaultModel.value)
    defaultModel.value = id
  customModelInput.value = ``
}

async function fetchModels() {
  if (!window.mdDesktop?.ai || isFetchingModels.value)
    return
  if (!effectiveHasKey.value) {
    toast.error(t(`agent.modelApi.keyRequired`))
    return
  }

  isFetchingModels.value = true
  fetchError.value = ``
  try {
    const result = await window.mdDesktop.ai.listRemoteModels({
      protocol: protocol.value,
      baseUrl: baseUrl.value.trim() || DEFAULT_PROTOCOL_BASE_URLS[protocol.value],
      apiKey: apiKeyInput.value.trim() || undefined,
    })
    if (!result.ok) {
      fetchError.value = result.error || t(`agent.modelApi.fetchFailed`)
      return
    }
    const fetchedIds = result.models.map(m => m.id)
    availableModels.value = fetchedIds
    if (fetchedIds.length === 0) {
      toast.info(t(`agent.modelApi.noModelsFound`))
    }
    else {
      toast.success(t(`agent.modelApi.fetchedCount`, { count: fetchedIds.length }))
    }
  }
  finally {
    isFetchingModels.value = false
  }
}

async function saveConfig() {
  if (!window.mdDesktop?.ai || isSaving.value)
    return

  isSaving.value = true
  try {
    const patch = {
      protocol: protocol.value,
      providerPreset: protocol.value === `openai-compatible` ? providerPreset.value : protocol.value,
      baseUrl: baseUrl.value.trim() || DEFAULT_PROTOCOL_BASE_URLS[protocol.value],
      ...(clearSavedKey.value
        ? { apiKey: `` }
        : (apiKeyInput.value.trim() ? { apiKey: apiKeyInput.value.trim() } : {})),
      // Pass plain arrays because Vue Proxy arrays cannot be structured-cloned across Electron IPC.
      enabledModels: [...enabledModels.value],
      availableModels: [...allListedModels.value],
      defaultModel: defaultModel.value || enabledModels.value[0] || ``,
    }
    const updated = await window.mdDesktop.ai.updateModelApiConfig(patch)
    applyLoadedConfig(updated)
    await agentStore.refreshAgentsList()
    if (updated.hasApiKey && updated.enabledModels.length > 0)
      void agentStore.probeAgent(API_MODEL_AGENT_ID, true)
    toast.success(t(`common.saveSuccess`))
  }
  catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
  finally {
    isSaving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="model-api-settings">
    <div
      class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
      style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
    >
      <Info class="mt-0.5 size-3.5 shrink-0" style="color: var(--dt-ink3)" />
      <span>
        {{ isReady ? t('agent.modelApi.readyHint') : t('agent.modelApi.setupHint') }}
      </span>
    </div>

    <div class="space-y-1">
      <!-- Protocol -->
      <div class="flex items-center justify-between gap-4 border-b py-3" style="border-color: var(--dt-line)">
        <div class="min-w-0 space-y-0.5">
          <Label>{{ t('agent.modelApi.protocolLabel') }}</Label>
          <p class="text-xs" style="color: var(--dt-ink3)">
            {{ t('agent.modelApi.protocolHint') }}
          </p>
        </div>
        <PanelSelect
          :model-value="protocol"
          :options="protocolOptions"
          trigger-class="w-[180px]"
          @update:model-value="onProtocolChange"
        />
      </div>

      <!-- OpenAI-compatible provider preset -->
      <div
        v-if="protocol === 'openai-compatible'"
        class="flex items-center justify-between gap-4 border-b py-3"
        style="border-color: var(--dt-line)"
      >
        <div class="min-w-0 space-y-0.5">
          <Label>{{ t('agent.modelApi.providerPresetLabel') }}</Label>
          <p class="text-xs" style="color: var(--dt-ink3)">
            {{ t('agent.modelApi.providerPresetHint') }}
          </p>
        </div>
        <PanelSelect
          :model-value="providerPreset"
          :options="presetOptions"
          trigger-class="w-[180px]"
          @update:model-value="onPresetChange"
        />
      </div>
    </div>

    <!-- Base URL + API Key -->
    <div class="flex flex-col gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium" style="color: var(--dt-ink2)">
          {{ t('agent.modelApi.baseUrlLabel') }}
        </span>
        <input
          v-model="baseUrl"
          type="text"
          autocomplete="off"
          data-testid="model-api-base-url"
          :placeholder="DEFAULT_PROTOCOL_BASE_URLS[protocol]"
          class="h-9 w-full rounded-lg px-3 text-[13.5px] outline-none"
          style="
            background-color: var(--dt-surface);
            border: 1px solid var(--dt-line);
            color: var(--dt-ink);
            font-family: var(--dt-mono);
          "
          @input="onBaseUrlInput"
        >
      </label>

      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium" style="color: var(--dt-ink2)">
            {{ t('agent.modelApi.apiKeyLabel') }}
          </span>
          <div v-if="hasSavedKey && !clearSavedKey" class="flex items-center gap-2">
            <span
              data-testid="model-api-key-saved"
              class="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium"
              style="background-color: var(--dt-green-soft); color: var(--dt-green)"
            >
              <Check class="size-3" />
              <span>{{ t('agent.modelApi.keySaved') }}</span>
            </span>
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 text-[11.5px] transition-opacity hover:opacity-80"
              style="color: var(--dt-red)"
              @click="markClearSavedKey"
            >
              <Trash2 class="size-3" />
              <span>{{ t('agent.modelApi.clearKey') }}</span>
            </button>
          </div>
        </div>
        <div
          class="flex h-9 w-full items-center rounded-lg px-3"
          style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
        >
          <input
            v-model="apiKeyInput"
            :type="showKey ? 'text' : 'password'"
            autocomplete="off"
            data-testid="model-api-key"
            :placeholder="hasSavedKey && !clearSavedKey
              ? t('agent.modelApi.apiKeySavedPlaceholder')
              : t('agent.modelApi.apiKeyPlaceholder')"
            class="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
            style="color: var(--dt-ink); font-family: var(--dt-mono)"
            @input="onApiKeyInput"
          >
          <button
            type="button"
            class="ml-2 cursor-pointer"
            style="color: var(--dt-ink3)"
            @click="showKey = !showKey"
          >
            <EyeOff v-if="showKey" class="size-4" />
            <Eye v-else class="size-4" />
          </button>
        </div>
      </div>
    </div>

    <!-- Models section -->
    <div
      class="flex flex-col gap-3 rounded-xl p-4"
      style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
    >
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-[13.5px] font-semibold" style="color: var(--dt-ink)">
            {{ t('agent.modelApi.modelsTitle') }}
          </div>
          <p class="mt-0.5 text-xs" style="color: var(--dt-ink3)">
            {{ t('agent.modelApi.enabledCount', { count: enabledModels.length }) }}
          </p>
        </div>
        <button
          type="button"
          data-testid="model-api-fetch-models"
          :disabled="isFetchingModels"
          class="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-opacity hover:opacity-85 disabled:opacity-50"
          style="background-color: var(--dt-canvas); color: var(--dt-ink); border: 1px solid var(--dt-line)"
          @click="fetchModels"
        >
          <RefreshCw class="size-3.5" :class="{ 'animate-spin': isFetchingModels }" />
          <span>{{ isFetchingModels ? t('agent.modelApi.fetchingModels') : t('agent.modelApi.fetchModels') }}</span>
        </button>
      </div>

      <div
        v-if="fetchError"
        class="rounded-lg px-3 py-2 text-xs"
        style="background-color: var(--dt-red-soft); color: var(--dt-red)"
      >
        {{ fetchError }}
      </div>

      <!-- Search + manual add -->
      <div class="flex flex-wrap items-center gap-2">
        <div
          class="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-lg px-2.5"
          style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
        >
          <Search class="size-3.5 shrink-0" style="color: var(--dt-ink3)" />
          <input
            v-model="modelSearch"
            type="text"
            data-testid="model-api-model-search"
            :placeholder="t('agent.modelApi.searchModelsPlaceholder')"
            class="min-w-0 flex-1 bg-transparent text-xs outline-none"
            style="color: var(--dt-ink)"
          >
        </div>

        <div class="flex items-center gap-1.5">
          <input
            v-model="customModelInput"
            type="text"
            data-testid="model-api-custom-model"
            :placeholder="t('agent.modelApi.manualModelPlaceholder')"
            class="h-8 w-[160px] rounded-lg px-2.5 text-xs outline-none"
            style="
              background-color: var(--dt-canvas);
              border: 1px solid var(--dt-line);
              color: var(--dt-ink);
              font-family: var(--dt-mono);
            "
            @keydown.enter.prevent="addManualModel"
          >
          <button
            type="button"
            data-testid="model-api-add-custom-model"
            :disabled="!customModelInput.trim()"
            class="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium disabled:opacity-40"
            style="background-color: var(--dt-canvas); color: var(--dt-ink2); border: 1px solid var(--dt-line)"
            @click="addManualModel"
          >
            <Plus class="size-3.5" />
            <span>{{ t('agent.modelApi.addModel') }}</span>
          </button>
        </div>
      </div>

      <!-- Checkable model list -->
      <div
        v-if="filteredModels.length > 0"
        data-testid="model-api-model-list"
        class="flex max-h-[220px] flex-col gap-0.5 overflow-y-auto rounded-lg p-1"
        style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
      >
        <label
          v-for="modelId in filteredModels"
          :key="modelId"
          class="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs transition-colors"
          :style="{
            backgroundColor: enabledSet.has(modelId) ? 'var(--dt-subtle)' : 'transparent',
            color: 'var(--dt-ink)',
          }"
        >
          <input
            type="checkbox"
            :checked="enabledSet.has(modelId)"
            :data-testid="`model-checkbox-${modelId}`"
            class="size-3.5 accent-current"
            @change="toggleModel(modelId)"
          >
          <span class="min-w-0 flex-1 truncate" style="font-family: var(--dt-mono)">
            {{ modelId }}
          </span>
        </label>
      </div>

      <p v-else class="py-3 text-center text-xs" style="color: var(--dt-ink3)">
        {{ allListedModels.length === 0 ? t('agent.modelApi.emptyModelsHint') : t('agent.modelApi.noMatchingModels') }}
      </p>

      <!-- Default model -->
      <div
        v-if="enabledModels.length > 0"
        class="flex items-center justify-between gap-4 border-t pt-3"
        style="border-color: var(--dt-line)"
      >
        <Label>{{ t('agent.modelApi.defaultModelLabel') }}</Label>
        <PanelSelect
          :model-value="defaultModel"
          :options="defaultModelOptions"
          trigger-class="w-[220px]"
          @update:model-value="defaultModel = $event"
        />
      </div>
    </div>

    <!-- Save button -->
    <div class="flex items-center justify-end pt-1">
      <button
        type="button"
        data-testid="model-api-save"
        :disabled="isSaving"
        class="inline-flex h-8 cursor-pointer items-center rounded-lg px-4 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
        style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
        @click="saveConfig"
      >
        {{ t('agent.settings.save') }}
      </button>
    </div>
  </div>
</template>
