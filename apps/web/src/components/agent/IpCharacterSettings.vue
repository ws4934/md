<script setup lang="ts">
import type { DesktopIpCharacter, DesktopIpLibrary } from '@md/shared/types'
import type { ManagedPreviewUrl } from './agent-ui-helpers'
import { Info, Loader2, Pencil, Smile, Star, Trash2 } from '@lucide/vue'
import { useConfirmStore } from '@/stores/confirm'
import { createPreviewUrl } from './agent-ui-helpers'

const NAME_MAX = 40
const DESCRIPTION_MAX = 200
const PROMPT_MAX = 2000

const { t } = useI18n()
const confirmStore = useConfirmStore()

const isAvailable = ref(Boolean(window.mdDesktop?.ipCharacters))
const library = ref<DesktopIpLibrary>({ defaultId: null, characters: [] })
const isLoading = ref(false)
const loadError = ref(``)

// Cached by `${id}:${updatedAt}` using compact Blob object URLs so multi-MB base64 strings stay out of reactive state.
const imageCache = new Map<string, ManagedPreviewUrl | null>()
const imageRequests = new Map<string, Promise<string | null>>()
const imageById = shallowRef<Record<string, string | null>>({})

const editingId = ref<string | null>(null)
const editName = ref(``)
const editDescription = ref(``)
const editPrompt = ref(``)
const editError = ref(``)
const isSaving = ref(false)
const busyId = ref<string | null>(null)

let unsubscribe: (() => void) | null = null
let pushSeq = 0
let unmounted = false

const isBusy = computed(() => isSaving.value || busyId.value !== null)

const isEditValid = computed(() => {
  const nameLen = editName.value.trim().length
  const descLen = editDescription.value.trim().length
  const promptLen = editPrompt.value.trim().length
  return nameLen >= 1 && nameLen <= NAME_MAX
    && descLen <= DESCRIPTION_MAX
    && promptLen >= 1 && promptLen <= PROMPT_MAX
})

function imageCacheKey(character: DesktopIpCharacter): string {
  return `${character.id}:${character.updatedAt}`
}

function revokeCacheEntry(entry: ManagedPreviewUrl | null | undefined) {
  entry?.revoke?.()
}

async function syncImages(characters: DesktopIpCharacter[]) {
  const api = window.mdDesktop?.ipCharacters
  if (!api)
    return

  const activeKeys = new Set(characters.map(imageCacheKey))

  for (const [key, entry] of Array.from(imageCache.entries())) {
    if (!activeKeys.has(key)) {
      revokeCacheEntry(entry)
      imageCache.delete(key)
    }
  }

  const nextById: Record<string, string | null> = {}
  for (const character of characters) {
    const key = imageCacheKey(character)
    if (imageCache.has(key))
      nextById[character.id] = imageCache.get(key)?.url ?? null
    else if (character.id in imageById.value)
      nextById[character.id] = imageById.value[character.id]
  }
  imageById.value = nextById

  await Promise.all(characters.map(async (character) => {
    const key = imageCacheKey(character)
    if (imageCache.has(key))
      return

    let request = imageRequests.get(key)
    if (!request) {
      const pending = api.readImage(character.id).catch(() => null)
      imageRequests.set(key, pending)
      request = pending
    }

    const dataUrl = await request
    imageRequests.delete(key)
    if (unmounted || imageCache.has(key))
      return

    const current = library.value.characters.find(c => c.id === character.id)
    if (!current || imageCacheKey(current) !== key)
      return

    const managed = dataUrl ? createPreviewUrl(dataUrl) : null
    imageCache.set(key, managed)
    imageById.value = {
      ...imageById.value,
      [character.id]: managed?.url ?? null,
    }
  }))
}

function applyLibrary(next: DesktopIpLibrary) {
  library.value = next
  if (editingId.value && !next.characters.some(c => c.id === editingId.value))
    cancelEdit()
  void syncImages(next.characters)
}

