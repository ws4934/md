<script setup lang="ts">
import type {
  WeChatErrorCodeKey,
  WeChatMpCredentials,
  WeChatPublishMode,
  WeChatPublishProgressEvent,
  WeChatPublishResult,
  WeChatPublishStage,
} from '@md/shared/types'
import type { ManagedPreviewUrl } from './agent-ui-helpers'
import {
  AlertCircle,
  Archive,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  ImagePlus,
  Info,
  Loader2,
  Send,
  X,
} from '@lucide/vue'
import { extractUploadableImageUrls } from '@md/shared/utils/wechat-html-images'
import { useEditorRefresh } from '@/composables/useEditorRefresh'
import { copyWeChatHtmlToClipboard } from '@/lib/agent/copy-wechat-html'
import { delay } from '@/lib/delay'
import { extractPublishDraft, resolveAutoPublishCover } from '@/lib/post/publish-draft'
import { processClipboardContent } from '@/services/export'
import { store } from '@/storage'
import { useEditorStore } from '@/stores/editor'
import { useMpAccountsStore } from '@/stores/mpAccounts'
import { usePostStore } from '@/stores/post'
import { useRenderStore } from '@/stores/render'
import { useThemeStore } from '@/stores/theme'
import { useUIStore } from '@/stores/ui'
import { createPreviewUrl, trapTabFocus } from './agent-ui-helpers'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'startCopy': []
  'endCopy': []
}>()

const MP_CONFIG_KEY = `mpConfig`
const LAST_AUTHOR_KEY = `desktop_wechat_last_author`
const MP_CONSOLE_URL = `https://mp.weixin.qq.com/`
const MAX_CACHED_COVERS = 20

const { t, locale } = useI18n()
const postStore = usePostStore()
const editorStore = useEditorStore()
const renderStore = useRenderStore()
const themeStore = useThemeStore()
const mpAccountsStore = useMpAccountsStore()
const uiStore = useUIStore()
const { editorRefresh } = useEditorRefresh()

const { currentPost } = storeToRefs(postStore)
const { primaryColor } = storeToRefs(themeStore)
const { currentAccount } = storeToRefs(mpAccountsStore)

const mpCredentials = ref<WeChatMpCredentials>({
  appID: ``,
  appsecret: ``,
  proxyOrigin: ``,
})

const title = ref(``)
const digest = ref(``)
const author = ref(``)
const needOpenComment = ref(true)
const coverSource = ref(``)
const coverPreviewUrl = ref(``)
const coverIsCustom = ref(false)
const pickedCoverByPostId = new Map<string, { path: string, preview: ManagedPreviewUrl }>()
const contentImageCount = ref(0)
const dialogRef = ref<HTMLElement | null>(null)
const titleInputRef = ref<HTMLInputElement | null>(null)
let previousFocusedEl: HTMLElement | null = null
let loadGeneration = 0
let isUnmounted = false

const phase = ref<`idle` | `running` | `done`>(`idle`)
const activeMode = ref<WeChatPublishMode>(`draft`)
const confirmingPublish = ref(false)
const isCopyingHtml = ref(false)

const currentPublishId = ref<string | null>(null)
const currentStage = ref<WeChatPublishStage>(`token`)
const imageProgress = ref<{ current: number, total: number }>({ current: 0, total: 0 })
const publishResult = ref<WeChatPublishResult | null>(null)
const errorState = ref<{
  errcode?: number
  errorCodeKey?: WeChatErrorCodeKey
  egressIp?: string
  mediaId?: string
  rawMessage?: string
} | null>(null)

let unsubscribeProgress: (() => void) | null = null

const hasCredentials = computed(() =>
  Boolean(mpCredentials.value.appID.trim() && mpCredentials.value.appsecret.trim()),
)

const maskedAppId = computed(() => {
  const id = mpCredentials.value.appID.trim()
  if (id.length <= 10)
    return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
})

const accountBadgeLetter = computed(() => {
  const name = currentAccount.value?.name?.trim()
  if (name)
    return name.slice(0, 1).toUpperCase()
  return `W`
})

