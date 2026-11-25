<script setup lang="ts">
import { Settings } from '@lucide/vue'
import { defineAsyncComponent } from 'vue'
import PanelDialog from '@/components/shared/panel-dialog/PanelDialog.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUIStore } from '@/stores/ui'
import PreferencesSection from './PreferencesSection.vue'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const AgentsSettingsTab = defineAsyncComponent(() => import('@/components/agent/AgentsSettingsTab.vue'))

const { t } = useI18n()
const uiStore = useUIStore()

const isDesktop = Boolean(window.mdDesktop?.isDesktop)

const dialogOpen = computed({
  get: () => props.open,
  set: (val: boolean) => emit(`update:open`, val),
})

const { preferencesInitialTab } = storeToRefs(uiStore)

const activeTab = ref(`general`)

watch(dialogOpen, (open) => {
  if (open) {
    const tab = preferencesInitialTab.value
    activeTab.value = tab === `general` || tab === `editor` || tab === `preview` || (tab === `agents` && isDesktop)
      ? tab
      : `general`
  }
  else {
    activeTab.value = `general`
    preferencesInitialTab.value = `general`
  }
})
</script>

<template>
  <PanelDialog
    v-model:open="dialogOpen"
    :title="t('preferences.title')"
    :description="t('preferences.description')"
    :icon="Settings"
    :size="isDesktop ? '2xl' : 'lg'"
  >
    <Tabs v-model="activeTab" activation-mode="manual" class="px-4 py-4 sm:px-6">
      <TabsList class="grid w-full" :class="isDesktop ? 'grid-cols-4' : 'grid-cols-3'">
        <TabsTrigger value="general">
          {{ t('preferences.tab.general') }}
        </TabsTrigger>
        <TabsTrigger value="editor">
          {{ t('preferences.tab.editor') }}
        </TabsTrigger>
        <TabsTrigger value="preview">
          {{ t('preferences.tab.preview') }}
        </TabsTrigger>
        <TabsTrigger v-if="isDesktop" value="agents">
          {{ t('preferences.tab.agents') }}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="general" class="mt-4">
        <PreferencesSection section="general" />
      </TabsContent>
      <TabsContent value="editor" class="mt-4">
        <PreferencesSection section="editor" />
      </TabsContent>
      <TabsContent value="preview" class="mt-4">
        <PreferencesSection section="preview" />
      </TabsContent>
      <TabsContent v-if="isDesktop" value="agents" class="mt-4">
        <AgentsSettingsTab />
      </TabsContent>
    </Tabs>
  </PanelDialog>
</template>