onMounted(async () => {
  const api = window.mdDesktop?.ipCharacters
  isAvailable.value = Boolean(api)
  if (!api)
    return

  unsubscribe = api.onChanged((next) => {
    pushSeq += 1
    isLoading.value = false
    loadError.value = ``
    applyLibrary(next)
  })

  const seqBefore = pushSeq
  isLoading.value = true
  try {
    const initial = await api.list()
    if (!unmounted && pushSeq === seqBefore)
      applyLibrary(initial)
  }
  catch (error) {
    if (!unmounted && pushSeq === seqBefore)
      loadError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    if (!unmounted)
      isLoading.value = false
  }
})

onUnmounted(() => {
  unmounted = true
  unsubscribe?.()
  unsubscribe = null
  for (const entry of imageCache.values())
    revokeCacheEntry(entry)
  imageCache.clear()
  imageRequests.clear()
})

function startEdit(character: DesktopIpCharacter) {
  editingId.value = character.id
  editName.value = character.name
  editDescription.value = character.description
  editPrompt.value = character.prompt
  editError.value = ``
}

function cancelEdit() {
  editingId.value = null
  editName.value = ``
  editDescription.value = ``
  editPrompt.value = ``
  editError.value = ``
}

async function saveEdit(character: DesktopIpCharacter) {
  const api = window.mdDesktop?.ipCharacters
  if (!api || isBusy.value || !isEditValid.value)
    return

  const seqBefore = pushSeq
  isSaving.value = true
  editError.value = ``
  try {
    const next = await api.update(character.id, {
      name: editName.value.trim(),
      description: editDescription.value.trim(),
      prompt: editPrompt.value.trim(),
    })
    if (!unmounted) {
      cancelEdit()
      if (pushSeq === seqBefore)
        applyLibrary(next)
      toast.success(t(`common.saveSuccess`))
    }
  }
  catch (error) {
    if (!unmounted)
      editError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    if (!unmounted)
      isSaving.value = false
  }
}

async function handleSetDefault(character: DesktopIpCharacter) {
  const api = window.mdDesktop?.ipCharacters
  if (!api || isBusy.value)
    return

  const seqBefore = pushSeq
  busyId.value = character.id
  try {
    const next = await api.setDefault(character.id)
    if (!unmounted && pushSeq === seqBefore)
      applyLibrary(next)
  }
  catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
  finally {
    if (!unmounted)
      busyId.value = null
  }
}

