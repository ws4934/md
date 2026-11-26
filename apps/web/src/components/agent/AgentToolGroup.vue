<script setup lang="ts">
import type { ToolCallTimelineItem, ToolVisualCategory } from '@/lib/agent/timeline-blocks'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from '@lucide/vue'
import { describeToolCall, summarizeToolGroup } from '@/lib/agent/timeline-blocks'

const props = defineProps<{
  items: ToolCallTimelineItem[]
  hasRunning: boolean
  hasFailed: boolean
  failedCount: number
  followedByContent: boolean
  acpSessionId?: string | null
}>()

const { t, locale } = useI18n()

const userExpanded = ref<boolean | null>(null)
const expandedRowIds = ref<Set<string>>(new Set())
const imagePreviews = ref<Record<string, string>>({})
const loadingImages = new Set<string>()
const createdObjectUrls: string[] = []
let isUnmounted = false

const isExpanded = computed(() => {
  if (userExpanded.value !== null)
    return userExpanded.value
  if (props.hasRunning || props.hasFailed)
    return true
  // Keep a single completed step compactly visible while it is still at the tail of the timeline;
  // collapse multi-step groups or completed steps once assistant text follows.
  if (props.followedByContent)
    return false
  return props.items.length <= 2
})

const describedItems = computed(() =>
  props.items.map(entry => ({
    entry,
    described: describeToolCall(entry.tool),
  })),
)

const breakdown = computed(() => summarizeToolGroup(props.items))

function iconForCategory(category: ToolVisualCategory) {
  switch (category) {
    case `read`:
      return FileText
    case `execute`:
      return Terminal
    case `search`:
      return Search
    case `fetch`:
      return Globe
    case `image`:
      return ImageIcon
    case `steps`:
      return ListChecks
    case `subagent`:
      return Sparkles
    default:
      return Wrench
  }
}

function verbForCategory(category: ToolVisualCategory, running: boolean): string {
  void locale.value
  const key = running ? `agent.tools.running.${category}` : `agent.tools.done.${category}`
  return t(key)
}

const activeItem = computed(() => {
  for (let i = describedItems.value.length - 1; i >= 0; i--) {
    const status = describedItems.value[i].entry.tool.status
    if (status === `in_progress` || status === `pending`)
      return describedItems.value[i]
  }
  return null
})

const summaryLabel = computed(() => {
  void locale.value
  if (activeItem.value) {
    const verb = verbForCategory(activeItem.value.described.category, true)
    const target = activeItem.value.described.target
    return target ? `${verb} ${target}` : verb
  }

  if (props.items.length === 1) {
    const only = describedItems.value[0]
    const verb = verbForCategory(only.described.category, false)
    return only.described.target ? `${verb} ${only.described.target}` : verb
  }

  const parts: string[] = []
  const b = breakdown.value
  if (b.readCount > 0)
    parts.push(t(`agent.tools.summaryRead`, { count: b.readCount }))
  if (b.searchCount > 0)
    parts.push(t(`agent.tools.summarySearch`, { count: b.searchCount }))
  if (b.executeCount > 0)
    parts.push(t(`agent.tools.summaryExecute`, { count: b.executeCount }))
  if (b.imageCount > 0)
    parts.push(t(`agent.tools.summaryImage`, { count: b.imageCount }))
  if (b.otherCount > 0)
    parts.push(t(`agent.tools.summaryOther`, { count: b.otherCount }))

  if (parts.length > 0 && parts.length <= 2)
    return parts.join(` · `)

  return t(`agent.tools.summarySteps`, { count: b.totalCount })
})

function toggleGroup() {
  userExpanded.value = !isExpanded.value
}

function isRowExpanded(id: string): boolean {
  return expandedRowIds.value.has(id)
}

