<script setup lang="ts">
import type { ErrorTimelineItem } from '@/lib/agent/timeline-blocks'
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy } from '@lucide/vue'
import { summarizeErrorGroup } from '@/lib/agent/timeline-blocks'
import { copyPlain } from '@/lib/browser/clipboard'

const props = defineProps<{
  items: ErrorTimelineItem[]
}>()

const { t, locale } = useI18n()
const copiedIp = ref(false)
const expanded = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

const summary = computed(() => summarizeErrorGroup(props.items))

const titleText = computed(() => {
  void locale.value
  if (summary.value.affectedPaths.length > 1)
    return t(`agent.chat.imagesUploadFailedCount`, { count: summary.value.affectedPaths.length })
  if (summary.value.affectedPaths.length === 1)
    return t(`agent.chat.imageUploadFailedTitle`)
  return ``
})

const friendlySummary = computed(() => {
  void locale.value
  if (summary.value.whitelistIp)
    return t(`agent.publish.errors.ipNotWhitelistedWithIp`, { ip: summary.value.whitelistIp })
  return summary.value.sharedMessage ?? summary.value.messages[0] ?? ``
})

const hasRawDetails = computed(() => {
  if (summary.value.messages.length > 1 && !summary.value.sharedMessage)
    return true
  if (summary.value.whitelistIp && summary.value.sharedMessage)
    return true
  return (summary.value.sharedMessage?.length ?? 0) > 120
})

async function copyIp(ip: string) {
  try {
    await copyPlain(ip)
    copiedIp.value = true
    if (copyTimer)
      clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copiedIp.value = false
    }, 1500)
  }
  catch {
    // Ignore clipboard errors.
  }
}

onBeforeUnmount(() => {
  if (copyTimer)
    clearTimeout(copyTimer)
})
</script>

<template>
  <div
    class="flex w-full flex-col gap-1.5 rounded-[10px] px-3 py-2.5 text-[12px] leading-[18px]"
    style="
      background-color: var(--dt-canvas);
      border: 1px solid var(--dt-line);
      color: var(--dt-ink2);
    "
  >
    <!-- Header row: subtle red indicator, concise title, inline Copy IP pill, optional expand toggle -->
    <div class="flex flex-wrap items-center gap-1.5">
      <AlertCircle class="size-3.5 shrink-0" style="color: var(--dt-red)" />

      <span
        v-if="titleText"
        class="font-medium"
        style="color: var(--dt-ink)"
      >
        {{ titleText }}
      </span>
      <span
        v-else
        class="min-w-0 flex-1 break-words"
        style="color: var(--dt-ink)"
      >
        {{ friendlySummary }}
      </span>

      <button
        v-if="summary.whitelistIp"
        type="button"
        class="ml-auto inline-flex h-[22px] shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors hover:bg-[var(--dt-subtle)]"
        style="
          background-color: var(--dt-surface);
          color: var(--dt-ink);
          border: 1px solid var(--dt-line);
        "
        @click="copyIp(summary.whitelistIp)"
      >
        <Check v-if="copiedIp" class="size-3" style="color: var(--dt-green)" />
        <Copy v-else class="size-3" style="color: var(--dt-ink3)" />
        <span>{{ copiedIp ? t('agent.publish.ipCopied') : t('agent.chat.copyIp', { ip: summary.whitelistIp }) }}</span>
      </button>

      <button
        v-if="hasRawDetails"
        type="button"
        class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-[var(--dt-subtle)]"
        :class="summary.whitelistIp ? '' : 'ml-auto'"
        style="color: var(--dt-ink3)"
        :aria-label="expanded ? t('common.collapse') : t('common.expand')"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <component :is="expanded ? ChevronDown : ChevronRight" class="size-3.5" />
      </button>
    </div>

    <!-- Compact affected file chips -->
    <div v-if="summary.affectedPaths.length > 0" class="flex flex-wrap gap-1 pl-5">
      <span
        v-for="filePath in summary.affectedPaths"
        :key="filePath"
        class="rounded px-1.5 py-px text-[11px]"
        style="
          background-color: var(--dt-subtle);
          color: var(--dt-ink2);
          font-family: var(--dt-mono);
        "
      >
        {{ filePath }}
      </span>
    </div>

    <!-- Concise localized explanation when title is shown -->
    <p
      v-if="titleText && friendlySummary"
      class="pl-5 text-[11.5px] leading-[17px]"
      :class="expanded ? '' : 'line-clamp-2'"
      style="color: var(--dt-ink2)"
    >
      {{ friendlySummary }}
    </p>

    <!-- Collapsible raw technical error details -->
    <div
      v-if="expanded && hasRawDetails"
      class="ml-5 mt-0.5 flex flex-col gap-1 rounded-md px-2.5 py-1.5 text-[11px] leading-[16px] break-words"
      style="
        background-color: var(--dt-surface);
        border: 1px solid var(--dt-line);
        color: var(--dt-ink3);
        font-family: var(--dt-mono);
      "
    >
      <div v-for="(msg, idx) in summary.messages" :key="`${idx}-${msg.slice(0, 32)}`">
        {{ msg }}
      </div>
    </div>
  </div>
</template>
