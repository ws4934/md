<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import ConfirmDialog from '@/components/shared/confirm-dialog/ConfirmDialog.vue'
import { Toaster } from '@/components/ui/sonner'
import { useCommandPaletteHotkey } from '@/composables/useCommandPaletteHotkey'
import { usePreferencesHotkey } from '@/composables/usePreferencesHotkey'
import { useUIStore } from '@/stores/ui'

const DesktopWorkspace = defineAsyncComponent(() => import('@/components/agent/DesktopWorkspace.vue'))
const CodemirrorEditor = defineAsyncComponent(() => import('@/components/editor/CodemirrorEditor.vue'))
const CommandPalette = defineAsyncComponent(() => import('@/components/editor/dialogs/CommandPalette.vue'))

const uiStore = useUIStore()
const { isDark, isShowCommandPalette } = storeToRefs(uiStore)
const isDesktop = Boolean(window.mdDesktop?.isDesktop)
const hasMountedCommandPalette = ref(isShowCommandPalette.value)

watch(isShowCommandPalette, (open) => {
  if (open)
    hasMountedCommandPalette.value = true
})

usePlatformEnv()
useAccountSyncBootstrap()
useDeepLinkImport()
useCommandPaletteHotkey()
usePreferencesHotkey()
</script>

<template>
  <DesktopWorkspace v-if="isDesktop" />
  <CodemirrorEditor v-else />

  <CommandPalette v-if="hasMountedCommandPalette || isShowCommandPalette" />

  <ConfirmDialog />

  <Toaster
    rich-colors
    position="top-center"
    :duration="1200"
    :visible-toasts="1"
    :theme="isDark ? 'dark' : 'light'"
  />
</template>
