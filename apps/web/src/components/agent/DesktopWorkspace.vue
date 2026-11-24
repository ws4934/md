<script setup lang="ts">
import { LoaderCircle, ShieldAlert } from '@lucide/vue'
import { ctrlSign } from '@md/shared/configs'
import { defineAsyncComponent, unref } from 'vue'
import EditorPanel from '@/components/editor/EditorPanel.vue'
import PreviewPanel from '@/components/editor/PreviewPanel.vue'
import { useAgentPanelHotkey } from '@/composables/useAgentPanelHotkey'
import { useCursorSync } from '@/composables/useCursorSync'
import { useScrollSync } from '@/composables/useScrollSync'
import { useAgentStore } from '@/stores/agent'
import { useUIStore } from '@/stores/ui'
import AgentAvatar from './AgentAvatar.vue'
import AgentPanel from './AgentPanel.vue'
import DesktopPublishDialog from './DesktopPublishDialog.vue'
import DesktopSidebar from './DesktopSidebar.vue'
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
useAgentPanelHotkey()

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
  isNewArticleHero,
  isCurrentPostWriting,
  isCurrentSessionRunning,
  isWaitingPermission,
  selectedAgent,
  currentActivityLabel,
} = storeToRefs(agentStore)

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

const backLight = ref(false)
const isCoping = ref(false)
const isShowPublishDialog = ref(false)
let copyEndTimer: ReturnType<typeof setTimeout> | null = null

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
})

onUnmounted(() => {
  if (copyEndTimer) {
    clearTimeout(copyEndTimer)
    copyEndTimer = null
  }
})
</script>

<template>
  <div
    class="flex h-screen w-screen overflow-hidden"
    style="background-color: var(--dt-canvas); color: var(--dt-ink)"
  >
    <Progress
      v-if="isImgLoading"
      indeterminate
      class="absolute left-0 right-0 top-0 z-50 rounded-none"
      style="height: 2px;"
    />

    <!-- Left sidebar: documents only -->
    <DesktopSidebar />

    <!-- New article hero prompt (Screen 03) -->
    <main v-if="isNewArticleHero" class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <NewArticlePrompt
        @send="handleHeroSend"
        @skip="isNewArticleHero = false"
      />
    </main>

    <!-- Main editing workspace (Screens 01, 02, 05, 08) -->
    <template v-else>
      <main class="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <DesktopToolbar @open-publish="isShowPublishDialog = true" />

        <div class="flex min-h-0 flex-1 overflow-hidden">
          <!-- Editor pane -->
          <div
            v-show="viewMode !== 'preview'"
            class="desktop-editor-host relative flex min-w-0 flex-1 flex-col overflow-hidden"
          >
            <!-- Subtle accent stripe while Agent is actively writing -->
            <div
              v-if="isCurrentPostWriting"
              class="pointer-events-none absolute bottom-6 left-4 top-4 z-10 w-0.5 rounded-full"
              style="background-color: var(--dt-accent)"
            />

            <div class="min-h-0 flex-1 overflow-hidden">
              <EditorPanel ref="editorPanelCompRef" />
            </div>
          </div>

          <!-- WeChat preview pane -->
          <div
            v-show="viewMode !== 'edit'"
            class="desktop-preview-host min-h-0 shrink-0 overflow-hidden"
            :class="viewMode === 'preview' ? 'flex-1' : 'w-[400px]'"
            style="border-left: 1px solid var(--dt-line)"
          >
            <PreviewPanel
              ref="previewPanelCompRef"
              :back-light="backLight"
              :is-coping="isCoping"
              :on-content-click="handlePreviewContentClick"
            />
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

      <!-- Right Agent panel (400px); kept mounted with v-show so scroll & composer state survive collapse -->
      <AgentPanel v-show="isPanelOpen" />
    </template>

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