const accountSummaryText = computed(() => {
  void locale.value
  const name = currentAccount.value?.name?.trim()
  if (name) {
    const typeLabel = currentAccount.value?.serviceType === `2`
      ? t(`agent.publish.serviceAccount`)
      : t(`agent.publish.subscriptionAccount`)
    return `${name} · ${typeLabel} (${maskedAppId.value})`
  }
  return `AppID: ${maskedAppId.value}`
})

const canSubmit = computed(() =>
  hasCredentials.value
  && phase.value !== `running`
  && Boolean(title.value.trim())
  && Boolean(coverSource.value.trim()),
)

const localizedErrorMessage = computed(() => {
  void locale.value
  const err = errorState.value
  if (!err)
    return ``
  switch (err.errorCodeKey) {
    case `ip_not_whitelisted`:
      return err.egressIp
        ? t(`agent.publish.errors.ipNotWhitelistedWithIp`, { ip: err.egressIp })
        : t(`agent.publish.errors.ipNotWhitelisted`)
    case `api_unauthorized`:
      return t(`agent.publish.errors.apiUnauthorized`)
    case `invalid_media`:
      return t(`agent.publish.errors.invalidMedia`)
    case `quota_exceeded`:
      return t(`agent.publish.errors.quotaExceeded`)
    case `invalid_credentials`:
      return t(`agent.publish.errors.invalidCredentials`)
    case `content_too_long`:
      return t(`agent.publish.errors.contentTooLong`)
    case `publish_timeout`:
      return t(`agent.publish.errors.publishTimeout`)
    case `publish_failed`:
      return err.rawMessage || t(`agent.publish.errors.publishFailed`)
    default:
      return err.rawMessage || t(`agent.publish.errors.generic`)
  }
})

const stageOrder: WeChatPublishStage[] = [`token`, `images`, `cover`, `draft`, `publishing`, `polling`, `done`]

function stepStatus(stageId: WeChatPublishStage): `done` | `active` | `pending` {
  const curIdx = stageOrder.indexOf(currentStage.value)
  const idx = stageOrder.indexOf(stageId)
  if (curIdx > idx)
    return `done`
  if (curIdx === idx)
    return `active`
  return `pending`
}

const progressSteps = computed(() => {
  void locale.value
  const steps: Array<{ id: WeChatPublishStage, label: string, status: `done` | `active` | `pending` }> = [
    { id: `token`, label: t(`agent.publish.stages.token`), status: stepStatus(`token`) },
  ]
  if (imageProgress.value.total > 0 || contentImageCount.value > 0) {
    const total = imageProgress.value.total || contentImageCount.value
    steps.push({
      id: `images`,
      label: t(`agent.publish.stages.images`, {
        current: imageProgress.value.current,
        total,
      }),
      status: stepStatus(`images`),
    })
  }
  steps.push(
    { id: `cover`, label: t(`agent.publish.stages.cover`), status: stepStatus(`cover`) },
    { id: `draft`, label: t(`agent.publish.stages.draft`), status: stepStatus(`draft`) },
  )
  if (activeMode.value === `publish`) {
    steps.push(
      { id: `publishing`, label: t(`agent.publish.stages.publishing`), status: stepStatus(`publishing`) },
      { id: `polling`, label: t(`agent.publish.stages.polling`), status: stepStatus(`polling`) },
    )
  }
  return steps
})

