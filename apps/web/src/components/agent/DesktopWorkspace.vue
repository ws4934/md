<script setup lang="ts">
import type { DesktopLayoutWidths } from '@/lib/agent/desktop-layout'
import { LoaderCircle, ShieldAlert } from '@lucide/vue'
import { ctrlSign } from '@md/shared/configs'
import { defineAsyncComponent, unref } from 'vue'
import EditorPanel from '@/components/editor/EditorPanel.vue'
import PreviewPanel from '@/components/editor/PreviewPanel.vue'
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useAgentPanelHotkey } from '@/composables/useAgentPanelHotkey'
import { useCursorSync } from '@/composables/useCursorSync'
import { useDesktopSidebarHotkey } from '@/composables/useDesktopSidebarHotkey'
import { useEditorRefresh } from '@/composables/useEditorRefresh'
import { useScrollSync } from '@/composables/useScrollSync'
import { copyWeChatHtmlToClipboard } from '@/lib/agent/copy-wechat-html'
import {
  computeEditorMinPercent,
  computeMainMinPercent,
  DESKTOP_LAYOUT_LIMITS,
} from '@/lib/agent/desktop-layout'
import { clampGoToLineValue, jumpToLine } from '@/lib/markdown/headingNavigation'
import { useAgentStore } from '@/stores/agent'
import { useThemeStore } from '@/stores/theme'
import { useUIStore } from '@/stores/ui'
import AgentAvatar from './AgentAvatar.vue'
import AgentPanel from './AgentPanel.vue'
import DesktopPublishDialog from './DesktopPublishDialog.vue'
import DesktopSidebar from './DesktopSidebar.vue'
import DesktopSplitHandle from './DesktopSplitHandle.vue'
import DesktopToolbar from './DesktopToolbar.vue'
import NewArticlePrompt from './NewArticlePrompt.vue'
import './desktop-theme.css'

const RightSlider = defineAsyncComponent(() => import('@/components/editor/RightSlider.vue'))
const PreferencesDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/PreferencesDialog.vue'))
const UploadImgDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/UploadImgDialog.vue'))
const TableEditDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/TableEditDialog.vue'))
const ImportMarkdownDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/ImportMarkdownDialog.vue'))
const LocalImageUploadDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/LocalImageUploadDialog.vue'))
const FormulaEditorDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/FormulaEditorDialog.vue'))
const TemplateDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/TemplateDialog.vue'))
const CustomComponentDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/CustomComponentDialog.vue'))
const MarketplaceDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/MarketplaceDialog.vue'))
const PdfExportDialog = defineAsyncComponent(() => import('@/components/editor/dialogs/PdfExportDialog.vue'))
const KeyboardShortcutsDialog = defineAsyncComponent(() => import('@/components/editor/editor-header/KeyboardShortcutsDialog.vue'))
const MarkdownHelpDialog = defineAsyncComponent(() => import('@/components/editor/editor-header/MarkdownHelpDialog.vue'))
const AboutDialog = defineAsyncComponent(() => import('@/components/editor/editor-header/AboutDialog.vue'))

const { t } = useI18n()
const uiStore = useUIStore()
const agentStore = useAgentStore()
const themeStore = useThemeStore()
const { editorRefresh } = useEditorRefresh()
useAgentPanelHotkey()
useDesktopSidebarHotkey()

const {
  viewMode,
  enableScrollSync,
  isOpenRightSlider,
  isShowPreferencesDialog,
  isShowUploadImgDialog,
  isShowTableEditDialog,
  isShowImportMdDialog,
  isShowLocalImageUpload,
  isShowFormulaEditorDialog,
  isShowTemplateDialog,
  isShowComponentDialog,
  isShowMarketplaceDialog,
  isShowPdfExportDialog,
  isShowKeyboardShortcutsDialog,
  isShowMarkdownHelpDialog,
  isShowAboutDialog,
} = storeToRefs(uiStore)

const {
  isPanelOpen,
  isSidebarOpen,
  layoutWidths,
  isNewArticleHero,
  isCurrentPostWriting,
  isCurrentSessionRunning,
  isWaitingPermission,
  selectedAgent,
  currentActivityLabel,
} = storeToRefs(agentStore)

const showAgentPanel = computed(() => !isNewArticleHero.value && isPanelOpen.value)
const showCollapsedMiniPill = computed(
  () => !isPanelOpen.value && (isCurrentSessionRunning.value || isWaitingPermission.value),
)

const expandShortcutLabel = `${ctrlSign}J`

