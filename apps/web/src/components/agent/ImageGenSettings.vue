<script setup lang="ts">
import type { DesktopImageGenConfig } from '@md/shared/types'
import { Info, Loader2, Sparkles } from '@lucide/vue'
import { imageServiceOptions } from '@md/shared/configs/ai-service-options'
import { DEFAULT_IMAGE_GEN_QUALITIES, DEFAULT_IMAGE_GEN_SIZES } from '@md/shared/types'
import PanelSelect from '@/components/shared/panel-dialog/PanelSelect.vue'
import { Label } from '@/components/ui/label'
import AiSecretKeyInput from './AiSecretKeyInput.vue'

const { t, locale } = useI18n()

const imagePresets = imageServiceOptions.filter(option => option.value !== `default`)

const providerPreset = ref(`openai`)
const baseUrl = ref(`https://api.openai.com/v1`)
const hasSavedKey = ref(false)
const apiKeyInput = ref(``)
const clearSavedKey = ref(false)
const model = ref(`gpt-image-1`)
const size = ref(`1024x1024`)
const quality = ref(`auto`)

const isSaving = ref(false)
const isTesting = ref(false)
const testError = ref(``)
const testPreviewUrl = ref(``)

const presetOptions = computed(() => {
  void locale.value
  return imagePresets.map(option => ({
    value: option.value,
    label: option.value === `custom` ? t(`agent.modelApi.customProvider`) : option.label,
  }))
})

const currentPresetModels = computed(() => {
  const found = imagePresets.find(p => p.value === providerPreset.value)
  return found?.models ?? []
})

const sizeOptions = computed(() =>
  DEFAULT_IMAGE_GEN_SIZES.map(value => ({ value, label: value })),
)

const qualityOptions = computed(() => {
  void locale.value
  return DEFAULT_IMAGE_GEN_QUALITIES.map(value => ({
    value,
    label: t(`agent.imageGen.qualities.${value}`),
  }))
})

const effectiveHasKey = computed(() =>
  Boolean(apiKeyInput.value.trim()) || (hasSavedKey.value && !clearSavedKey.value),
)

function applyLoadedConfig(cfg: DesktopImageGenConfig) {
  providerPreset.value = cfg.providerPreset || `openai`
  baseUrl.value = cfg.baseUrl || `https://api.openai.com/v1`
  hasSavedKey.value = cfg.hasApiKey
  apiKeyInput.value = ``
  clearSavedKey.value = false
  model.value = cfg.model || `gpt-image-1`
  size.value = cfg.size || `1024x1024`
  quality.value = cfg.quality || `auto`
}

onMounted(async () => {
  if (!window.mdDesktop?.ai)
    return
  const configs = await window.mdDesktop.ai.getConfigs()
  applyLoadedConfig(configs.imageGen)
})

function onPresetChange(nextPreset: string) {
  const prevPreset = imagePresets.find(p => p.value === providerPreset.value)
  providerPreset.value = nextPreset
  const found = imagePresets.find(p => p.value === nextPreset)
  if (found?.endpoint)
    baseUrl.value = found.endpoint.replace(/\/+$/, ``)
  if (found?.models.length && (!model.value.trim() || prevPreset?.models.includes(model.value.trim())))
    model.value = found.models[0]
  testError.value = ``
}

function onBaseUrlInput() {
  const normalized = baseUrl.value.trim().replace(/\/+$/, ``)
  const matched = imagePresets.find(p => p.endpoint && p.endpoint.replace(/\/+$/, ``) === normalized)
  providerPreset.value = matched ? matched.value : `custom`
}

function onApiKeyUpdate(next: string) {
  apiKeyInput.value = next
  if (next.trim())
    clearSavedKey.value = false
}

function markClearSavedKey() {
  apiKeyInput.value = ``
  clearSavedKey.value = true
}

