<script setup lang="ts">
import type { DesktopWebSearchConfig, DesktopWebSearchProtocol } from '@md/shared/types'
import { Info, Loader2, Search } from '@lucide/vue'
import { DESKTOP_WEB_SEARCH_PROTOCOLS } from '@md/shared/types'
import PanelSelect from '@/components/shared/panel-dialog/PanelSelect.vue'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import AiSecretKeyInput from './AiSecretKeyInput.vue'

const { t } = useI18n()

const DEFAULT_BASE_URL = `https://api.openai.com/v1`
const DEFAULT_MODEL = `gpt-5-mini`

const enabled = ref(false)
const protocol = ref<DesktopWebSearchProtocol>(`openai-responses`)
const baseUrl = ref(DEFAULT_BASE_URL)
const hasSavedKey = ref(false)
const apiKeyInput = ref(``)
const clearSavedKey = ref(false)
const model = ref(DEFAULT_MODEL)

const isSaving = ref(false)
const isTesting = ref(false)
const testError = ref(``)
const testResult = ref(``)
let isUnmounted = false
let hasUserEdited = false

const PROTOCOL_LABELS: Record<DesktopWebSearchProtocol, string> = {
  'openai-responses': `OpenAI Responses`,
}

const protocolOptions = DESKTOP_WEB_SEARCH_PROTOCOLS.map(value => ({ value, label: PROTOCOL_LABELS[value] }))

const effectiveHasKey = computed(() =>
  Boolean(apiKeyInput.value.trim()) || (hasSavedKey.value && !clearSavedKey.value),
)

function applyLoadedConfig(cfg: DesktopWebSearchConfig) {
  enabled.value = cfg.enabled
  protocol.value = cfg.protocol
  baseUrl.value = cfg.baseUrl || DEFAULT_BASE_URL
  hasSavedKey.value = cfg.hasApiKey
  apiKeyInput.value = ``
  clearSavedKey.value = false
  model.value = cfg.model || DEFAULT_MODEL
}

onMounted(async () => {
  if (!window.mdDesktop?.ai)
    return
  try {
    const configs = await window.mdDesktop.ai.getConfigs()
    if (!isUnmounted && !hasUserEdited)
      applyLoadedConfig(configs.webSearch)
  }
  catch {
    // Ignore when bridge config read fails on teardown.
  }
})

onBeforeUnmount(() => {
  isUnmounted = true
})

function markEdited() {
  hasUserEdited = true
  testError.value = ``
  testResult.value = ``
}

function onProtocolChange(next: string) {
  markEdited()
  protocol.value = next as DesktopWebSearchProtocol
}

function onApiKeyUpdate(next: string) {
  markEdited()
  apiKeyInput.value = next
  if (next.trim())
    clearSavedKey.value = false
}

function markClearSavedKey() {
  markEdited()
  apiKeyInput.value = ``
  clearSavedKey.value = true
}

async function saveConfig() {
  if (!window.mdDesktop?.ai || isSaving.value)
    return

  isSaving.value = true
  try {
    const updated = await window.mdDesktop.ai.updateWebSearchConfig({
      enabled: enabled.value,
      protocol: protocol.value,
      baseUrl: baseUrl.value.trim(),
      ...(clearSavedKey.value
        ? { apiKey: `` }
        : (apiKeyInput.value.trim() ? { apiKey: apiKeyInput.value.trim() } : {})),
      model: model.value.trim(),
    })
    applyLoadedConfig(updated)
    toast.success(t(`common.saveSuccess`))
  }
  catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
  finally {
    isSaving.value = false
  }
}