async function loadInitialState() {
  const generation = ++loadGeneration
  editorStore.flushContentToPostStore()

  const [saved, rawLastAuthor] = await Promise.all([
    store.getJSON<Partial<WeChatMpCredentials>>(MP_CONFIG_KEY, {}),
    store.get(LAST_AUTHOR_KEY),
  ])
  if (isUnmounted || !props.open || generation !== loadGeneration)
    return

  mpCredentials.value = {
    appID: saved?.appID?.trim() ?? ``,
    appsecret: saved?.appsecret?.trim() ?? ``,
    proxyOrigin: saved?.proxyOrigin?.trim() ?? ``,
  }

  const markdown = editorStore.getContent()
  if (renderStore.isDirty || !renderStore.output)
    editorRefresh({ force: true })
  const html = renderStore.output
  const draft = extractPublishDraft(html, markdown)

  title.value = (draft.title || currentPost.value?.title || ``).trim().slice(0, 64)
  digest.value = draft.desc.trim().slice(0, 120)

  const lastAuthor = rawLastAuthor?.trim() ?? ``
  author.value = lastAuthor || currentAccount.value?.name?.trim() || ``

  const postId = currentPost.value?.id ?? ``
  const rememberedCover = postId ? pickedCoverByPostId.get(postId) : undefined
  if (rememberedCover) {
    coverSource.value = rememberedCover.path
    coverPreviewUrl.value = rememberedCover.preview.url
    coverIsCustom.value = true
  }
  else {
    const autoCover = resolveAutoPublishCover(draft.thumb)
    coverSource.value = autoCover
    coverPreviewUrl.value = autoCover
    coverIsCustom.value = false
  }
  contentImageCount.value = extractUploadableImageUrls(html).length

  phase.value = `idle`
  confirmingPublish.value = false
  errorState.value = null
  publishResult.value = null
  imageProgress.value = { current: 0, total: 0 }
}

function closeDialog() {
  if (phase.value === `running`)
    return
  emit(`update:open`, false)
}

// Credentials live in Settings → WeChat (shared with the WeChat image host).
function openAccountSettings() {
  emit(`update:open`, false)
  uiStore.openPreferencesDialog(`wechat`)
}

let transientCoverRevoke: (() => void) | null = null

function clearTransientCover() {
  transientCoverRevoke?.()
  transientCoverRevoke = null
}

async function pickCoverImage() {
  const picked = await window.mdDesktop?.pickImage()
  if (!picked || isUnmounted)
    return
  const preview = createPreviewUrl(picked.dataUrl)
  coverSource.value = picked.path
  coverPreviewUrl.value = preview.url
  coverIsCustom.value = true
  clearTransientCover()

  const postId = currentPost.value?.id
  if (postId) {
    const prev = pickedCoverByPostId.get(postId)
    prev?.preview.revoke?.()
    pickedCoverByPostId.delete(postId)
    if (pickedCoverByPostId.size >= MAX_CACHED_COVERS) {
      const oldestKey = pickedCoverByPostId.keys().next().value
      if (oldestKey !== undefined) {
        pickedCoverByPostId.get(oldestKey)?.preview.revoke?.()
        pickedCoverByPostId.delete(oldestKey)
      }
    }
    pickedCoverByPostId.set(postId, { path: picked.path, preview })
  }
  else {
    transientCoverRevoke = preview.revoke
  }
}

function handleProgressEvent(event: WeChatPublishProgressEvent) {
  if (!currentPublishId.value || event.publishId !== currentPublishId.value)
    return
  if (event.stage !== `error`)
    currentStage.value = event.stage
  if (event.stage === `images`) {
    imageProgress.value = {
      current: event.currentImage ?? 0,
      total: event.totalImages ?? 0,
    }
  }
}