async function saveConfig() {
  if (!window.mdDesktop?.ai || isSaving.value)
    return

  isSaving.value = true
  try {
    const updated = await window.mdDesktop.ai.updateImageGenConfig({
      providerPreset: providerPreset.value,
      baseUrl: baseUrl.value.trim(),
      ...(clearSavedKey.value
        ? { apiKey: `` }
        : (apiKeyInput.value.trim() ? { apiKey: apiKeyInput.value.trim() } : {})),
      model: model.value.trim(),
      size: size.value,
      quality: quality.value,
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

async function runTestGeneration() {
  if (!window.mdDesktop?.ai || isTesting.value)
    return
  if (!effectiveHasKey.value || !baseUrl.value.trim() || !model.value.trim()) {
    toast.error(t(`agent.imageGen.configRequired`))
    return
  }

  isTesting.value = true
  testError.value = ``
  testPreviewUrl.value = ``
  try {
    const result = await window.mdDesktop.ai.testImageGen({
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKeyInput.value.trim() || undefined,
      model: model.value.trim(),
      size: size.value,
      quality: quality.value,
    })
    if (!result.ok || !result.dataUrl) {
      testError.value = result.error || t(`agent.imageGen.testFailed`)
      return
    }
    testPreviewUrl.value = result.dataUrl
    toast.success(t(`agent.imageGen.testSuccess`))
  }
  finally {
    isTesting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="image-gen-settings">
    <div
      class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
      style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
    >
      <Info class="mt-0.5 size-3.5 shrink-0" style="color: var(--dt-ink3)" />
      <span>{{ t('agent.imageGen.sharedNote') }}</span>
    </div>

    <div class="space-y-1">
      <div class="flex items-center justify-between gap-4 border-b py-3" style="border-color: var(--dt-line)">
        <div class="min-w-0 space-y-0.5">
          <Label>{{ t('agent.modelApi.providerPresetLabel') }}</Label>
          <p class="text-xs" style="color: var(--dt-ink3)">
            {{ t('agent.imageGen.protocolHint') }}
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

    <div class="flex flex-col gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium" style="color: var(--dt-ink2)">
          {{ t('agent.modelApi.baseUrlLabel') }}
        </span>
        <input
          v-model="baseUrl"
          type="text"
          autocomplete="off"
          data-testid="image-gen-base-url"
          placeholder="https://api.openai.com/v1"
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

      <AiSecretKeyInput
        :model-value="apiKeyInput"
        :has-saved-key="hasSavedKey"
        :clear-saved-key="clearSavedKey"
        input-test-id="image-gen-api-key"
        saved-badge-test-id="image-gen-key-saved"
        @update:model-value="onApiKeyUpdate"
        @clear-key="markClearSavedKey"
      />

      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium" style="color: var(--dt-ink2)">
          {{ t('agent.imageGen.modelLabel') }}
        </span>
        <input
          v-model="model"
          type="text"
          autocomplete="off"
          data-testid="image-gen-model"
          placeholder="gpt-image-1"
          class="h-9 w-full rounded-lg px-3 text-[13.5px] outline-none"
          style="
            background-color: var(--dt-surface);
            border: 1px solid var(--dt-line);
            color: var(--dt-ink);
            font-family: var(--dt-mono);
          "
        >
        <div v-if="currentPresetModels.length > 0" class="flex flex-wrap gap-1.5 pt-0.5">
          <button
            v-for="presetModel in currentPresetModels.slice(0, 6)"
            :key="presetModel"
            type="button"
            class="cursor-pointer rounded-md px-2 py-0.5 text-[11px] transition-opacity hover:opacity-85"
            :style="{
              backgroundColor: model === presetModel ? 'var(--dt-ink)' : 'var(--dt-subtle)',
              color: model === presetModel ? 'var(--dt-on-ink)' : 'var(--dt-ink2)',
              fontFamily: 'var(--dt-mono)',
            }"
            @click="model = presetModel"
          >
            {{ presetModel }}
          </button>
        </div>
      </div>
    </div>

    <div class="space-y-1">
      <div class="flex items-center justify-between gap-4 border-b py-3" style="border-color: var(--dt-line)">
        <Label>{{ t('agent.imageGen.sizeLabel') }}</Label>
        <PanelSelect
          :model-value="size"
          :options="sizeOptions"
          trigger-class="w-[180px]"
          @update:model-value="size = $event"
        />
      </div>

      <div class="flex items-center justify-between gap-4 py-3">
        <Label>{{ t('agent.imageGen.qualityLabel') }}</Label>
        <PanelSelect
          :model-value="quality"
          :options="qualityOptions"
          trigger-class="w-[180px]"
          @update:model-value="quality = $event"
        />
      </div>
    </div>

    <div
      v-if="testError"
      data-testid="image-gen-test-error"
      class="rounded-lg px-3 py-2 text-xs"
      style="background-color: var(--dt-red-soft); color: var(--dt-red)"
    >
      {{ testError }}
    </div>

    <div
      v-if="testPreviewUrl"
      data-testid="image-gen-test-preview"
      class="flex flex-col gap-2 rounded-xl p-3"
      style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
    >
      <div class="text-xs font-medium" style="color: var(--dt-ink2)">
        {{ t('agent.imageGen.testPreviewTitle') }}
      </div>
      <img
        :src="testPreviewUrl"
        alt="Generated preview"
        class="max-h-[260px] w-auto self-start rounded-lg object-contain"
        style="border: 1px solid var(--dt-line)"
      >
    </div>

    <div class="flex items-center justify-between gap-3 pt-1">
      <button
        type="button"
        data-testid="image-gen-test"
        :disabled="isTesting"
        class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:opacity-50"
        style="background-color: var(--dt-surface); color: var(--dt-ink); border: 1px solid var(--dt-line)"
        @click="runTestGeneration"
      >
        <Loader2 v-if="isTesting" class="size-3.5 animate-spin" />
        <Sparkles v-else class="size-3.5" />
        <span>{{ isTesting ? t('agent.imageGen.testing') : t('agent.imageGen.testGenerate') }}</span>
      </button>

      <button
        type="button"
        data-testid="image-gen-save"
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