const editorPanelCompRef = ref<InstanceType<typeof EditorPanel> | null>(null)
const previewPanelCompRef = ref<InstanceType<typeof PreviewPanel> | null>(null)

const getEditorView = () => editorPanelCompRef.value?.codeMirrorView ?? null
const getPreviewContainer = () => previewPanelCompRef.value?.previewRef ?? null

const { handlePreviewContentClick } = useCursorSync(getEditorView)
useScrollSync(getEditorView, getPreviewContainer, enableScrollSync)

// Resizable splitter refs & pixel-constraint tracking
type ResizablePanelRef = Ref<InstanceType<typeof ResizablePanel> | null>

const outerContainerRef = ref<HTMLElement | null>(null)
const innerContainerRef = ref<HTMLElement | null>(null)
const sidebarPanelRef = ref<InstanceType<typeof ResizablePanel> | null>(null)
const agentPanelRef = ref<InstanceType<typeof ResizablePanel> | null>(null)
const editorPanelRef = ref<InstanceType<typeof ResizablePanel> | null>(null)
const previewPanelRef = ref<InstanceType<typeof ResizablePanel> | null>(null)

const outerContainerWidth = ref<number>(typeof window !== `undefined` ? window.innerWidth : 1440)
const innerContainerWidth = ref<number>(Math.max(640, outerContainerWidth.value - 648))

const activeDragPanels = ref<Set<keyof DesktopLayoutWidths>>(new Set())
const keyboardResizingPanel = ref<keyof DesktopLayoutWidths | null>(null)
let keyboardResizeTimer: ReturnType<typeof setTimeout> | null = null
const isDraggingDivider = computed(() => activeDragPanels.value.size > 0)

let isSyncingOuter = false
let isSyncingInner = false
const pendingWidthSaves: Partial<DesktopLayoutWidths> = {}
let widthSaveTimer: ReturnType<typeof setTimeout> | null = null

const mainMinPercent = computed(() => computeMainMinPercent({
  containerWidth: outerContainerWidth.value,
  isSidebarOpen: isSidebarOpen.value,
  isAgentOpen: showAgentPanel.value,
  viewMode: viewMode.value,
  isNewArticleHero: isNewArticleHero.value,
}))

const editorMinPercent = computed(() => computeEditorMinPercent({
  containerWidth: innerContainerWidth.value,
  viewMode: viewMode.value,
}))

function flushPendingWidthSaves() {
  if (widthSaveTimer) {
    clearTimeout(widthSaveTimer)
    widthSaveTimer = null
  }
  const keys = Object.keys(pendingWidthSaves) as Array<keyof DesktopLayoutWidths>
  for (const key of keys) {
    const val = pendingWidthSaves[key]
    delete pendingWidthSaves[key]
    if (typeof val === `number`)
      agentStore.setLayoutWidth(key, val)
  }
}

function scheduleWidthSave(panel: keyof DesktopLayoutWidths, sizePx: number) {
  pendingWidthSaves[panel] = sizePx
  if (widthSaveTimer)
    clearTimeout(widthSaveTimer)
  widthSaveTimer = setTimeout(flushPendingWidthSaves, 120)
}

function resizePanelSafely(panelRef: ResizablePanelRef, size: number) {
  requestAnimationFrame(() => {
    try {
      const panel = panelRef.value
      if (!panel || Math.abs(panel.getSize() - size) < 0.5)
        return
      panel.resize(size)
    }
    catch {
      // Panel may not be registered yet during initial mount; props still drive defaults.
    }
  })
}

function syncOuterLayout() {
  isSyncingOuter = true
  requestAnimationFrame(() => {
    try {
      sidebarPanelRef.value?.resize(isSidebarOpen.value ? layoutWidths.value.sidebar : 0)
    }
    catch {}
    try {
      agentPanelRef.value?.resize(showAgentPanel.value ? layoutWidths.value.agent : 0)
    }
    catch {}
    requestAnimationFrame(() => {
      isSyncingOuter = false
    })
  })
}

function syncInnerLayout() {
  isSyncingInner = true
  requestAnimationFrame(() => {
    const mode = viewMode.value
    try {
      if (mode === `edit`) {
        editorPanelRef.value?.resize(100)
        previewPanelRef.value?.resize(0)
      }
      else if (mode === `preview`) {
        editorPanelRef.value?.resize(0)
        previewPanelRef.value?.resize(100)
      }
      else {
        previewPanelRef.value?.resize(layoutWidths.value.preview)
      }
    }
    catch {}
    requestAnimationFrame(() => {
      isSyncingInner = false
    })
  })
}