async function runPublish(mode: WeChatPublishMode) {
  if (!canSubmit.value || !window.mdDesktop?.wechat)
    return

  confirmingPublish.value = false
  errorState.value = null
  publishResult.value = null
  activeMode.value = mode
  phase.value = `running`
  currentStage.value = `token`
  imageProgress.value = { current: 0, total: contentImageCount.value }

  const publishId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  currentPublishId.value = publishId

  if (author.value.trim())
    void store.set(LAST_AUTHOR_KEY, author.value.trim())

  try {
    await nextTick()
    await delay(100)
    const processed = await processClipboardContent(primaryColor.value)
    editorRefresh()

    if (!processed.html.trim())
      throw new Error(t(`agent.publish.errors.emptyContent`))

    const res = await window.mdDesktop.wechat.publish({
      publishId,
      credentials: {
        appID: mpCredentials.value.appID.trim(),
        appsecret: mpCredentials.value.appsecret.trim(),
        proxyOrigin: mpCredentials.value.proxyOrigin?.trim() || undefined,
      },
      mode,
      title: title.value.trim().slice(0, 64),
      author: author.value.trim(),
      digest: digest.value.trim().slice(0, 120),
      contentHtml: processed.html,
      coverSource: coverSource.value.trim(),
      needOpenComment: needOpenComment.value,
    })

    if (!res.ok) {
      phase.value = `idle`
      errorState.value = {
        errcode: res.errcode,
        errorCodeKey: res.errorCodeKey,
        egressIp: res.egressIp,
        mediaId: res.mediaId,
        rawMessage: res.error,
      }
      return
    }

    currentStage.value = `done`
    publishResult.value = res
    phase.value = `done`
  }
  catch (err) {
    phase.value = `idle`
    errorState.value = {
      errorCodeKey: `unknown`,
      rawMessage: err instanceof Error ? err.message : String(err),
    }
  }
  finally {
    currentPublishId.value = null
  }
}

async function copyWeChatHtml() {
  if (isCopyingHtml.value)
    return
  isCopyingHtml.value = true
  try {
    await copyWeChatHtmlToClipboard({
      primaryColor: primaryColor.value,
      delayMs: 120,
      onStart: () => emit(`startCopy`),
      onEnd: () => emit(`endCopy`),
      onRefresh: () => editorRefresh(),
    })
  }
  finally {
    isCopyingHtml.value = false
  }
}

async function copyText(text: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(successMessage)
  }
  catch {
    toast.error(t(`agent.publish.copyFailed`))
  }
}

function openExternal(url: string) {
  void window.mdDesktop?.openExternal(url)
}

function handleKeydown(event: KeyboardEvent) {
  if (!props.open)
    return
  if (event.key === `Tab`) {
    trapTabFocus(event, dialogRef.value)
    return
  }
  if (event.key === `Escape` && phase.value !== `running`) {
    event.preventDefault()
    event.stopPropagation()
    if (confirmingPublish.value) {
      confirmingPublish.value = false
      return
    }
    closeDialog()
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      previousFocusedEl = document.activeElement instanceof HTMLElement ? document.activeElement : null
      void loadInitialState()
      nextTick(() => {
        if (titleInputRef.value)
          titleInputRef.value.focus()
        else
          dialogRef.value?.focus()
      })
    }
    else {
      coverPreviewUrl.value = ``
      clearTransientCover()
      if (previousFocusedEl?.isConnected)
        previousFocusedEl.focus()
      previousFocusedEl = null
    }
  },
  { immediate: true },
)

onMounted(() => {
  unsubscribeProgress = window.mdDesktop?.wechat?.onProgress(handleProgressEvent) ?? null
  window.addEventListener(`keydown`, handleKeydown)
})

