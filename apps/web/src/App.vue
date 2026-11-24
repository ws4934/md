<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import CodemirrorEditor from '@/components/editor/CodemirrorEditor.vue'
import CommandPalette from '@/components/editor/dialogs/CommandPalette.vue'
import ConfirmDialog from '@/components/shared/confirm-dialog/ConfirmDialog.vue'
import { Toaster } from '@/components/ui/sonner'
import { useCommandPaletteHotkey } from '@/composables/useCommandPaletteHotkey'
import { usePreferencesHotkey } from '@/composables/usePreferencesHotkey'
import { useUIStore } from '@/stores/ui'

const DesktopWorkspace = defineAsyncComponent(() => import('@/components/agent/DesktopWorkspace.vue'))

const uiStore = useUIStore()
const { isDark } = storeToRefs(uiStore)
const isDesktop = Boolean(window.mdDesktop?.isDesktop)

usePlatformEnv()
useAccountSyncBootstrap()
useDeepLinkImport()
useCommandPaletteHotkey()
usePreferencesHotkey()
</script>

<template>
  <DesktopWorkspace v-if="isDesktop" />
  <CodemirrorEditor v-else />

  <CommandPalette />

  <ConfirmDialog />

  <Toaster
    rich-colors
    position="top-center"
    :duration="1200"
    :visible-toasts="1"
    :theme="isDark ? 'dark' : 'light'"
  />
</template>