function isUserResizingPanel(panel: keyof DesktopLayoutWidths): boolean {
  return activeDragPanels.value.has(panel) || keyboardResizingPanel.value === panel
}

function onHandleKeyboardResize(panel: keyof DesktopLayoutWidths) {
  keyboardResizingPanel.value = panel
  if (keyboardResizeTimer)
    clearTimeout(keyboardResizeTimer)
  keyboardResizeTimer = setTimeout(() => {
    keyboardResizingPanel.value = null
    keyboardResizeTimer = null
  }, 180)
}

function onSidebarResize(sizePx: number) {
  if (isSyncingOuter || !isSidebarOpen.value || !isUserResizingPanel(`sidebar`))
    return
  if (sizePx < DESKTOP_LAYOUT_LIMITS.sidebar.min - 2)
    return
  scheduleWidthSave(`sidebar`, sizePx)
}

function onAgentResize(sizePx: number) {
  if (isSyncingOuter || !showAgentPanel.value || !isUserResizingPanel(`agent`))
    return
  if (sizePx < DESKTOP_LAYOUT_LIMITS.agent.min - 2)
    return
  scheduleWidthSave(`agent`, sizePx)
}

function onPreviewResize(size: number) {
  if (isSyncingInner || viewMode.value !== `split` || !isUserResizingPanel(`preview`))
    return
  if (size < DESKTOP_LAYOUT_LIMITS.preview.min - 2)
    return
  scheduleWidthSave(`preview`, size)
}

function onHandleDragging(panel: keyof DesktopLayoutWidths, active: boolean) {
  const next = new Set(activeDragPanels.value)
  if (active) {
    next.add(panel)
    activeDragPanels.value = next
  }
  else if (next.delete(panel)) {
    activeDragPanels.value = next
    if (next.size === 0)
      flushPendingWidthSaves()
  }
}

function clearDraggingPanel(panel: keyof DesktopLayoutWidths) {
  if (activeDragPanels.value.has(panel))
    onHandleDragging(panel, false)
}

function resetSplit(panel: keyof DesktopLayoutWidths) {
  flushPendingWidthSaves()
  const fallback = agentStore.resetLayoutWidth(panel)
  if (panel === `sidebar` && isSidebarOpen.value)
    resizePanelSafely(sidebarPanelRef, fallback)
  else if (panel === `agent` && showAgentPanel.value)
    resizePanelSafely(agentPanelRef, fallback)
  else if (panel === `preview` && viewMode.value === `split`)
    resizePanelSafely(previewPanelRef, fallback)
}

watch([isSidebarOpen, showAgentPanel], ([sidebarOpen, agentOpen]) => {
  if (!sidebarOpen)
    clearDraggingPanel(`sidebar`)
  if (!agentOpen)
    clearDraggingPanel(`agent`)
  flushPendingWidthSaves()
  syncOuterLayout()
})

watch(viewMode, (mode) => {
  if (mode !== `split`)
    clearDraggingPanel(`preview`)
  flushPendingWidthSaves()
  syncInnerLayout()
})

watch(isNewArticleHero, (hero) => {
  if (hero)
    clearDraggingPanel(`preview`)
  else
    nextTick(() => syncInnerLayout())
})

let outerObserver: ResizeObserver | null = null
let innerObserver: ResizeObserver | null = null

function observeInnerContainer(el: HTMLElement | null) {
  innerObserver?.disconnect()
  innerObserver = null
  if (!el || typeof ResizeObserver === `undefined`)
    return
  innerContainerWidth.value = el.getBoundingClientRect().width || innerContainerWidth.value
  innerObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width
    if (width && width > 0)
      innerContainerWidth.value = width
  })
  innerObserver.observe(el)
}

watch(innerContainerRef, el => observeInnerContainer(el))

const backLight = ref(false)
const isCoping = ref(false)
const isShowPublishDialog = ref(false)
let copyEndTimer: ReturnType<typeof setTimeout> | null = null

const isGoToLineActive = ref(false)
const goToLineInput = ref(``)
const goToLineInputRef = ref<HTMLInputElement | null>(null)

function openGoToLine() {
  const view = getEditorView()
  if (!view || isNewArticleHero.value)
    return
  const line = view.state.doc.lineAt(view.state.selection.main.head).number
  goToLineInput.value = String(line)
  isGoToLineActive.value = true
  nextTick(() => goToLineInputRef.value?.select())
}

