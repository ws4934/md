<script setup lang="ts">
import type { DesktopWebSearchConfig, DesktopWebSearchProtocol, DesktopWebSearchProvider } from '@md/shared/types'
import { ChevronDown, ChevronUp, Info, Loader2, Pencil, Plus, Search, Trash2 } from '@lucide/vue'
import { DESKTOP_WEB_SEARCH_PROTOCOLS, MAX_WEB_SEARCH_PROVIDERS } from '@md/shared/types'
import PanelSelect from '@/components/shared/panel-dialog/PanelSelect.vue'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import AiSecretKeyInput from './AiSecretKeyInput.vue'

const { t } = useI18n()

const DEFAULT_BASE_URL = `https://api.openai.com/v1`
const DEFAULT_MODEL = `gpt-5-mini`

interface ProviderDraft {
  /** Local v-for key; `id` is only known once the provider has been saved. */
  key: string
  id?: string
  name: string
  enabled: boolean
  protocol: DesktopWebSearchProtocol
  baseUrl: string
  hasSavedKey: boolean
  apiKeyInput: string
  clearSavedKey: boolean
  model: string
  isTesting: boolean
  testError: string
  testResult: string
}

const enabled = ref(false)
const providers = ref<ProviderDraft[]>([])
const editingKey = ref<string | null>(null)

const isSaving = ref(false)
let isUnmounted = false
let hasUserEdited = false
let draftCounter = 0

const PROTOCOL_LABELS: Record<DesktopWebSearchProtocol, string> = {
  'openai-responses': `OpenAI Responses`,
}

const protocolOptions = DESKTOP_WEB_SEARCH_PROTOCOLS.map(value => ({ value, label: PROTOCOL_LABELS[value] }))

const inputClass = `h-9 w-full rounded-lg px-3 text-[13.5px] outline-none`
const inputStyle = `background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink);`
const iconButtonClass = `inline-flex size-7 cursor-pointer items-center justify-center rounded-md transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30`

function toDraft(p?: DesktopWebSearchProvider): ProviderDraft {
  return {
    key: `draft-${draftCounter++}`,
    id: p?.id,
    name: p?.name ?? ``,
    enabled: p?.enabled ?? true,
    protocol: p?.protocol ?? `openai-responses`,
    baseUrl: p ? p.baseUrl : DEFAULT_BASE_URL,
    hasSavedKey: p?.hasApiKey ?? false,
    apiKeyInput: ``,
    clearSavedKey: false,
    model: p ? p.model : DEFAULT_MODEL,
    isTesting: false,
    testError: ``,
    testResult: ``,
  }
}

function providerTitle(p: ProviderDraft): string {
  if (p.name.trim())
    return p.name.trim()
  try {
    return new URL(p.baseUrl.trim()).host
  }
  catch {
    return t(`agent.webSearch.untitledProvider`)
  }
}

function applyLoadedConfig(cfg: DesktopWebSearchConfig) {
  // Saving returns the list in the same order, so keep the open form by position.
  const editingIndex = providers.value.findIndex(p => p.key === editingKey.value)
  enabled.value = cfg.enabled
  providers.value = cfg.providers.map(toDraft)
  editingKey.value = providers.value[editingIndex]?.key ?? null
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

function markEdited(p?: ProviderDraft) {
  hasUserEdited = true
  if (p) {
    p.testError = ``
    p.testResult = ``
  }
}

function onProtocolChange(p: ProviderDraft, next: string) {
  markEdited(p)
  p.protocol = next as DesktopWebSearchProtocol
}

function onApiKeyUpdate(p: ProviderDraft, next: string) {
  markEdited(p)
  p.apiKeyInput = next
  if (next.trim())
    p.clearSavedKey = false
}

function markClearSavedKey(p: ProviderDraft) {
  markEdited(p)
  p.apiKeyInput = ``
  p.clearSavedKey = true
}

function toggleEditing(p: ProviderDraft) {
  editingKey.value = editingKey.value === p.key ? null : p.key
}

function addProvider() {
  if (providers.value.length >= MAX_WEB_SEARCH_PROVIDERS)
    return
  markEdited()
  const draft = toDraft()
  providers.value.push(draft)
  editingKey.value = draft.key
}

function moveProvider(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= providers.value.length)
    return
  markEdited()
  const list = providers.value
  ;[list[index], list[target]] = [list[target], list[index]]
}

function removeProvider(index: number) {
  markEdited()
  const [removed] = providers.value.splice(index, 1)
  if (removed?.key === editingKey.value)
    editingKey.value = null
}

