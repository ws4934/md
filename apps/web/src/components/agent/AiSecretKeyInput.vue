<script setup lang="ts">
import { Check, Eye, EyeOff, Trash2 } from '@lucide/vue'

defineProps<{
  modelValue: string
  hasSavedKey: boolean
  clearSavedKey: boolean
  inputTestId: string
  savedBadgeTestId: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'clearKey': []
}>()

const { t } = useI18n()
const showKey = ref(false)

function onInput(event: Event) {
  emit(`update:modelValue`, (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium" style="color: var(--dt-ink2)">
        {{ t('agent.modelApi.apiKeyLabel') }}
      </span>
      <div v-if="hasSavedKey && !clearSavedKey" class="flex items-center gap-2">
        <span
          :data-testid="savedBadgeTestId"
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
          @click="emit('clearKey')"
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
        :value="modelValue"
        :type="showKey ? 'text' : 'password'"
        autocomplete="off"
        :data-testid="inputTestId"
        :placeholder="hasSavedKey && !clearSavedKey
          ? t('agent.modelApi.apiKeySavedPlaceholder')
          : t('agent.modelApi.apiKeyPlaceholder')"
        class="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
        style="color: var(--dt-ink); font-family: var(--dt-mono)"
        @input="onInput"
      >
      <button
        type="button"
        :aria-label="showKey ? t('agent.modelApi.hideKey') : t('agent.modelApi.showKey')"
        class="ml-2 cursor-pointer"
        style="color: var(--dt-ink3)"
        @click="showKey = !showKey"
      >
        <EyeOff v-if="showKey" class="size-4" />
        <Eye v-else class="size-4" />
      </button>
    </div>
  </div>
</template>