async function runTestSearch() {
  if (!window.mdDesktop?.ai || isTesting.value)
    return
  if (!effectiveHasKey.value || !baseUrl.value.trim() || !model.value.trim()) {
    toast.error(t(`agent.webSearch.configRequired`))
    return
  }

  isTesting.value = true
  testError.value = ``
  testResult.value = ``
  try {
    const result = await window.mdDesktop.ai.testWebSearch({
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKeyInput.value.trim() || undefined,
      model: model.value.trim(),
    })
    if (isUnmounted)
      return
    if (!result.ok) {
      testError.value = result.error || t(`agent.webSearch.testFailed`)
      return
    }
    testResult.value = t(`agent.webSearch.testSuccess`, { count: result.sourceCount ?? 0 })
  }
  finally {
    if (!isUnmounted)
      isTesting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="web-search-settings">
    <div
      class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
      style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
    >
      <Info class="mt-0.5 size-3.5 shrink-0" style="color: var(--dt-ink3)" />
      <span>{{ t('agent.webSearch.sharedNote') }}</span>
    </div>

    <div class="space-y-1">
      <div class="flex items-center justify-between gap-4 border-b py-3" style="border-color: var(--dt-line)">
        <Label for="web-search-enabled">{{ t('agent.webSearch.enabledLabel') }}</Label>
        <Switch
          id="web-search-enabled"
          v-model="enabled"
          data-testid="web-search-enabled"
          class="shrink-0"
          @update:model-value="markEdited"
        />
      </div>

      <div class="flex items-center justify-between gap-4 border-b py-3" style="border-color: var(--dt-line)">
        <div class="min-w-0 space-y-0.5">
          <Label>{{ t('agent.webSearch.protocolLabel') }}</Label>
          <p class="text-xs" style="color: var(--dt-ink3)">
            {{ t('agent.webSearch.protocolHint') }}
          </p>
        </div>
        <PanelSelect
          :model-value="protocol"
          :options="protocolOptions"
          trigger-class="w-[180px]"
          @update:model-value="onProtocolChange"
        />
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium" style="color: var(--dt-ink2)">
          {{ t('agent.modelApi.baseUrlLabel') }}
        </span>
        <input
          v-model="baseUrl"
          type="text"
          autocomplete="off"
          data-testid="web-search-base-url"
          :placeholder="DEFAULT_BASE_URL"
          class="h-9 w-full rounded-lg px-3 text-[13.5px] outline-none"
          style="
            background-color: var(--dt-surface);
            border: 1px solid var(--dt-line);
            color: var(--dt-ink);
            font-family: var(--dt-mono);
          "
          @input="markEdited"
        >
      </label>

      <AiSecretKeyInput
        :model-value="apiKeyInput"
        :has-saved-key="hasSavedKey"
        :clear-saved-key="clearSavedKey"
        input-test-id="web-search-api-key"
        saved-badge-test-id="web-search-key-saved"
        @update:model-value="onApiKeyUpdate"
        @clear-key="markClearSavedKey"
      />

      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium" style="color: var(--dt-ink2)">
          {{ t('agent.webSearch.modelLabel') }}
        </span>
        <input
          v-model="model"
          type="text"
          autocomplete="off"
          data-testid="web-search-model"
          :placeholder="DEFAULT_MODEL"
          class="h-9 w-full rounded-lg px-3 text-[13.5px] outline-none"
          style="
            background-color: var(--dt-surface);
            border: 1px solid var(--dt-line);
            color: var(--dt-ink);
            font-family: var(--dt-mono);
          "
          @input="markEdited"
        >
      </label>
    </div>

    <div
      v-if="testError"
      data-testid="web-search-test-error"
      class="rounded-lg px-3 py-2 text-xs break-words"
      style="background-color: var(--dt-red-soft); color: var(--dt-red)"
    >
      {{ testError }}
    </div>

    <div
      v-if="testResult"
      data-testid="web-search-test-result"
      class="rounded-lg px-3 py-2 text-xs"
      style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
    >
      {{ testResult }}
    </div>

    <div class="flex items-center justify-between gap-3 pt-1">
      <button
        type="button"
        data-testid="web-search-test"
        :disabled="isTesting"
        class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:opacity-50"
        style="background-color: var(--dt-surface); color: var(--dt-ink); border: 1px solid var(--dt-line)"
        @click="runTestSearch"
      >
        <Loader2 v-if="isTesting" class="size-3.5 animate-spin" />
        <Search v-else class="size-3.5" />
        <span>{{ isTesting ? t('agent.webSearch.testing') : t('agent.webSearch.testSearch') }}</span>
      </button>

      <button
        type="button"
        data-testid="web-search-save"
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