async function saveConfig() {
  if (!window.mdDesktop?.ai || isSaving.value)
    return

  isSaving.value = true
  try {
    const updated = await window.mdDesktop.ai.updateWebSearchConfig({
      enabled: enabled.value,
      providers: providers.value.map(p => ({
        ...(p.id ? { id: p.id } : {}),
        name: p.name.trim(),
        enabled: p.enabled,
        protocol: p.protocol,
        baseUrl: p.baseUrl.trim(),
        ...(p.clearSavedKey
          ? { apiKey: `` }
          : (p.apiKeyInput.trim() ? { apiKey: p.apiKeyInput.trim() } : {})),
        model: p.model.trim(),
      })),
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

async function runTestSearch(p: ProviderDraft) {
  if (!window.mdDesktop?.ai || p.isTesting)
    return
  const hasKey = Boolean(p.apiKeyInput.trim()) || (p.hasSavedKey && !p.clearSavedKey)
  if (!hasKey || !p.baseUrl.trim() || !p.model.trim()) {
    toast.error(t(`agent.webSearch.configRequired`))
    return
  }

  p.isTesting = true
  p.testError = ``
  p.testResult = ``
  try {
    const result = await window.mdDesktop.ai.testWebSearch({
      providerId: p.id,
      baseUrl: p.baseUrl.trim(),
      apiKey: p.apiKeyInput.trim() || undefined,
      model: p.model.trim(),
    })
    if (isUnmounted)
      return
    if (!result.ok) {
      p.testError = result.error || t(`agent.webSearch.testFailed`)
      return
    }
    p.testResult = t(`agent.webSearch.testSuccess`, { count: result.sourceCount ?? 0 })
  }
  finally {
    p.isTesting = false
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

    <div class="flex items-center justify-between gap-4 border-b py-3" style="border-color: var(--dt-line)">
      <Label for="web-search-enabled">{{ t('agent.webSearch.enabledLabel') }}</Label>
      <Switch
        id="web-search-enabled"
        v-model="enabled"
        data-testid="web-search-enabled"
        class="shrink-0"
        @update:model-value="markEdited()"
      />
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex items-end justify-between gap-4">
        <div class="min-w-0 space-y-0.5">
          <Label>{{ t('agent.webSearch.providersLabel') }}</Label>
          <p class="text-xs leading-relaxed" style="color: var(--dt-ink3)">
            {{ t('agent.webSearch.providersHint', { max: MAX_WEB_SEARCH_PROVIDERS }) }}
          </p>
        </div>
        <button
          type="button"
          data-testid="web-search-add-provider"
          :disabled="providers.length >= MAX_WEB_SEARCH_PROVIDERS"
          class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
          style="background-color: var(--dt-canvas); color: var(--dt-ink); border: 1px solid var(--dt-line)"
          @click="addProvider"
        >
          <Plus class="size-3" />
          <span>{{ t('agent.webSearch.addProvider') }}</span>
        </button>
      </div>

      <p
        v-if="providers.length === 0"
        class="rounded-xl px-6 py-6 text-center text-xs leading-relaxed"
        style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink2)"
      >
        {{ t('agent.webSearch.noProviders') }}
      </p>

      <div
        v-for="(p, index) in providers"
        :key="p.key"
        data-testid="web-search-provider"
        class="flex flex-col rounded-xl"
        style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
      >
        <div class="flex items-center gap-2 px-3 py-2.5">
          <span
            class="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold"
            style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
          >
            {{ index + 1 }}
          </span>
          <div class="min-w-0 flex-1">
            <div class="truncate text-[13.5px] font-medium" style="color: var(--dt-ink)">
              {{ providerTitle(p) }}
            </div>
            <div v-if="p.model" class="truncate text-xs" style="color: var(--dt-ink3); font-family: var(--dt-mono)">
              {{ p.model }}
            </div>
          </div>
          <button
            type="button"
            :class="iconButtonClass"
            style="color: var(--dt-ink2)"
            :disabled="index === 0"
            :aria-label="t('agent.webSearch.moveUp')"
            :title="t('agent.webSearch.moveUp')"
            @click="moveProvider(index, -1)"
          >
            <ChevronUp class="size-4" />
          </button>
          <button
            type="button"
            :class="iconButtonClass"
            style="color: var(--dt-ink2)"
            :disabled="index === providers.length - 1"
            :aria-label="t('agent.webSearch.moveDown')"
            :title="t('agent.webSearch.moveDown')"
            @click="moveProvider(index, 1)"
          >
            <ChevronDown class="size-4" />
          </button>
          <button
            type="button"
            data-testid="web-search-edit-provider"
            :class="iconButtonClass"
            :style="{ color: editingKey === p.key ? 'var(--dt-ink)' : 'var(--dt-ink2)' }"
            :aria-expanded="editingKey === p.key"
            :aria-label="t('agent.webSearch.editProvider')"
            :title="t('agent.webSearch.editProvider')"
            @click="toggleEditing(p)"
          >
            <Pencil class="size-3.5" />
          </button>
          <button
            type="button"
            data-testid="web-search-remove-provider"
            :class="iconButtonClass"
            style="color: var(--dt-red)"
            :aria-label="t('agent.webSearch.removeProvider')"
            :title="t('agent.webSearch.removeProvider')"
            @click="removeProvider(index)"
          >
            <Trash2 class="size-3.5" />
          </button>
          <Switch
            v-model="p.enabled"
            data-testid="web-search-provider-enabled"
            class="ml-1 shrink-0"
            :aria-label="t('agent.webSearch.providerEnabled', { name: providerTitle(p) })"
            @update:model-value="markEdited(p)"
          />
        </div>

        <div
          v-if="editingKey === p.key"
          class="flex flex-col gap-3 border-t px-3 py-3"
          style="border-color: var(--dt-line)"
        >
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium" style="color: var(--dt-ink2)">
              {{ t('agent.webSearch.nameLabel') }}
            </span>
            <input
              v-model="p.name"
              type="text"
              autocomplete="off"
              maxlength="64"
              data-testid="web-search-name"
              :placeholder="providerTitle({ ...p, name: '' })"
              :class="inputClass"
              :style="inputStyle"
              @input="markEdited(p)"
            >
          </label>

          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0 space-y-0.5">
              <Label>{{ t('agent.webSearch.protocolLabel') }}</Label>
              <p class="text-xs" style="color: var(--dt-ink3)">
                {{ t('agent.webSearch.protocolHint') }}
              </p>
            </div>
            <PanelSelect
              :model-value="p.protocol"
              :options="protocolOptions"
              trigger-class="w-[180px]"
              @update:model-value="(next: string) => onProtocolChange(p, next)"
            />
          </div>

          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium" style="color: var(--dt-ink2)">
              {{ t('agent.modelApi.baseUrlLabel') }}
            </span>
            <input
              v-model="p.baseUrl"
              type="text"
              autocomplete="off"
              data-testid="web-search-base-url"
              :placeholder="DEFAULT_BASE_URL"
              :class="inputClass"
              :style="`${inputStyle} font-family: var(--dt-mono);`"
              @input="markEdited(p)"
            >
          </label>

          <AiSecretKeyInput
            :model-value="p.apiKeyInput"
            :has-saved-key="p.hasSavedKey"
            :clear-saved-key="p.clearSavedKey"
            input-test-id="web-search-api-key"
            saved-badge-test-id="web-search-key-saved"
            @update:model-value="(next: string) => onApiKeyUpdate(p, next)"
            @clear-key="markClearSavedKey(p)"
          />

          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium" style="color: var(--dt-ink2)">
              {{ t('agent.webSearch.modelLabel') }}
            </span>
            <input
              v-model="p.model"
              type="text"
              autocomplete="off"
              data-testid="web-search-model"
              :placeholder="DEFAULT_MODEL"
              :class="inputClass"
              :style="`${inputStyle} font-family: var(--dt-mono);`"
              @input="markEdited(p)"
            >
          </label>

          <div
            v-if="p.testError"
            data-testid="web-search-test-error"
            class="rounded-lg px-3 py-2 text-xs break-words"
            style="background-color: var(--dt-red-soft); color: var(--dt-red)"
          >
            {{ p.testError }}
          </div>

          <div
            v-if="p.testResult"
            data-testid="web-search-test-result"
            class="rounded-lg px-3 py-2 text-xs"
            style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
          >
            {{ p.testResult }}
          </div>

          <div>
            <button
              type="button"
              data-testid="web-search-test"
              :disabled="p.isTesting"
              class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:opacity-50"
              style="background-color: var(--dt-canvas); color: var(--dt-ink); border: 1px solid var(--dt-line)"
              @click="runTestSearch(p)"
            >
              <Loader2 v-if="p.isTesting" class="size-3.5 animate-spin" />
              <Search v-else class="size-3.5" />
              <span>{{ p.isTesting ? t('agent.webSearch.testing') : t('agent.webSearch.testSearch') }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="flex items-center justify-end gap-3 pt-1">
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
