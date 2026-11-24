<script setup lang="ts">
import AgentComposer from './AgentComposer.vue'

const emit = defineEmits<{
  send: [payload: { text: string, attachments: string[] }]
  skip: []
}>()

const { t } = useI18n()
const composerRef = ref<InstanceType<typeof AgentComposer> | null>(null)

onMounted(() => {
  nextTick(() => composerRef.value?.focus())
})
</script>

<template>
  <div
    class="flex h-full w-full flex-col items-center"
    style="background-color: var(--dt-canvas)"
  >
    <div class="desktop-drag-region h-[52px] w-full shrink-0" />

    <div class="flex w-full max-w-[760px] flex-1 flex-col items-center justify-center px-6 pb-24">
      <h1
        class="text-[28px] font-bold tracking-[-0.02em]"
        style="color: var(--dt-ink)"
      >
        {{ t('agent.newArticle.heading') }}
      </h1>
      <p
        class="mt-3 text-sm"
        style="color: var(--dt-ink3)"
      >
        {{ t('agent.newArticle.subtitle') }}
      </p>

      <div class="mt-7 w-full max-w-[720px]">
        <AgentComposer
          ref="composerRef"
          :placeholder="t('agent.newArticle.placeholder')"
          menu-placement="down"
          size="hero"
          @send="(payload) => emit('send', payload)"
        />
      </div>

      <button
        type="button"
        class="mt-5 cursor-pointer text-xs transition-opacity hover:opacity-80"
        style="color: var(--dt-ink3)"
        @click="emit('skip')"
      >
        {{ t('agent.newArticle.openEditorDirectly') }}
      </button>
    </div>
  </div>
</template>
