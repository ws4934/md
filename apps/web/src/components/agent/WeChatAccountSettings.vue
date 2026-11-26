<script setup lang="ts">
import type { WeChatMpCredentials } from '@md/shared/types'
import { ExternalLink, Eye, EyeOff, Info } from '@lucide/vue'
import { store } from '@/storage'

// Shared with the WeChat image host (`mp`) and article publishing.
const MP_CONFIG_KEY = `mpConfig`
const MP_DEV_DOC_URL = `https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Getting_Started_Guide.html`

const { t } = useI18n()

const credForm = ref<WeChatMpCredentials>({ appID: ``, appsecret: ``, proxyOrigin: `` })
const showSecret = ref(false)
let isUnmounted = false
let hasUserEdited = false

function markUserEdited() {
  hasUserEdited = true
}

onMounted(async () => {
  try {
    const saved = await store.getJSON<Partial<WeChatMpCredentials>>(MP_CONFIG_KEY, {})
    if (isUnmounted || hasUserEdited)
      return
    credForm.value = {
      appID: saved?.appID?.trim() ?? ``,
      appsecret: saved?.appsecret?.trim() ?? ``,
      proxyOrigin: saved?.proxyOrigin?.trim() ?? ``,
    }
  }
  catch {
    // Ignore storage read failure on teardown.
  }
})

onUnmounted(() => {
  isUnmounted = true
})

function openDevDocs() {
  void window.mdDesktop?.openExternal(MP_DEV_DOC_URL)
}

async function saveCredentials() {
  const appID = credForm.value.appID.trim()
  const appsecret = credForm.value.appsecret.trim()
  const proxyOrigin = credForm.value.proxyOrigin?.trim().replace(/\/+$/, ``) ?? ``

  if (!appID || !appsecret) {
    toast.error(t(`agent.publish.credentialsRequired`))
    return
  }

  await store.setJSON(MP_CONFIG_KEY, { appID, appsecret, proxyOrigin } satisfies WeChatMpCredentials)
  toast.success(t(`common.saveSuccess`))
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="wechat-account-settings">
    <div
      class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
      style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
    >
      <Info class="mt-0.5 size-3.5 shrink-0" style="color: var(--dt-ink3)" />
      <span>{{ t('agent.publish.credentialsReuseNote') }}</span>
    </div>

    <div class="flex flex-col gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium" style="color: var(--dt-ink2)">AppID</span>
        <input
          v-model="credForm.appID"
          type="text"
          autocomplete="off"
          :placeholder="t('upload.placeholders.appId')"
          class="h-9 w-full rounded-lg px-3 text-[13.5px] outline-none"
          style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink)"
          @input="markUserEdited"
        >
      </label>

      <div class="flex flex-col gap-1.5">
        <label for="wechat-mp-appsecret" class="text-xs font-medium" style="color: var(--dt-ink2)">AppSecret</label>
        <div
          class="flex h-9 w-full items-center rounded-lg px-3"
          style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
        >
          <input
            id="wechat-mp-appsecret"
            v-model="credForm.appsecret"
            :type="showSecret ? 'text' : 'password'"
            autocomplete="off"
            :placeholder="t('upload.placeholders.appSecret')"
            class="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
            style="color: var(--dt-ink)"
            @input="markUserEdited"
          >
          <button
            type="button"
            :aria-label="showSecret ? t('agent.modelApi.hideKey') : t('agent.modelApi.showKey')"
            class="ml-2 cursor-pointer"
            style="color: var(--dt-ink3)"
            @click="showSecret = !showSecret"
          >
            <EyeOff v-if="showSecret" class="size-4" />
            <Eye v-else class="size-4" />
          </button>
        </div>
      </div>

      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium" style="color: var(--dt-ink2)">
          {{ t('agent.publish.proxyOptionalLabel') }}
        </span>
        <input
          v-model="credForm.proxyOrigin"
          type="text"
          autocomplete="off"
          :placeholder="t('agent.publish.proxyOptionalPlaceholder')"
          class="h-9 w-full rounded-lg px-3 text-[13.5px] outline-none"
          style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink)"
          @input="markUserEdited"
        >
      </label>
    </div>

    <div class="flex items-center justify-between pt-1">
      <button
        type="button"
        class="inline-flex cursor-pointer items-center gap-1 text-xs font-medium transition-opacity hover:opacity-80"
        style="color: var(--dt-accent)"
        @click="openDevDocs"
      >
        <span>{{ t('agent.publish.devModeGuide') }}</span>
        <ExternalLink class="size-3" />
      </button>

      <button
        type="button"
        data-testid="wechat-save-credentials"
        class="inline-flex h-8 cursor-pointer items-center rounded-lg px-3.5 text-xs font-semibold transition-opacity hover:opacity-90"
        style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
        @click="saveCredentials"
      >
        {{ t('agent.publish.saveCredentials') }}
      </button>
    </div>
  </div>
</template>