onUnmounted(() => {
  isUnmounted = true
  clearTransientCover()
  for (const entry of pickedCoverByPostId.values())
    entry.preview.revoke?.()
  pickedCoverByPostId.clear()
  unsubscribeProgress?.()
  unsubscribeProgress = null
  window.removeEventListener(`keydown`, handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-testid="desktop-publish-dialog"
      class="fixed inset-0 z-200 flex items-center justify-center p-4"
      style="background-color: rgba(28, 27, 25, 0.28)"
      @mousedown.self="closeDialog"
    >
      <div
        ref="dialogRef"
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        :aria-label="t('agent.publish.title')"
        class="flex w-[680px] max-w-full flex-col overflow-hidden rounded-2xl outline-none"
        style="
          background-color: var(--dt-surface);
          border: 1px solid var(--dt-line);
          box-shadow: 0 30px 80px rgba(0, 0, 0, 0.22), 0 4px 12px rgba(0, 0, 0, 0.08);
          color: var(--dt-ink);
        "
      >
        <!-- Header -->
        <div class="flex items-start justify-between px-6 pt-[22px]">
          <div class="flex flex-col gap-1.5">
            <h2 class="text-[17px] font-bold leading-snug" style="color: var(--dt-ink)">
              {{ t('agent.publish.title') }}
            </h2>

            <div v-if="hasCredentials" class="flex items-center gap-1.5 text-[12.5px]">
              <span
                class="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                style="background-color: #07c160"
              >
                {{ accountBadgeLetter }}
              </span>
              <span style="color: var(--dt-ink2)">{{ accountSummaryText }}</span>
              <button
                v-if="phase !== 'running'"
                type="button"
                class="ml-0.5 cursor-pointer font-medium transition-opacity hover:opacity-80"
                style="color: var(--dt-accent)"
                @click="openAccountSettings"
              >
                {{ t('agent.publish.configureAccount') }}
              </button>
            </div>

            <div v-else class="flex items-center gap-1.5 text-[12.5px]" style="color: var(--dt-amber)">
              <AlertCircle class="size-3.5 shrink-0" />
              <span>{{ t('agent.publish.notConfiguredHint') }}</span>
              <button
                type="button"
                data-testid="publish-open-account-settings"
                class="ml-0.5 cursor-pointer font-medium transition-opacity hover:opacity-80"
                style="color: var(--dt-accent)"
                @click="openAccountSettings"
              >
                {{ t('agent.publish.goToSettings') }}
              </button>
            </div>
          </div>

          <button
            type="button"
            :disabled="phase === 'running'"
            :aria-label="t('agent.publish.close')"
            class="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg transition-colors hover:opacity-80 disabled:opacity-40"
            style="color: var(--dt-ink3)"
            @click="closeDialog"
          >
            <X class="size-4" />
          </button>
        </div>

        <!-- Progress View -->
        <div v-if="phase === 'running'" class="flex flex-col gap-4 px-6 py-6">
          <div
            class="flex flex-col gap-3 rounded-xl p-4"
            style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
          >
            <div class="flex items-center gap-2 text-[13.5px] font-semibold" style="color: var(--dt-ink)">
              <Loader2 class="size-4 animate-spin" style="color: var(--dt-accent)" />
              <span>
                {{ activeMode === 'publish' ? t('agent.publish.publishingTitle') : t('agent.publish.savingDraftTitle') }}
              </span>
            </div>

            <div class="flex flex-col gap-2.5 pl-1">
              <div
                v-for="step in progressSteps"
                :key="step.id"
                class="flex items-center gap-2.5 text-[13px]"
              >
                <Check
                  v-if="step.status === 'done'"
                  class="size-3.5 shrink-0"
                  style="color: var(--dt-green)"
                />
                <Loader2
                  v-else-if="step.status === 'active'"
                  class="size-3.5 shrink-0 animate-spin"
                  style="color: var(--dt-accent)"
                />
                <span
                  v-else
                  class="inline-block size-3.5 shrink-0 rounded-full"
                  style="border: 1.5px solid var(--dt-line)"
                />
                <span
                  :style="{
                    color: step.status === 'pending' ? 'var(--dt-ink3)' : 'var(--dt-ink)',
                    fontWeight: step.status === 'active' ? 600 : 400,
                  }"
                >
                  {{ step.label }}
                </span>
              </div>
            </div>

            <div
              v-if="currentStage === 'images' && imageProgress.total > 0"
              class="mt-1 h-1.5 w-full overflow-hidden rounded-full"
              style="background-color: var(--dt-subtle)"
            >
              <div
                class="h-full rounded-full transition-all duration-200"
                :style="{
                  width: `${Math.min(100, Math.round((imageProgress.current / imageProgress.total) * 100))}%`,
                  backgroundColor: 'var(--dt-accent)',
                }"
              />
            </div>
          </div>
        </div>

        <!-- Success Result View -->
        <div v-else-if="phase === 'done' && publishResult" class="flex flex-col gap-4 px-6 py-6">
          <div
            class="flex flex-col gap-3 rounded-xl p-5"
            style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
          >
            <div class="flex items-center gap-2.5">
              <CheckCircle2 class="size-5 shrink-0" style="color: var(--dt-green)" />
              <div class="flex flex-col">
                <span class="text-[15px] font-semibold" style="color: var(--dt-ink)">
                  {{ publishResult.mode === 'publish' ? t('agent.publish.publishSuccessTitle') : t('agent.publish.draftSuccessTitle') }}
                </span>
                <span class="text-xs" style="color: var(--dt-ink2)">
                  {{ title }}
                </span>
              </div>
            </div>

            <p class="text-[12.5px] leading-relaxed" style="color: var(--dt-ink2)">
              {{ publishResult.mode === 'publish' ? t('agent.publish.publishSuccessDesc') : t('agent.publish.draftSuccessDesc') }}
            </p>

            <div class="flex flex-wrap items-center gap-2 pt-1">
              <button
                v-if="publishResult.articleUrl"
                type="button"
                class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold transition-opacity hover:opacity-90"
                style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
                @click="openExternal(publishResult.articleUrl!)"
              >
                <ExternalLink class="size-3.5" />
                <span>{{ t('agent.publish.openArticle') }}</span>
              </button>

              <button
                v-if="publishResult.articleUrl"
                type="button"
                class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-opacity hover:opacity-80"
                style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink)"
                @click="copyText(publishResult.articleUrl!, t('agent.publish.articleLinkCopied'))"
              >
                <Copy class="size-3.5" />
                <span>{{ t('agent.publish.copyArticleLink') }}</span>
              </button>

              <button
                type="button"
                class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-opacity hover:opacity-80"
                :style="publishResult.articleUrl
                  ? 'background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink)'
                  : 'background-color: var(--dt-ink); color: var(--dt-on-ink)'"
                @click="openExternal(MP_CONSOLE_URL)"
              >
                <ExternalLink class="size-3.5" />
                <span>{{ t('agent.publish.openDraftBox') }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Main Publish Form -->
        <template v-else>
          <div class="flex gap-5 px-6 py-5">
            <!-- Left column: Cover wide + square thumb -->
            <div class="flex w-[200px] shrink-0 flex-col gap-2">
              <button
                type="button"
                :aria-label="coverPreviewUrl ? t('agent.publish.changeCover') : t('agent.publish.pickCover')"
                class="group relative flex h-[85px] w-[200px] cursor-pointer items-center justify-center overflow-hidden rounded-[10px] text-left transition-opacity hover:opacity-95"
                :style="coverPreviewUrl
                  ? 'border: 1px solid var(--dt-line)'
                  : 'background-color: var(--dt-canvas); border: 1px dashed var(--dt-line)'"
                @click="pickCoverImage"
              >
                <img
                  v-if="coverPreviewUrl"
                  :src="coverPreviewUrl"
                  :alt="title"
                  class="size-full object-cover"
                >
                <div v-else class="flex flex-col items-center gap-1 px-2 text-center" style="color: var(--dt-ink3)">
                  <ImagePlus class="size-5" />
                  <span class="text-[11.5px] font-medium">{{ t('agent.publish.pickCover') }}</span>
                </div>
              </button>

              <div class="flex gap-2">
                <button
                  type="button"
                  :aria-label="coverPreviewUrl ? t('agent.publish.changeCover') : t('agent.publish.pickCover')"
                  class="flex size-[85px] shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-[10px]"
                  :style="coverPreviewUrl
                    ? 'border: 1px solid var(--dt-line)'
                    : 'background-color: var(--dt-canvas); border: 1px dashed var(--dt-line)'"
                  @click="pickCoverImage"
                >
                  <img
                    v-if="coverPreviewUrl"
                    :src="coverPreviewUrl"
                    :alt="title"
                    class="size-full object-cover"
                  >
                  <ImagePlus v-else class="size-4" style="color: var(--dt-ink3)" />
                </button>

                <div class="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                  <span
                    class="text-[11.5px] leading-[17px]"
                    :style="{ color: coverPreviewUrl ? 'var(--dt-ink3)' : 'var(--dt-amber)' }"
                  >
                    {{
                      !coverPreviewUrl
                        ? t('agent.publish.coverRequiredHint')
                        : coverIsCustom
                          ? t('agent.publish.coverCustomHint')
                          : t('agent.publish.coverFromArticleHint')
                    }}
                  </span>
                  <button
                    type="button"
                    class="w-fit cursor-pointer text-xs font-medium transition-opacity hover:opacity-80"
                    style="color: var(--dt-accent)"
                    @click="pickCoverImage"
                  >
                    {{ coverPreviewUrl ? t('agent.publish.changeCover') : t('agent.publish.pickCover') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Right column: Title, Digest, Author, Comment Toggle -->
            <div class="flex min-w-0 flex-1 flex-col gap-3.5">
              <label class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-medium" style="color: var(--dt-ink2)">{{ t('agent.publish.fieldTitle') }}</span>
                  <span class="text-[11.5px]" style="color: var(--dt-ink3); font-family: var(--dt-mono)">
                    {{ title.length }}/64
                  </span>
                </div>
                <input
                  ref="titleInputRef"
                  v-model="title"
                  type="text"
                  maxlength="64"
                  :placeholder="t('agent.publish.titlePlaceholder')"
                  class="h-9 w-full rounded-lg px-3 text-[13.5px] outline-none"
                  style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line); color: var(--dt-ink)"
                >
              </label>

              <label class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-medium" style="color: var(--dt-ink2)">{{ t('agent.publish.fieldDigest') }}</span>
                  <span class="text-[11.5px]" style="color: var(--dt-ink3); font-family: var(--dt-mono)">
                    {{ digest.length }}/120
                  </span>
                </div>
                <textarea
                  v-model="digest"
                  maxlength="120"
                  rows="2"
                  :placeholder="t('agent.publish.digestPlaceholder')"
                  class="h-16 w-full resize-none rounded-lg px-3 py-2 text-[13px] leading-5 outline-none"
                  style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line); color: var(--dt-ink)"
                />
              </label>

              <div class="flex items-end gap-4">
                <label class="flex w-[180px] flex-col gap-1.5">
                  <span class="text-xs font-medium" style="color: var(--dt-ink2)">{{ t('agent.publish.fieldAuthor') }}</span>
                  <input
                    v-model="author"
                    type="text"
                    maxlength="32"
                    :placeholder="t('agent.publish.authorPlaceholder')"
                    class="h-9 w-full rounded-lg px-3 text-[13.5px] outline-none"
                    style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line); color: var(--dt-ink)"
                  >
                </label>

                <div class="flex h-9 flex-1 items-center justify-end gap-2.5">
                  <span class="text-[13px]" style="color: var(--dt-ink2)">{{ t('agent.publish.openComments') }}</span>
                  <button
                    type="button"
                    role="switch"
                    :aria-label="t('agent.publish.openComments')"
                    :aria-checked="needOpenComment"
                    class="inline-flex h-5 w-[34px] shrink-0 cursor-pointer items-center rounded-[10px] p-0.5 transition-colors"
                    :style="{
                      backgroundColor: needOpenComment ? 'var(--dt-accent)' : 'var(--dt-subtle)',
                      justifyContent: needOpenComment ? 'flex-end' : 'flex-start',
                    }"
                    @click="needOpenComment = !needOpenComment"
                  >
                    <span class="size-4 rounded-full bg-white shadow-xs" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Info banner -->
          <div class="px-6 pb-4">
            <div
              class="flex items-center gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed"
              style="background-color: var(--dt-canvas); color: var(--dt-ink2)"
            >
              <Info class="size-3.5 shrink-0" style="color: var(--dt-ink3)" />
              <span>
                {{
                  contentImageCount > 0
                    ? t('agent.publish.infoWithImages', { count: contentImageCount })
                    : t('agent.publish.infoNoImages')
                }}
              </span>
            </div>
          </div>

          <!-- Actionable Error Banner -->
          <div v-if="errorState" class="px-6 pb-4">
            <div
              class="flex flex-col gap-2 rounded-lg px-3.5 py-2.5 text-xs leading-relaxed"
              style="background-color: var(--dt-red-soft); color: var(--dt-red)"
            >
              <div class="flex items-start gap-2">
                <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
                <span class="flex-1">{{ localizedErrorMessage }}</span>
              </div>

              <div class="flex flex-wrap items-center gap-2 pl-5">
                <button
                  v-if="errorState.egressIp"
                  type="button"
                  class="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] font-medium"
                  style="background-color: var(--dt-surface); color: var(--dt-ink); font-family: var(--dt-mono)"
                  @click="copyText(errorState.egressIp!, t('agent.publish.ipCopied'))"
                >
                  <span>{{ errorState.egressIp }}</span>
                  <Copy class="size-3" />
                </button>

                <button
                  v-if="errorState.errorCodeKey === 'invalid_credentials' || errorState.errorCodeKey === 'ip_not_whitelisted'"
                  type="button"
                  class="cursor-pointer font-medium underline underline-offset-2"
                  @click="openAccountSettings"
                >
                  {{ t('agent.publish.editCredentials') }}
                </button>

                <button
                  v-if="errorState.mediaId"
                  type="button"
                  class="inline-flex cursor-pointer items-center gap-1 font-medium underline underline-offset-2"
                  @click="openExternal(MP_CONSOLE_URL)"
                >
                  <span>{{ t('agent.publish.draftSavedOpenConsole') }}</span>
                  <ExternalLink class="size-3" />
                </button>
              </div>
            </div>
          </div>

          <!-- Direct publish one-line confirmation bar -->
          <div v-if="confirmingPublish" class="px-6 pb-4">
            <div
              data-testid="publish-confirm-bar"
              class="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs"
              style="background-color: var(--dt-amber-soft); border: 1px solid var(--dt-amber-line); color: var(--dt-amber)"
            >
              <span class="min-w-0 flex-1 font-medium">
                {{ t('agent.publish.directPublishConfirm') }}
              </span>
              <div class="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  class="inline-flex h-7 cursor-pointer items-center rounded-md px-2.5 text-xs font-medium"
                  style="color: var(--dt-ink2)"
                  @click="confirmingPublish = false"
                >
                  {{ t('agent.settings.cancel') }}
                </button>
                <button
                  type="button"
                  class="inline-flex h-7 cursor-pointer items-center rounded-md px-3 text-xs font-semibold transition-opacity hover:opacity-90"
                  style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
                  @click="runPublish('publish')"
                >
                  {{ t('agent.publish.confirmPublishNow') }}
                </button>
              </div>
            </div>
          </div>
        </template>

        <!-- Footer -->
        <div
          class="flex items-center gap-2 px-6 py-4"
          style="border-top: 1px solid var(--dt-line)"
        >
          <button
            type="button"
            :disabled="isCopyingHtml"
            class="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
            style="color: var(--dt-ink2)"
            @click="copyWeChatHtml"
          >
            <Loader2 v-if="isCopyingHtml" class="size-3.5 animate-spin" />
            <Copy v-else class="size-3.5" />
            <span>{{ t('agent.publish.copyHtml') }}</span>
          </button>

          <span class="flex-1" />

          <template v-if="phase === 'done'">
            <button
              type="button"
              class="inline-flex h-[34px] cursor-pointer items-center rounded-lg px-4 text-[13px] font-medium transition-opacity hover:opacity-85"
              style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink)"
              @click="closeDialog"
            >
              {{ t('agent.publish.close') }}
            </button>
          </template>

          <template v-else>
            <button
              type="button"
              :disabled="!canSubmit"
              class="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-45"
              style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink)"
              @click="runPublish('draft')"
            >
              <Archive class="size-3.5" />
              <span>{{ t('agent.publish.saveDraft') }}</span>
            </button>

            <button
              type="button"
              :disabled="!canSubmit"
              class="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-lg px-4 text-[13px] font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
              @click="confirmingPublish = true"
            >
              <Send class="size-3.5" />
              <span>{{ t('agent.publish.publishNow') }}</span>
            </button>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
