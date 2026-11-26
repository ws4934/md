<script setup lang="ts">
import { renderChatMarkdown } from '@md/core/utils'
import { copyPlain } from '@/lib/browser/clipboard'
import { isAllowedExternalHref } from './agent-ui-helpers'

const props = defineProps<{
  content: string
  streaming?: boolean
}>()

const { t, locale } = useI18n()

const renderedHtml = computed(() => {
  void locale.value
  return renderChatMarkdown(props.content, { copyLabel: t(`agent.chat.copy`) })
})

const copyTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

onBeforeUnmount(() => {
  for (const timer of copyTimers.values())
    clearTimeout(timer)
  copyTimers.clear()
})

async function handleClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (!target)
    return

  const copyBtn = target.closest<HTMLButtonElement>(`button[data-copy-code="true"]`)
  if (copyBtn) {
    event.preventDefault()
    const block = copyBtn.closest(`.agent-code-block`)
    const codeText = block?.querySelector(`pre code`)?.textContent ?? ``
    if (!codeText)
      return
    try {
      await copyPlain(codeText)
      const prevTimer = copyTimers.get(copyBtn)
      if (prevTimer)
        clearTimeout(prevTimer)
      copyBtn.textContent = t(`agent.chat.copied`)
      copyBtn.dataset.copied = `true`
      copyTimers.set(
        copyBtn,
        setTimeout(() => {
          copyTimers.delete(copyBtn)
          copyBtn.textContent = t(`agent.chat.copy`)
          delete copyBtn.dataset.copied
        }, 1500),
      )
    }
    catch {
      // Ignore clipboard failures.
    }
    return
  }

  const link = target.closest<HTMLAnchorElement>(`a.agent-md-link`)
  if (link) {
    event.preventDefault()
    const rawHref = link.getAttribute(`href`)
    if (!isAllowedExternalHref(rawHref))
      return
    const safeHref = rawHref!.trim()
    if (window.mdDesktop?.openExternal)
      void window.mdDesktop.openExternal(safeHref)
    else
      window.open(safeHref, `_blank`, `noopener,noreferrer`)
  }
}
</script>

<template>
  <!-- eslint-disable vue/no-v-html -->
  <div
    class="agent-markdown min-w-0 break-words"
    :class="{ 'agent-markdown--streaming': streaming }"
    @click="handleClick"
    v-html="renderedHtml"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>
