<script setup lang="ts">
import type { ConfigurableUploadProviderId } from '@/services/upload/provider-registry'
import PanelSelect from '@/components/shared/panel-dialog/PanelSelect.vue'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useLocalizedUploadHostOptions } from '@/composables/useLocalizedUploadHosts'
import { store } from '@/storage'
import { useUIStore } from '@/stores/ui'
import { UPLOAD_PROVIDER_CONFIG_COMPONENTS } from './index'

const emit = defineEmits<{
  openWechat: []
}>()

const { t } = useI18n()
const uiStore = useUIStore()
const isDesktop = Boolean(window.mdDesktop?.isDesktop)
const { enableImageReupload } = storeToRefs(uiStore)

const uploadHostOptions = useLocalizedUploadHostOptions()
const imgHost = store.reactive(`imgHost`, `default`)
const useCompression = store.reactive(`useCompression`, false)

const configForm = computed(() =>
  UPLOAD_PROVIDER_CONFIG_COMPONENTS[imgHost.value as ConfigurableUploadProviderId] ?? null,
)
const hostLabel = computed(() =>
  uploadHostOptions.value.find(option => option.value === imgHost.value)?.label ?? imgHost.value,
)

function changeImgHost(value: string) {
  imgHost.value = value
  toast.success(t(`upload.hostSwitched`))
}
</script>

<template>
  <div class="space-y-1">
    <div class="flex items-center justify-between gap-4 border-b py-3">
      <div class="min-w-0 space-y-0.5">
        <Label>{{ t('preferences.imageHost.label') }}</Label>
        <p class="text-xs text-muted-foreground">
          {{ t('preferences.imageHost.hint') }}
        </p>
      </div>
      <PanelSelect
        :model-value="imgHost"
        :options="uploadHostOptions"
        trigger-class="min-w-40"
        @update:model-value="changeImgHost"
      />
    </div>

    <div class="flex items-center justify-between gap-4 border-b py-3">
      <Label for="pref-image-compression">{{ t('upload.enableCompression') }}</Label>
      <Switch id="pref-image-compression" v-model="useCompression" class="shrink-0" />
    </div>

    <div class="flex items-center justify-between gap-4 py-3">
      <div class="min-w-0 space-y-0.5">
        <Label for="pref-image-reupload">{{ t('preferences.imageReupload.label') }}</Label>
        <p class="text-xs text-muted-foreground">
          {{ t('upload.autoReuploadMdHint') }}
        </p>
      </div>
      <Switch id="pref-image-reupload" v-model="enableImageReupload" class="shrink-0" />
    </div>

    <section v-if="configForm" class="mt-4 rounded-xl border p-4">
      <h4 class="mb-3 text-sm font-semibold">
        {{ t('preferences.imageHost.configTitle', { host: hostLabel }) }}
      </h4>
      <!-- The WeChat host shares its AppID / AppSecret with publishing, so it is edited in one place. -->
      <div v-if="imgHost === 'mp' && isDesktop" class="flex items-center justify-between gap-4 text-sm text-muted-foreground">
        <span>{{ t('preferences.imageHost.mpSharedNote') }}</span>
        <Button size="sm" variant="outline" @click="emit('openWechat')">
          {{ t('preferences.imageHost.openWechat') }}
        </Button>
      </div>
      <component :is="configForm" v-else :key="imgHost" />
    </section>
  </div>
</template>
