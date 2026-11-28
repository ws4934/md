<script setup lang="ts">
import type { PreferencesTab } from '@/stores/ui'
import { ArrowLeft, Bot, Cpu, Eye, Image, ImagePlus, Info, MessageCircle, PenLine, Puzzle, SlidersHorizontal, Smile } from '@lucide/vue'
import PreferencesSection from '@/components/editor/dialogs/PreferencesSection.vue'
import ImageHostSettings from '@/components/editor/dialogs/upload-providers/ImageHostSettings.vue'
import { useUIStore } from '@/stores/ui'
import AboutSettings from './AboutSettings.vue'
import { trapTabFocus } from './agent-ui-helpers'
import AgentsSettingsTab from './AgentsSettingsTab.vue'
import ImageGenSettings from './ImageGenSettings.vue'
import IpCharacterSettings from './IpCharacterSettings.vue'
import ModelApiSettings from './ModelApiSettings.vue'
import SkillSettings from './SkillSettings.vue'
import WeChatAccountSettings from './WeChatAccountSettings.vue'

const { t, locale } = useI18n()
const uiStore = useUIStore()
const { preferencesInitialTab: activeSection } = storeToRefs(uiStore)

const sections = computed(() => {
  void locale.value
  return [
    { id: `general`, icon: SlidersHorizontal, label: t(`preferences.tab.general`), description: t(`preferences.sectionHint.general`) },
    { id: `editor`, icon: PenLine, label: t(`preferences.tab.editor`), description: t(`preferences.sectionHint.editor`) },
    { id: `preview`, icon: Eye, label: t(`preferences.tab.preview`), description: t(`preferences.sectionHint.preview`) },
    { id: `images`, icon: Image, label: t(`preferences.tab.images`), description: t(`preferences.sectionHint.images`) },
    { id: `wechat`, icon: MessageCircle, label: t(`preferences.tab.wechat`), description: t(`preferences.sectionHint.wechat`) },
    { id: `agents`, icon: Bot, label: t(`preferences.tab.agents`), description: `` },
    { id: `modelApi`, icon: Cpu, label: t(`preferences.tab.modelApi`), description: t(`preferences.sectionHint.modelApi`) },
    { id: `imageGen`, icon: ImagePlus, label: t(`preferences.tab.imageGen`), description: t(`preferences.sectionHint.imageGen`) },
    { id: `ipCharacters`, icon: Smile, label: t(`preferences.tab.ipCharacters`), description: t(`preferences.sectionHint.ipCharacters`) },
    { id: `skills`, icon: Puzzle, label: t(`preferences.tab.skills`), description: t(`preferences.sectionHint.skills`) },
    { id: `about`, icon: Info, label: t(`preferences.tab.about`), description: t(`preferences.sectionHint.about`) },
  ] satisfies { id: PreferencesTab, icon: unknown, label: string, description: string }[]
})

const current = computed(() => sections.value.find(s => s.id === activeSection.value) ?? sections.value[0])

const pageRef = ref<HTMLElement | null>(null)
const backBtnRef = ref<HTMLButtonElement | null>(null)
let previousFocusedEl: HTMLElement | null = null

function close() {
  uiStore.isShowPreferencesDialog = false
  activeSection.value = `general`
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === `Tab`) {
    trapTabFocus(event, pageRef.value)
    return
  }
  // Leave Escape to any dialog / popover opened from inside the page.
  if (event.key !== `Escape` || event.defaultPrevented || document.querySelector(`[role="dialog"], [data-reka-popper-content-wrapper]`))
    return
  event.preventDefault()
  close()
}

onMounted(() => {
  previousFocusedEl = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener(`keydown`, onKeydown)
  nextTick(() => {
    if (pageRef.value && !pageRef.value.contains(document.activeElement))
      backBtnRef.value?.focus()
  })
})

onUnmounted(() => {
  window.removeEventListener(`keydown`, onKeydown)
  if (previousFocusedEl?.isConnected)
    previousFocusedEl.focus()
  previousFocusedEl = null
})
</script>

<template>
  <div
    ref="pageRef"
    tabindex="-1"
    data-testid="desktop-settings-page"
    class="fixed inset-0 z-40 flex outline-none"
    style="background-color: var(--dt-canvas); color: var(--dt-ink)"
  >
    <nav class="flex w-[232px] shrink-0 flex-col select-none" style="background-color: var(--dt-sidebar)">
      <div class="desktop-drag-region h-[52px] shrink-0" />
      <div class="px-2.5 pb-3">
        <button
          ref="backBtnRef"
          type="button"
          data-testid="settings-back"
          class="desktop-no-drag flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] transition-opacity hover:opacity-80"
          style="color: var(--dt-ink2)"
          @click="close"
        >
          <ArrowLeft class="size-4" />
          <span>{{ t('preferences.backToEditor') }}</span>
          <span class="ml-auto text-[11px]" style="color: var(--dt-ink3)">Esc</span>
        </button>
      </div>
      <div class="flex flex-col gap-0.5 px-2.5">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          :data-testid="`settings-nav-${section.id}`"
          :aria-current="section.id === current.id ? 'page' : undefined"
          class="flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors"
          :style="section.id === current.id
            ? { backgroundColor: 'var(--dt-surface)', color: 'var(--dt-ink)', fontWeight: 600, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06)' }
            : { color: 'var(--dt-ink2)' }"
          @click="activeSection = section.id"
        >
          <component :is="section.icon" class="size-4 shrink-0" />
          <span class="truncate">{{ section.label }}</span>
        </button>
      </div>
    </nav>

    <main class="flex min-w-0 flex-1 flex-col">
      <div class="desktop-drag-region h-[52px] shrink-0" />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[680px] px-8 pb-16">
          <header v-if="current.id !== 'agents'" class="mb-4">
            <h2 class="text-xl font-bold tracking-tight">
              {{ current.label }}
            </h2>
            <p class="mt-1 text-[13px]" style="color: var(--dt-ink3)">
              {{ current.description }}
            </p>
          </header>

          <PreferencesSection v-if="current.id === 'general' || current.id === 'editor' || current.id === 'preview'" :section="current.id" />
          <ImageHostSettings v-else-if="current.id === 'images'" @open-wechat="activeSection = 'wechat'" />
          <WeChatAccountSettings v-else-if="current.id === 'wechat'" />
          <ModelApiSettings v-else-if="current.id === 'modelApi'" />
          <ImageGenSettings v-else-if="current.id === 'imageGen'" />
          <IpCharacterSettings v-else-if="current.id === 'ipCharacters'" />
          <SkillSettings v-else-if="current.id === 'skills'" />
          <AboutSettings v-else-if="current.id === 'about'" />
          <AgentsSettingsTab v-else @open-model-api="activeSection = 'modelApi'" />
        </div>
      </div>
    </main>
  </div>
</template>
