<script setup lang="ts">
import type { DesktopPickedFile } from '@md/shared/types'
import { ArrowUp, Paperclip, X } from '@lucide/vue'
import AgentModelPicker from './AgentModelPicker.vue'
import AgentPermissionPicker from './AgentPermissionPicker.vue'

const props = withDefaults(defineProps<{
  running?: boolean
  disabled?: boolean
  placeholder?: string
  menuPlacement?: `up` | `down`
  size?: `panel` | `hero`
}>(), {
  running: false,
  disabled: false,
  menuPlacement: `up`,
  size: `panel`,
})

const emit = defineEmits<{
  send: [payload: { text: string, attachments: string[] }]
  stop: []
}>()

const { t } = useI18n()

const text = ref(``)
const attachments = ref<DesktopPickedFile[]>([])
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const canSend = computed(() => !props.disabled && text.value.trim().length > 0)

function submit() {
  if (!canSend.value)
    return
  emit(`send`, {
    text: text.value.trim(),
    attachments: attachments.value.map(a => a.path),
  })
  text.value = ``
  attachments.value = []
}

function handleKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229)
    return
  if (event.key === `Enter` && !event.shiftKey) {
    event.preventDefault()
    if (!props.running)
      submit()
  }
}

async function pickAttachments() {
  if (props.disabled || !window.mdDesktop)
    return
  const picked = await window.mdDesktop.pickFiles()
  if (picked.length === 0)
    return
  const seen = new Set(attachments.value.map(a => a.path))
  for (const file of picked) {
    if (!seen.has(file.path)) {
      attachments.value.push(file)
      seen.add(file.path)
    }
  }
}

function removeAttachment(filePath: string) {
  attachments.value = attachments.value.filter(a => a.path !== filePath)
}

function focus() {
  textareaRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div
    class="flex w-full flex-col gap-2"
    :class="size === 'hero' ? 'rounded-2xl p-3.5' : 'rounded-[14px] p-2.5'"
    style="
      background-color: var(--dt-surface);
      border: 1px solid var(--dt-line);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);
    "
  >
    <div v-if="attachments.length > 0" class="flex flex-wrap gap-1.5 px-1">
      <span
        v-for="file in attachments"
        :key="file.path"
        class="inline-flex max-w-[200px] items-center gap-1 rounded-md px-2 py-0.5 text-xs"
        style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
      >
        <span class="truncate">{{ file.name }}</span>
        <button
          type="button"
          class="cursor-pointer opacity-70 hover:opacity-100"
          :aria-label="t('agent.composer.removeAttachment')"
          @click="removeAttachment(file.path)"
        >
          <X class="size-3" />
        </button>
      </span>
    </div>

    <textarea
      ref="textareaRef"
      v-model="text"
      :disabled="disabled"
      :rows="size === 'hero' ? 3 : 2"
      :placeholder="placeholder ?? t('agent.composer.placeholder')"
      class="w-full resize-none border-0 bg-transparent px-1 pt-0.5 outline-none placeholder:opacity-70 disabled:cursor-not-allowed"
      :class="size === 'hero' ? 'min-h-[64px] text-[15px] leading-[25px]' : 'min-h-[44px] text-[13.5px] leading-[22px]'"
      style="color: var(--dt-ink)"
      @keydown="handleKeydown"
    />

    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-0.5">
        <AgentModelPicker :placement="menuPlacement" :disabled="disabled" />
        <AgentPermissionPicker :placement="menuPlacement" :disabled="disabled" />
        <button
          type="button"
          :disabled="disabled"
          :title="t('agent.composer.attachFile')"
          :aria-label="t('agent.composer.attachFile')"
          class="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg transition-colors hover:opacity-80 disabled:opacity-40"
          style="color: var(--dt-ink3)"
          @click="pickAttachments"
        >
          <Paperclip class="size-[15px]" />
        </button>
      </div>

      <button
        v-if="running"
        type="button"
        :title="t('agent.composer.stop')"
        :aria-label="t('agent.composer.stop')"
        class="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg transition-opacity hover:opacity-90"
        style="background-color: var(--dt-ink)"
        @click="emit('stop')"
      >
        <span class="size-[9px] rounded-[2px]" style="background-color: var(--dt-on-ink)" />
      </button>

      <button
        v-else
        type="button"
        :disabled="!canSend"
        :title="t('agent.composer.send')"
        :aria-label="t('agent.composer.send')"
        class="inline-flex cursor-pointer items-center justify-center transition-opacity disabled:cursor-not-allowed"
        :class="size === 'hero' ? 'size-8 rounded-[9px]' : 'size-7 rounded-lg'"
        :style="{
          backgroundColor: canSend ? 'var(--dt-accent)' : 'var(--dt-subtle)',
          color: canSend ? '#FFFFFF' : 'var(--dt-ink3)',
        }"
        @click="submit"
      >
        <ArrowUp :class="size === 'hero' ? 'size-[17px]' : 'size-[15px]'" />
      </button>
    </div>
  </div>
</template>