function handleDelete(character: DesktopIpCharacter) {
  confirmStore.confirm({
    title: t(`preferences.ipCharacters.deleteTitle`),
    description: t(`preferences.ipCharacters.deleteConfirm`, { name: character.name }),
    confirmText: t(`preferences.ipCharacters.delete`),
    destructive: true,
    onConfirm: async () => {
      const api = window.mdDesktop?.ipCharacters
      if (!api || isBusy.value)
        return

      const seqBefore = pushSeq
      busyId.value = character.id
      try {
        const next = await api.remove(character.id)
        if (!unmounted) {
          if (editingId.value === character.id)
            cancelEdit()
          if (pushSeq === seqBefore)
            applyLibrary(next)
          toast.success(t(`common.deleteSuccess`))
        }
      }
      catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
      finally {
        if (!unmounted)
          busyId.value = null
      }
    },
  })
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="ip-character-settings">
    <!-- Desktop-only notice -->
    <div
      v-if="!isAvailable"
      data-testid="ip-characters-unavailable"
      class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
      style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
    >
      <Info class="mt-0.5 size-3.5 shrink-0" style="color: var(--dt-ink3)" />
      <span>{{ t('preferences.ipCharacters.desktopOnly') }}</span>
    </div>

    <template v-else>
      <!-- Load error banner -->
      <div
        v-if="loadError"
        data-testid="ip-characters-load-error"
        class="flex flex-col gap-1 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
        style="background-color: var(--dt-red-soft); color: var(--dt-red)"
      >
        <div class="font-medium">
          {{ t('preferences.ipCharacters.loadFailed') }}
        </div>
        <div class="break-words opacity-90">
          {{ loadError }}
        </div>
      </div>

      <!-- Initial loading indicator -->
      <div
        v-if="isLoading && library.characters.length === 0"
        class="flex items-center justify-center rounded-xl py-10"
        style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink3)"
      >
        <Loader2 class="size-4 animate-spin" />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="!loadError && library.characters.length === 0"
        data-testid="ip-characters-empty"
        class="flex flex-col items-center gap-2.5 rounded-xl px-6 py-8 text-center"
        style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
      >
        <div
          class="flex size-10 items-center justify-center rounded-full"
          style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
        >
          <Smile class="size-5" />
        </div>
        <div class="text-[14px] font-semibold" style="color: var(--dt-ink)">
          {{ t('preferences.ipCharacters.emptyTitle') }}
        </div>
        <p class="max-w-[460px] text-xs leading-relaxed" style="color: var(--dt-ink2)">
          {{ t('preferences.ipCharacters.emptyDescription') }}
        </p>
      </div>

      <!-- Character cards -->
      <div v-else-if="library.characters.length > 0" class="flex flex-col gap-3">
        <div
          v-for="character in library.characters"
          :key="character.id"
          data-testid="ip-character-card"
          :data-character-id="character.id"
          class="flex flex-col gap-3 rounded-xl p-4"
          style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
        >
          <div class="flex items-start gap-3.5">
            <!-- Character image or placeholder -->
            <div
              class="flex size-[72px] shrink-0 items-center justify-center overflow-hidden rounded-lg"
              style="background-color: var(--dt-subtle); border: 1px solid var(--dt-line)"
            >
              <img
                v-if="imageById[character.id]"
                :src="imageById[character.id]!"
                :alt="character.name"
                class="size-full object-cover"
              >
              <Smile
                v-else
                data-testid="ip-character-placeholder"
                class="size-6"
                style="color: var(--dt-ink3)"
              />
            </div>

            <!-- Name, default badge, description -->
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="truncate text-[14px] font-semibold" style="color: var(--dt-ink)">
                  {{ character.name }}
                </span>
                <span
                  v-if="character.id === library.defaultId"
                  data-testid="ip-character-default-badge"
                  class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                  style="
                    background-color: var(--dt-accent-soft);
                    color: var(--dt-accent);
                    border: 1px solid var(--dt-accent-line);
                  "
                >
                  <Star class="size-2.5 fill-current" />
                  <span>{{ t('preferences.ipCharacters.defaultBadge') }}</span>
                </span>
              </div>

              <p
                class="mt-1 text-xs leading-relaxed break-words"
                :style="{ color: character.description ? 'var(--dt-ink2)' : 'var(--dt-ink3)' }"
              >
                {{ character.description || t('preferences.ipCharacters.noDescription') }}
              </p>
            </div>

            <!-- Card actions -->
            <div class="flex shrink-0 flex-wrap items-center gap-1.5">
              <button
                v-if="character.id !== library.defaultId"
                type="button"
                data-testid="ip-character-set-default"
                :disabled="isBusy"
                class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
                style="background-color: var(--dt-canvas); color: var(--dt-ink); border: 1px solid var(--dt-line)"
                @click="handleSetDefault(character)"
              >
                <Star class="size-3" />
                <span>{{ t('preferences.ipCharacters.setDefault') }}</span>
              </button>

              <button
                v-if="editingId !== character.id"
                type="button"
                data-testid="ip-character-edit"
                :disabled="isBusy"
                class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
                style="background-color: var(--dt-canvas); color: var(--dt-ink2); border: 1px solid var(--dt-line)"
                @click="startEdit(character)"
              >
                <Pencil class="size-3" />
                <span>{{ t('preferences.ipCharacters.edit') }}</span>
              </button>

              <button
                type="button"
                data-testid="ip-character-delete"
                :disabled="isBusy"
                class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
                style="background-color: var(--dt-canvas); color: var(--dt-red); border: 1px solid var(--dt-line)"
                @click="handleDelete(character)"
              >
                <Trash2 class="size-3" />
                <span>{{ t('preferences.ipCharacters.delete') }}</span>
              </button>
            </div>
          </div>

          <!-- Inline edit form -->
          <div
            v-if="editingId === character.id"
            data-testid="ip-character-edit-form"
            class="flex flex-col gap-3 rounded-lg p-3"
            style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
          >
            <label class="flex flex-col gap-1">
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="font-medium" style="color: var(--dt-ink2)">
                  {{ t('preferences.ipCharacters.nameLabel') }}
                </span>
                <span style="color: var(--dt-ink3); font-family: var(--dt-mono)">
                  {{ editName.length }}/{{ NAME_MAX }}
                </span>
              </div>
              <input
                v-model="editName"
                type="text"
                autocomplete="off"
                :maxlength="NAME_MAX"
                data-testid="ip-character-edit-name"
                :placeholder="t('preferences.ipCharacters.namePlaceholder')"
                class="h-8 w-full rounded-lg px-2.5 text-[13px] outline-none"
                style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink)"
              >
            </label>

            <label class="flex flex-col gap-1">
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="font-medium" style="color: var(--dt-ink2)">
                  {{ t('preferences.ipCharacters.descriptionLabel') }}
                </span>
                <span style="color: var(--dt-ink3); font-family: var(--dt-mono)">
                  {{ editDescription.length }}/{{ DESCRIPTION_MAX }}
                </span>
              </div>
              <input
                v-model="editDescription"
                type="text"
                autocomplete="off"
                :maxlength="DESCRIPTION_MAX"
                data-testid="ip-character-edit-description"
                :placeholder="t('preferences.ipCharacters.descriptionPlaceholder')"
                class="h-8 w-full rounded-lg px-2.5 text-[13px] outline-none"
                style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink)"
              >
            </label>

            <label class="flex flex-col gap-1">
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="font-medium" style="color: var(--dt-ink2)">
                  {{ t('preferences.ipCharacters.promptLabel') }}
                </span>
                <span style="color: var(--dt-ink3); font-family: var(--dt-mono)">
                  {{ editPrompt.length }}/{{ PROMPT_MAX }}
                </span>
              </div>
              <textarea
                v-model="editPrompt"
                rows="4"
                :maxlength="PROMPT_MAX"
                data-testid="ip-character-edit-prompt"
                :placeholder="t('preferences.ipCharacters.promptPlaceholder')"
                class="w-full resize-y rounded-lg px-2.5 py-2 text-xs leading-relaxed outline-none"
                style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink)"
              />
            </label>

            <div
              v-if="editError"
              data-testid="ip-character-edit-error"
              class="rounded-lg px-3 py-2 text-xs break-words"
              style="background-color: var(--dt-red-soft); color: var(--dt-red)"
            >
              {{ editError }}
            </div>

            <div class="flex items-center justify-end gap-2 pt-0.5">
              <button
                type="button"
                data-testid="ip-character-edit-cancel"
                :disabled="isSaving"
                class="inline-flex h-7 cursor-pointer items-center rounded-lg px-3 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
                style="color: var(--dt-ink2)"
                @click="cancelEdit"
              >
                {{ t('preferences.ipCharacters.cancel') }}
              </button>
              <button
                type="button"
                data-testid="ip-character-edit-save"
                :disabled="isSaving || !isEditValid"
                class="inline-flex h-7 cursor-pointer items-center rounded-lg px-3.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
                @click="saveEdit(character)"
              >
                {{ t('preferences.ipCharacters.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