function submitGoToLine() {
  const view = getEditorView()
  if (view) {
    const target = clampGoToLineValue(goToLineInput.value, view.state.doc.lines)
    jumpToLine(view, target)
    view.focus()
  }
  isGoToLineActive.value = false
}

function cancelGoToLine() {
  isGoToLineActive.value = false
  getEditorView()?.focus()
}

async function copyWeChatFromCommandPalette() {
  if (isCoping.value)
    return
  if (isNewArticleHero.value) {
    toast.error(t(`agent.publish.errors.emptyContent`))
    return
  }
  await copyWeChatHtmlToClipboard({
    primaryColor: themeStore.primaryColor,
    delayMs: 100,
    onStart: startCopy,
    onEnd: endCopy,
    onRefresh: () => editorRefresh(),
  })
}

watch(() => uiStore.copyRequest, (tick) => {
  if (!tick)
    return
  void copyWeChatFromCommandPalette()
})

watch(() => uiStore.goToLineRequest, (tick) => {
  if (!tick)
    return
  openGoToLine()
})

function startCopy() {
  backLight.value = true
  isCoping.value = true
}

function endCopy() {
  backLight.value = false
  if (copyEndTimer)
    clearTimeout(copyEndTimer)
  copyEndTimer = setTimeout(() => {
    isCoping.value = false
    copyEndTimer = null
  }, 600)
}

function handleUploadImage(file: File, cb?: any, applyUrl?: boolean) {
  editorPanelCompRef.value?.uploadImage(file, cb, applyUrl)
}

function handleHeroSend(payload: { text: string, attachments: string[] }) {
  void agentStore.sendPrompt(payload.text, payload.attachments)
}

const isImgLoading = computed(() => unref(editorPanelCompRef.value?.isImgLoading) ?? false)

onMounted(() => {
  void agentStore.init()
  if (outerContainerRef.value && typeof ResizeObserver !== `undefined`) {
    outerContainerWidth.value = outerContainerRef.value.getBoundingClientRect().width || outerContainerWidth.value
    outerObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width && width > 0)
        outerContainerWidth.value = width
    })
    outerObserver.observe(outerContainerRef.value)
  }
  observeInnerContainer(innerContainerRef.value)
  syncOuterLayout()
  syncInnerLayout()
})

onUnmounted(() => {
  flushPendingWidthSaves()
  outerObserver?.disconnect()
  innerObserver?.disconnect()
  if (keyboardResizeTimer) {
    clearTimeout(keyboardResizeTimer)
    keyboardResizeTimer = null
  }
  if (copyEndTimer) {
    clearTimeout(copyEndTimer)
    copyEndTimer = null
  }
})
</script>

