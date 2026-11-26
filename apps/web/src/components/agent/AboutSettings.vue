<script setup lang="ts">
import type { DesktopUpdateState } from '@md/shared/types'
import { CheckCircle2, Download, Info, Loader2, RefreshCw, RotateCw } from '@lucide/vue'
import { shouldApplyUpdateCheckResult } from './agent-ui-helpers'

const { t, locale } = useI18n()

const updateState = ref<DesktopUpdateState | null>(null)
let unsubscribe: (() => void) | null = null
let receivedPush = false
let unmounted = false

onMounted(async () => {
  const updatesApi = window.mdDesktop?.updates
  if (!updatesApi)
    return

  unsubscribe = updatesApi.onState((next) => {
    receivedPush = true
    updateState.value = next
  })

  try {
    const initial = await updatesApi.getState()
    if (!unmounted && !receivedPush)
      updateState.value = initial
  }
  catch {
    // Ignore when the desktop bridge is not available.
  }
})

onUnmounted(() => {
  unmounted = true
  unsubscribe?.()
  unsubscribe = null
})

const currentVersion = computed(() => updateState.value?.currentVersion ?? ``)

const isChecking = computed(() => updateState.value?.status === `checking`)

const isDownloading = computed(() =>
  updateState.value?.status === `downloading`
  || (updateState.value?.status === `available` && updateState.value.mode === `install`),
)

const isCheckDisabled = computed(() =>
  !updateState.value || !updateState.value.supported || isChecking.value || isDownloading.value,
)

const canRestartToUpdate = computed(() =>
  Boolean(
    updateState.value?.supported
    && updateState.value.mode === `install`
    && updateState.value.status === `downloaded`,
  ),
)

const canDownloadRelease = computed(() =>
  Boolean(
    updateState.value?.supported
    && updateState.value.mode === `notify`
    && updateState.value.status === `available`
    && updateState.value.releaseUrl,
  ),
)

const statusText = computed(() => {
  void locale.value
  const state = updateState.value
  if (!state)
    return ``
  if (!state.supported)
    return t(`preferences.about.unsupported`)

  switch (state.status) {
    case `checking`:
      return t(`preferences.about.checking`)
    case `not-available`:
      return t(`preferences.about.upToDate`)
    case `available`:
      if (state.mode === `install`) {
        return state.version
          ? t(`preferences.about.downloadingVersion`, { version: state.version })
          : t(`preferences.about.downloading`)
      }
      return t(`preferences.about.available`, { version: state.version ?? `` })
    case `downloading`:
      if (state.version && typeof state.percent === `number`)
        return t(`preferences.about.downloadingPercent`, { version: state.version, percent: state.percent })
      if (state.version)
        return t(`preferences.about.downloadingVersion`, { version: state.version })
      if (typeof state.percent === `number`)
        return `${t(`preferences.about.downloading`)} ${state.percent}%`
      return t(`preferences.about.downloading`)
    case `downloaded`:
      return t(`preferences.about.readyToInstall`, { version: state.version ?? `` })
    case `error`:
      return t(`preferences.about.checkFailed`)
    case `idle`:
    default:
      return ``
  }
})