function toggleRow(id: string, hasDetails: boolean) {
  if (!hasDetails)
    return
  const next = new Set(expandedRowIds.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expandedRowIds.value = next
}

async function loadImagePreviewIfNeeded(toolId: string, workspacePath: string) {
  const sessionId = props.acpSessionId
  if (!sessionId || !window.mdDesktop?.acp?.readWorkspaceImage)
    return
  if (imagePreviews.value[toolId] || loadingImages.has(toolId))
    return

  loadingImages.add(toolId)
  try {
    const img = await window.mdDesktop.acp.readWorkspaceImage({
      sessionId,
      path: workspacePath,
    })
    if (isUnmounted)
      return
    const blob = new Blob([img.data as BlobPart], { type: img.mimeType })
    const url = URL.createObjectURL(blob)
    createdObjectUrls.push(url)
    imagePreviews.value = { ...imagePreviews.value, [toolId]: url }
  }
  catch {
    // Workspace may already be disposed for historical sessions; omit thumbnail gracefully.
  }
  finally {
    loadingImages.delete(toolId)
  }
}

watch(
  [describedItems, () => props.acpSessionId],
  () => {
    for (const { entry, described } of describedItems.value) {
      if (described.workspaceImagePath)
        void loadImagePreviewIfNeeded(entry.tool.id, described.workspaceImagePath)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  isUnmounted = true
  for (const url of createdObjectUrls)
    URL.revokeObjectURL(url)
})
</script>

<template>
  <div class="flex w-full flex-col" data-testid="agent-tool-group">
    <!-- Group summary disclosure header (Cursor style) -->
    <button
      type="button"
      class="group flex min-h-[26px] w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left text-[12.5px] transition-colors hover:opacity-90"
      :aria-expanded="isExpanded"
      @click="toggleGroup"
    >
      <LoaderCircle
        v-if="hasRunning"
        class="size-3.5 shrink-0 animate-spin"
        style="color: var(--dt-accent)"
      />
      <AlertCircle
        v-else-if="hasFailed"
        class="size-3.5 shrink-0"
        style="color: var(--dt-red)"
      />
      <component
        :is="isExpanded ? ChevronDown : ChevronRight"
        v-else
        class="size-3.5 shrink-0 transition-opacity"
        style="color: var(--dt-ink3)"
      />

      <span
        class="min-w-0 truncate"
        :class="hasRunning ? 'agent-thinking-shimmer font-medium' : ''"
        :style="!hasRunning ? { color: hasFailed ? 'var(--dt-ink)' : 'var(--dt-ink2)' } : undefined"
      >
        {{ summaryLabel }}
      </span>

      <span
        v-if="hasFailed"
        class="shrink-0 rounded px-1.5 py-px text-[11px] font-medium"
        style="background-color: var(--dt-red-soft); color: var(--dt-red)"
      >
        {{ t('agent.tools.failedCount', { count: failedCount }) }}
      </span>

      <span
        v-else-if="items.length > 1 && hasRunning"
        class="shrink-0 text-[11px]"
        style="color: var(--dt-ink3)"
      >
        {{ items.length }}
      </span>

      <component
        :is="isExpanded ? ChevronDown : ChevronRight"
        v-if="hasRunning || hasFailed"
        class="ml-auto size-3.5 shrink-0 opacity-60 group-hover:opacity-100"
        style="color: var(--dt-ink3)"
      />
    </button>

    <!-- Expanded vertical step list with subtle Cursor guide line -->
    <div
      v-if="isExpanded"
      class="ml-[6px] mt-1 flex flex-col gap-1 pl-3"
      style="border-left: 1px solid var(--dt-line)"
    >
      <div
        v-for="{ entry, described } in describedItems"
        :key="entry.id"
        class="flex flex-col gap-1"
      >
        <button
          type="button"
          class="group flex min-h-[24px] w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[12px] transition-colors"
          :class="described.hasDetails ? 'cursor-pointer hover:bg-[var(--dt-canvas)]' : 'cursor-default'"
          :aria-expanded="described.hasDetails ? isRowExpanded(entry.id) : undefined"
          @click="toggleRow(entry.id, described.hasDetails)"
        >
          <Check
            v-if="entry.tool.status === 'completed'"
            class="size-3 shrink-0"
            style="color: var(--dt-ink3)"
          />
          <X
            v-else-if="entry.tool.status === 'failed'"
            class="size-3 shrink-0"
            style="color: var(--dt-red)"
          />
          <LoaderCircle
            v-else
            class="size-3 shrink-0 animate-spin"
            style="color: var(--dt-accent)"
          />

          <component
            :is="iconForCategory(described.category)"
            class="size-3 shrink-0"
            :style="{ color: entry.tool.status === 'failed' ? 'var(--dt-red)' : 'var(--dt-ink3)' }"
          />

          <span
            class="shrink-0"
            :style="{
              color: entry.tool.status === 'failed'
                ? 'var(--dt-red)'
                : entry.tool.status === 'in_progress'
                  ? 'var(--dt-accent)'
                  : 'var(--dt-ink2)',
            }"
          >
            {{ verbForCategory(described.category, entry.tool.status === 'in_progress' || entry.tool.status === 'pending') }}
          </span>

          <span
            v-if="described.target"
            class="min-w-0 flex-1 truncate"
            :style="{
              color: entry.tool.status === 'failed' ? 'var(--dt-red)' : 'var(--dt-ink3)',
              fontFamily: described.category === 'read' || described.category === 'execute' || described.category === 'image' ? 'var(--dt-mono)' : undefined,
              fontSize: described.category === 'read' || described.category === 'execute' || described.category === 'image' ? '11.5px' : undefined,
            }"
            :title="entry.tool.command || entry.tool.filePath || entry.tool.title"
          >
            {{ described.target }}
          </span>

          <component
            :is="isRowExpanded(entry.id) ? ChevronDown : ChevronRight"
            v-if="described.hasDetails"
            class="ml-auto size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-80"
            :class="isRowExpanded(entry.id) ? '!opacity-80' : ''"
            style="color: var(--dt-ink3)"
          />
        </button>

        <!-- Always show inline error detail for failed tool calls so root causes are immediately visible -->
        <div
          v-if="entry.tool.status === 'failed' && entry.tool.error"
          class="ml-5 rounded-md px-2.5 py-1.5 text-[11.5px] leading-[18px] break-words"
          style="
            background-color: var(--dt-red-soft);
            color: var(--dt-red);
            font-family: var(--dt-mono);
          "
        >
          {{ entry.tool.error }}
        </div>

        <!-- Inline generated image preview thumbnail -->
        <div
          v-if="imagePreviews[entry.tool.id]"
          class="ml-5 overflow-hidden rounded-lg p-1.5"
          style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
        >
          <img
            :src="imagePreviews[entry.tool.id]"
            :alt="described.target || entry.tool.title"
            class="max-h-[160px] w-auto rounded object-contain"
          >
        </div>

        <!-- Expandable command / output detail box -->
        <div
          v-if="isRowExpanded(entry.id) && (described.expandableCommand || described.expandableOutput || entry.tool.filePath)"
          class="ml-5 flex flex-col gap-1.5 rounded-md px-2.5 py-2 text-[11.5px] leading-[18px]"
          style="
            background-color: var(--dt-canvas);
            border: 1px solid var(--dt-line);
            color: var(--dt-ink2);
            font-family: var(--dt-mono);
          "
        >
          <div v-if="described.expandableCommand" class="break-all">
            <span class="select-none opacity-50">$ </span>{{ described.expandableCommand }}
          </div>
          <div v-else-if="entry.tool.filePath && entry.tool.filePath !== described.target" class="break-all opacity-80">
            {{ entry.tool.filePath }}
          </div>
          <pre
            v-if="described.expandableOutput"
            class="max-h-[160px] overflow-auto whitespace-pre-wrap break-words text-[11px]"
            style="color: var(--dt-ink3)"
          >{{ described.expandableOutput }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