<template>
  <div
    ref="outerContainerRef"
    class="flex h-screen w-screen overflow-hidden"
    :class="{ 'desktop-is-dragging': isDraggingDivider }"
    style="background-color: var(--dt-canvas); color: var(--dt-ink)"
  >
    <Progress
      v-if="isImgLoading"
      indeterminate
      class="absolute left-0 right-0 top-0 z-50 rounded-none"
      style="height: 2px;"
    />

    <ResizablePanelGroup direction="horizontal" class="h-full w-full">
      <!-- Left sidebar: documents only (200–360px, default 248px, collapsible) -->
      <ResizablePanel
        ref="sidebarPanelRef"
        :order="1"
        size-unit="px"
        :default-size="isSidebarOpen ? layoutWidths.sidebar : 0"
        :min-size="isSidebarOpen ? DESKTOP_LAYOUT_LIMITS.sidebar.min : 0"
        :max-size="isSidebarOpen ? DESKTOP_LAYOUT_LIMITS.sidebar.max : 0"
        data-testid="sidebar-resizable-panel"
        :data-collapsed="!isSidebarOpen ? 'true' : 'false'"
        :aria-hidden="!isSidebarOpen"
        class="h-full overflow-hidden"
        :class="{ 'desktop-sidebar-panel-transition': !isDraggingDivider }"
        @resize="onSidebarResize"
      >
        <DesktopSidebar />
      </ResizablePanel>

      <DesktopSplitHandle
        v-show="isSidebarOpen"
        :disabled="!isSidebarOpen"
        test-id="split-handle-sidebar"
        @dragging="(active) => onHandleDragging('sidebar', active)"
        @keyboard-resize="onHandleKeyboardResize('sidebar')"
        @reset="resetSplit('sidebar')"
      />

      <!-- Center column: New article hero OR Editor + Preview workspace -->
      <ResizablePanel
        :order="2"
        :min-size="mainMinPercent"
        class="h-full min-w-0 overflow-hidden"
      >
        <!-- New article hero prompt (Screen 03) -->
        <main v-if="isNewArticleHero" class="flex h-full w-full flex-col overflow-hidden">
          <NewArticlePrompt
            @send="handleHeroSend"
            @skip="isNewArticleHero = false"
          />
        </main>

        <!-- Main editing workspace (Screens 01, 02, 05, 08) -->
        <main v-else class="relative flex h-full w-full flex-col overflow-hidden">
          <DesktopToolbar @open-publish="isShowPublishDialog = true" />

          <div class="flex min-h-0 flex-1 overflow-hidden">
            <div ref="innerContainerRef" class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <ResizablePanelGroup direction="horizontal" class="h-full w-full">
                <!-- Editor pane (min 320px in split mode) -->
                <ResizablePanel
                  ref="editorPanelRef"
                  :order="1"
                  :default-size="viewMode === 'preview' ? 0 : viewMode === 'edit' ? 100 : undefined"
                  :min-size="editorMinPercent"
                  :max-size="viewMode === 'preview' ? 0 : 100"
                  data-testid="editor-resizable-panel"
                  class="desktop-editor-host relative flex h-full min-w-0 flex-col overflow-hidden"
                >
                  <!-- Subtle accent stripe while Agent is actively writing -->
                  <div
                    v-if="isCurrentPostWriting"
                    class="pointer-events-none absolute bottom-6 left-4 top-4 z-10 w-0.5 rounded-full"
                    style="background-color: var(--dt-accent)"
                  />

                  <!-- Floating Go-to-Line bar triggered by Mod-G / command palette -->
                  <form
                    v-if="isGoToLineActive"
                    data-testid="desktop-goto-line"
                    class="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg px-2.5 py-1.5 shadow-lg"
                    style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
                    @submit.prevent="submitGoToLine"
                  >
                    <span class="text-xs font-medium" style="color: var(--dt-ink2)">
                      {{ t('footer.goToLine') }}
                    </span>
                    <input
                      ref="goToLineInputRef"
                      v-model="goToLineInput"
                      type="text"
                      inputmode="numeric"
                      class="h-6 w-20 rounded px-2 text-xs outline-none"
                      style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line); color: var(--dt-ink); font-family: var(--dt-mono)"
                      @keydown.escape.prevent="cancelGoToLine"
                      @blur="isGoToLineActive = false"
                    >
                  </form>

                  <div class="min-h-0 flex-1 overflow-hidden">
                    <EditorPanel ref="editorPanelCompRef" />
                  </div>
                </ResizablePanel>

                <DesktopSplitHandle
                  v-show="viewMode === 'split'"
                  :disabled="viewMode !== 'split'"
                  test-id="split-handle-preview"
                  @dragging="(active) => onHandleDragging('preview', active)"
                  @keyboard-resize="onHandleKeyboardResize('preview')"
                  @reset="resetSplit('preview')"
                />

                <!-- WeChat preview pane (320–720px in split mode, default 400px; 100% in preview mode) -->
                <ResizablePanel
                  ref="previewPanelRef"
                  :order="2"
                  :size-unit="viewMode === 'split' ? 'px' : '%'"
                  :default-size="viewMode === 'edit' ? 0 : viewMode === 'preview' ? 100 : layoutWidths.preview"
                  :min-size="viewMode === 'split' ? DESKTOP_LAYOUT_LIMITS.preview.min : viewMode === 'preview' ? 100 : 0"
                  :max-size="viewMode === 'split' ? DESKTOP_LAYOUT_LIMITS.preview.max : viewMode === 'preview' ? 100 : 0"
                  data-testid="preview-resizable-panel"
                  class="desktop-preview-host h-full min-h-0 overflow-hidden"
                  @resize="onPreviewResize"
                >
                  <PreviewPanel
                    ref="previewPanelCompRef"
                    :back-light="backLight"
                    :is-coping="isCoping"
                    :on-content-click="handlePreviewContentClick"
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>

            <!-- Optional theme / style drawer -->
            <div
              v-if="isOpenRightSlider"
              class="h-full w-[320px] shrink-0 overflow-hidden"
              style="border-left: 1px solid var(--dt-line); background-color: var(--dt-surface)"
            >
              <RightSlider />
            </div>
          </div>

          <!-- Floating mini status pill while panel is collapsed and agent is active or waiting -->
          <button
            v-if="showCollapsedMiniPill"
            type="button"
            data-testid="collapsed-agent-pill"
            class="absolute bottom-5 left-1/2 z-30 flex h-9 -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full pl-2 pr-3 transition-transform hover:scale-[1.01]"
            :style="isWaitingPermission
              ? {
                backgroundColor: 'var(--dt-amber-soft)',
                border: '1px solid var(--dt-amber-line)',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.09)',
              }
              : {
                backgroundColor: 'var(--dt-surface)',
                border: '1px solid var(--dt-line)',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.09)',
              }"
            @click="agentStore.setPanelOpen(true)"
          >
            <AgentAvatar v-if="selectedAgent" :avatar="selectedAgent.avatar" :size="20" />
            <ShieldAlert
              v-if="isWaitingPermission"
              class="size-3.5 shrink-0"
              style="color: var(--dt-amber)"
            />
            <span
              class="max-w-[240px] truncate text-[12.5px] font-medium"
              :style="{ color: isWaitingPermission ? 'var(--dt-amber)' : 'var(--dt-ink)' }"
            >
              {{ isWaitingPermission ? t('agent.panel.waitingPermissionPill') : currentActivityLabel }}
            </span>
            <LoaderCircle
              v-if="!isWaitingPermission"
              class="size-3.5 shrink-0 animate-spin"
              style="color: var(--dt-accent)"
            />
            <span
              class="h-3.5 w-px shrink-0"
              :style="{ backgroundColor: isWaitingPermission ? 'var(--dt-amber-line)' : 'var(--dt-line)' }"
            />
            <span
              class="shrink-0 text-xs"
              :style="{ color: isWaitingPermission ? 'var(--dt-amber)' : 'var(--dt-ink3)' }"
            >
              {{ t('agent.panel.expandShortcut', { shortcut: expandShortcutLabel }) }}
            </span>
          </button>
        </main>
      </ResizablePanel>

      <DesktopSplitHandle
        v-show="showAgentPanel"
        :disabled="!showAgentPanel"
        test-id="split-handle-agent"
        @dragging="(active) => onHandleDragging('agent', active)"
        @keyboard-resize="onHandleKeyboardResize('agent')"
        @reset="resetSplit('agent')"
      />

      <!-- Right Agent panel (320–640px, default 400px); kept mounted so sessions & scroll survive collapse -->
      <ResizablePanel
        ref="agentPanelRef"
        :order="3"
        size-unit="px"
        :default-size="showAgentPanel ? layoutWidths.agent : 0"
        :min-size="showAgentPanel ? DESKTOP_LAYOUT_LIMITS.agent.min : 0"
        :max-size="showAgentPanel ? DESKTOP_LAYOUT_LIMITS.agent.max : 0"
        data-testid="agent-resizable-panel"
        :data-collapsed="!showAgentPanel ? 'true' : 'false'"
        :aria-hidden="!showAgentPanel"
        class="h-full overflow-hidden"
        @resize="onAgentResize"
      >
        <AgentPanel v-show="showAgentPanel" />
      </ResizablePanel>
    </ResizablePanelGroup>

    <!-- Dialogs -->
    <DesktopPublishDialog
      v-model:open="isShowPublishDialog"
      @start-copy="startCopy"
      @end-copy="endCopy"
    />
    <PreferencesDialog v-model:open="isShowPreferencesDialog" />
    <UploadImgDialog v-if="isShowUploadImgDialog" @upload-image="handleUploadImage" />
    <TableEditDialog v-if="isShowTableEditDialog" />
    <ImportMarkdownDialog v-if="isShowImportMdDialog" />
    <LocalImageUploadDialog v-if="isShowLocalImageUpload" />
    <FormulaEditorDialog v-if="isShowFormulaEditorDialog" />
    <TemplateDialog v-if="isShowTemplateDialog" />
    <CustomComponentDialog v-if="isShowComponentDialog" />
    <MarketplaceDialog v-if="isShowMarketplaceDialog" />
    <PdfExportDialog v-if="isShowPdfExportDialog" v-model:open="isShowPdfExportDialog" />
    <KeyboardShortcutsDialog v-if="isShowKeyboardShortcutsDialog" v-model:open="isShowKeyboardShortcutsDialog" />
    <MarkdownHelpDialog v-if="isShowMarkdownHelpDialog" v-model:open="isShowMarkdownHelpDialog" />
    <AboutDialog v-if="isShowAboutDialog" v-model:open="isShowAboutDialog" />
  </div>
</template>