async function handleCheck() {
  const updatesApi = window.mdDesktop?.updates
  if (!updatesApi || isCheckDisabled.value)
    return

  try {
    const next = await updatesApi.check()
    if (!unmounted && shouldApplyUpdateCheckResult(updateState.value, next))
      updateState.value = next
  }
  catch (error) {
    if (!unmounted && updateState.value) {
      updateState.value = {
        ...updateState.value,
        status: `error`,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

function handleInstall() {
  if (!canRestartToUpdate.value)
    return
  void window.mdDesktop?.updates?.install()
}

function handleDownload() {
  const url = updateState.value?.releaseUrl
  if (!canDownloadRelease.value || !url)
    return
  void window.mdDesktop?.openExternal(url)
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="about-settings">
    <div
      class="flex flex-col gap-4 rounded-xl p-4"
      style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
    >
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="min-w-0">
          <div class="text-[14px] font-semibold" style="color: var(--dt-ink)">
            md
          </div>
          <div class="mt-0.5 flex items-center gap-1.5 text-xs" style="color: var(--dt-ink3)">
            <span>{{ t('preferences.about.versionLabel') }}</span>
            <span
              v-if="currentVersion"
              data-testid="about-version"
              style="font-family: var(--dt-mono); color: var(--dt-ink2)"
            >v{{ currentVersion }}</span>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <button
            v-if="canRestartToUpdate"
            type="button"
            data-testid="about-restart-update"
            class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold transition-opacity hover:opacity-90"
            style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
            @click="handleInstall"
          >
            <RotateCw class="size-3.5" />
            <span>{{ t('preferences.about.restartToUpdate') }}</span>
          </button>

          <button
            v-else-if="canDownloadRelease"
            type="button"
            data-testid="about-download-update"
            class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold transition-opacity hover:opacity-90"
            style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
            @click="handleDownload"
          >
            <Download class="size-3.5" />
            <span>{{ t('preferences.about.download') }}</span>
          </button>

          <button
            type="button"
            data-testid="about-check-updates"
            :disabled="isCheckDisabled"
            class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
            style="background-color: var(--dt-canvas); color: var(--dt-ink); border: 1px solid var(--dt-line)"
            @click="handleCheck"
          >
            <RefreshCw class="size-3.5" :class="{ 'animate-spin': isChecking }" />
            <span>{{ t('preferences.about.checkForUpdates') }}</span>
          </button>
        </div>
      </div>

      <!-- Unsupported build notice -->
      <div
        v-if="updateState && !updateState.supported"
        data-testid="about-update-status"
        class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
        style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
      >
        <Info class="mt-0.5 size-3.5 shrink-0" style="color: var(--dt-ink3)" />
        <span>{{ statusText }}</span>
      </div>

      <!-- Error banner -->
      <div
        v-else-if="updateState?.status === 'error'"
        data-testid="about-update-status"
        class="flex flex-col gap-1 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
        style="background-color: var(--dt-red-soft); color: var(--dt-red)"
      >
        <div class="font-medium">
          {{ statusText }}
        </div>
        <div v-if="updateState.error" class="break-words opacity-90">
          {{ updateState.error }}
        </div>
      </div>

      <!-- Downloading progress -->
      <div
        v-else-if="isDownloading"
        data-testid="about-update-status"
        class="flex flex-col gap-2 border-t pt-3"
        style="border-color: var(--dt-line)"
      >
        <div class="flex items-center gap-2 text-xs" style="color: var(--dt-ink2)">
          <Loader2 class="size-3.5 shrink-0 animate-spin" style="color: var(--dt-accent)" />
          <span>{{ statusText }}</span>
        </div>
        <div
          v-if="typeof updateState?.percent === 'number'"
          class="h-1.5 w-full overflow-hidden rounded-full"
          style="background-color: var(--dt-subtle)"
        >
          <div
            class="h-full rounded-full transition-all duration-200"
            :style="{
              width: `${Math.max(2, Math.min(100, updateState.percent))}%`,
              backgroundColor: 'var(--dt-accent)',
            }"
          />
        </div>
      </div>

      <!-- Checking / Up to date / Available (notify) / Ready to install -->
      <div
        v-else-if="statusText"
        data-testid="about-update-status"
        class="flex items-center gap-2 border-t pt-3 text-xs"
        style="border-color: var(--dt-line); color: var(--dt-ink2)"
      >
        <Loader2 v-if="isChecking" class="size-3.5 shrink-0 animate-spin" style="color: var(--dt-accent)" />
        <CheckCircle2
          v-else-if="updateState?.status === 'not-available' || updateState?.status === 'downloaded'"
          class="size-3.5 shrink-0"
          style="color: var(--dt-green)"
        />
        <Download
          v-else-if="updateState?.status === 'available'"
          class="size-3.5 shrink-0"
          style="color: var(--dt-accent)"
        />
        <span>{{ statusText }}</span>
      </div>
    </div>
  </div>
</template>
