<script setup lang="ts">
import type { DesktopSkill, DesktopSkillsApi } from '@md/shared/types'
import { Info, Loader2, Pencil, Plus, RotateCcw, Trash2 } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { useAgentStore } from '@/stores/agent'
import { useConfirmStore } from '@/stores/confirm'

// Bracketed error codes from the desktop skill store that have localized messages.
const ERROR_CODES = [`invalidName`, `invalidFrontMatter`, `nameMismatch`, `tooLarge`, `exists`]

const { t } = useI18n()
const confirmStore = useConfirmStore()
const agentStore = useAgentStore()
const api = window.mdDesktop?.skills

const skills = ref<DesktopSkill[]>([])
const isLoading = ref(false)
const loadError = ref(``)
const isBusy = ref(false)

const editingName = ref<string | null>(null)
const editContent = ref(``)
const editError = ref(``)

const isCreating = ref(false)
const newName = ref(``)
const createError = ref(``)

let unsubscribe: (() => void) | null = null

function errorText(error: unknown, name = ``): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = ERROR_CODES.find(c => message.includes(`[${c}]`))
  return code ? t(`preferences.skills.errors.${code}`, { name }) : message
}

onMounted(async () => {
  if (!api)
    return
  unsubscribe = api.onChanged((next) => {
    skills.value = next
    // Draft `/` commands come from cached probes; drop them so the next probe sees the new skill set.
    for (const agentId of Object.keys(agentStore.probeByAgent))
      agentStore.invalidateProbe(agentId)
  })
  isLoading.value = true
  try {
    skills.value = await api.list()
  }
  catch (error) {
    loadError.value = errorText(error)
  }
  finally {
    isLoading.value = false
  }
})

onUnmounted(() => {
  unsubscribe?.()
})

async function run(
  action: (skillsApi: DesktopSkillsApi) => Promise<DesktopSkill[]>,
  name: string,
  showError: (message: string) => void = message => toast.error(message),
): Promise<boolean> {
  if (!api || isBusy.value)
    return false
  isBusy.value = true
  try {
    skills.value = await action(api)
    return true
  }
  catch (error) {
    showError(errorText(error, name))
    return false
  }
  finally {
    isBusy.value = false
  }
}

function cancelEdit() {
  editingName.value = null
  editContent.value = ``
  editError.value = ``
}

async function startEdit(name: string) {
  if (!api)
    return
  try {
    editContent.value = await api.read(name)
    editingName.value = name
    editError.value = ``
  }
  catch (error) {
    toast.error(errorText(error, name))
  }
}

async function saveEdit(name: string) {
  editError.value = ``
  if (await run(skillsApi => skillsApi.save(name, editContent.value), name, (message) => {
    editError.value = message
  })) {
    cancelEdit()
    toast.success(t(`common.saveSuccess`))
  }
}

function openCreate() {
  isCreating.value = true
  newName.value = ``
  createError.value = ``
}

async function createSkill() {
  const name = newName.value.trim()
  if (!name)
    return
  createError.value = ``
  if (await run(skillsApi => skillsApi.create(name), name, (message) => {
    createError.value = message
  })) {
    isCreating.value = false
    await startEdit(name)
  }
}

function confirmReset(skill: DesktopSkill) {
  confirmStore.confirm({
    title: t(`preferences.skills.resetTitle`),
    description: t(`preferences.skills.resetConfirm`, { name: skill.name }),
    confirmText: t(`preferences.skills.reset`),
    destructive: true,
    onConfirm: async () => {
      if (await run(skillsApi => skillsApi.reset(skill.name), skill.name) && editingName.value === skill.name)
        cancelEdit()
    },
  })
}

function confirmDelete(skill: DesktopSkill) {
  confirmStore.confirm({
    title: t(`preferences.skills.deleteTitle`),
    description: t(`preferences.skills.deleteConfirm`, { name: skill.name }),
    confirmText: t(`common.delete`),
    destructive: true,
    onConfirm: async () => {
      if (!await run(skillsApi => skillsApi.remove(skill.name), skill.name))
        return
      if (editingName.value === skill.name)
        cancelEdit()
      toast.success(t(`common.deleteSuccess`))
    },
  })
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="skill-settings">
    <div
      class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
      style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
    >
      <Info class="mt-0.5 size-3.5 shrink-0" style="color: var(--dt-ink3)" />
      <span>{{ api ? t('preferences.skills.applyHint') : t('preferences.skills.desktopOnly') }}</span>
    </div>

    <template v-if="api">
      <div
        v-if="loadError"
        class="flex flex-col gap-1 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
        style="background-color: var(--dt-red-soft); color: var(--dt-red)"
      >
        <div class="font-medium">
          {{ t('preferences.skills.loadFailed') }}
        </div>
        <div class="break-words opacity-90">
          {{ loadError }}
        </div>
      </div>

      <!-- New skill -->
      <div
        v-if="isCreating"
        class="flex flex-col gap-2 rounded-xl p-4"
        style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
      >
        <input
          v-model="newName"
          type="text"
          autocomplete="off"
          spellcheck="false"
          data-testid="skill-new-name"
          :placeholder="t('preferences.skills.namePlaceholder')"
          class="h-8 w-full rounded-lg px-2.5 text-[13px] outline-none"
          style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line); color: var(--dt-ink); font-family: var(--dt-mono)"
          @keydown.enter.prevent="createSkill"
        >
        <div
          v-if="createError"
          class="rounded-lg px-3 py-2 text-xs break-words"
          style="background-color: var(--dt-red-soft); color: var(--dt-red)"
        >
          {{ createError }}
        </div>
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="inline-flex h-7 cursor-pointer items-center rounded-lg px-3 text-xs font-medium transition-opacity hover:opacity-80"
            style="color: var(--dt-ink2)"
            @click="isCreating = false"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            data-testid="skill-create"
            :disabled="isBusy || !newName.trim()"
            class="inline-flex h-7 cursor-pointer items-center rounded-lg px-3.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
            @click="createSkill"
          >
            {{ t('preferences.skills.create') }}
          </button>
        </div>
      </div>
      <div v-else class="flex justify-end">
        <button
          type="button"
          data-testid="skill-new"
          :disabled="isBusy"
          class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
          style="background-color: var(--dt-canvas); color: var(--dt-ink); border: 1px solid var(--dt-line)"
          @click="openCreate"
        >
          <Plus class="size-3" />
          <span>{{ t('preferences.skills.newSkill') }}</span>
        </button>
      </div>

      <div
        v-if="isLoading && skills.length === 0"
        class="flex items-center justify-center rounded-xl py-10"
        style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink3)"
      >
        <Loader2 class="size-4 animate-spin" />
      </div>

      <p
        v-else-if="!loadError && skills.length === 0"
        class="rounded-xl px-6 py-8 text-center text-xs leading-relaxed"
        style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink2)"
      >
        {{ t('preferences.skills.empty') }}
      </p>

      <div v-else class="flex flex-col gap-3">
        <div
          v-for="skill in skills"
          :key="skill.name"
          data-testid="skill-card"
          :data-skill-name="skill.name"
          class="flex flex-col gap-3 rounded-xl p-4"
          style="background-color: var(--dt-surface); border: 1px solid var(--dt-line)"
        >
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="truncate text-[14px] font-semibold" style="color: var(--dt-ink); font-family: var(--dt-mono)">
                  {{ skill.name }}
                </span>
                <span
                  class="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                  style="background-color: var(--dt-subtle); color: var(--dt-ink2)"
                >
                  {{ skill.source === 'bundled' ? t('preferences.skills.bundled') : t('preferences.skills.custom') }}
                </span>
                <span
                  v-if="skill.modified"
                  class="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                  style="background-color: var(--dt-accent-soft); color: var(--dt-accent); border: 1px solid var(--dt-accent-line)"
                >
                  {{ t('preferences.skills.modified') }}
                </span>
                <span
                  v-if="skill.bundledUpdated"
                  class="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                  style="background-color: var(--dt-accent-soft); color: var(--dt-accent); border: 1px solid var(--dt-accent-line)"
                >
                  {{ t('preferences.skills.bundledUpdated') }}
                </span>
                <span
                  v-if="skill.error"
                  class="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                  style="background-color: var(--dt-red-soft); color: var(--dt-red)"
                >
                  {{ t('preferences.skills.invalid') }}
                </span>
              </div>
              <p
                class="mt-1 line-clamp-2 text-xs leading-relaxed break-words"
                :style="{ color: skill.description ? 'var(--dt-ink2)' : 'var(--dt-ink3)' }"
              >
                {{ skill.description || t('preferences.skills.noDescription') }}
              </p>
              <p v-if="skill.error" class="mt-1 text-xs break-words" style="color: var(--dt-red)">
                {{ errorText(skill.error, skill.name) }}
              </p>
            </div>
            <Switch
              :model-value="skill.enabled"
              :disabled="isBusy"
              :aria-label="t('preferences.skills.toggle', { name: skill.name })"
              data-testid="skill-enabled"
              class="shrink-0"
              @update:model-value="(enabled: boolean) => run(skillsApi => skillsApi.setEnabled(skill.name, enabled), skill.name)"
            />
          </div>

          <div
            v-if="skill.bundledUpdated"
            class="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed"
            style="background-color: var(--dt-accent-soft); color: var(--dt-ink2)"
          >
            <span class="min-w-0 flex-1">{{ t('preferences.skills.bundledUpdatedHint') }}</span>
            <button
              type="button"
              :disabled="isBusy"
              class="inline-flex h-7 cursor-pointer items-center rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
              style="background-color: var(--dt-canvas); color: var(--dt-ink); border: 1px solid var(--dt-line)"
              @click="run(skillsApi => skillsApi.keepModified(skill.name), skill.name)"
            >
              {{ t('preferences.skills.keepMine') }}
            </button>
            <button
              type="button"
              :disabled="isBusy"
              class="inline-flex h-7 cursor-pointer items-center rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
              style="background-color: var(--dt-canvas); color: var(--dt-ink); border: 1px solid var(--dt-line)"
              @click="confirmReset(skill)"
            >
              {{ t('preferences.skills.useBundled') }}
            </button>
          </div>

          <!-- SKILL.md editor -->
          <div
            v-if="editingName === skill.name"
            class="flex flex-col gap-3 rounded-lg p-3"
            style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
          >
            <textarea
              v-model="editContent"
              rows="18"
              spellcheck="false"
              data-testid="skill-editor"
              :aria-label="`${skill.name}/SKILL.md`"
              class="w-full resize-y rounded-lg px-2.5 py-2 text-xs leading-relaxed outline-none"
              style="background-color: var(--dt-surface); border: 1px solid var(--dt-line); color: var(--dt-ink); font-family: var(--dt-mono)"
              @keydown.esc.prevent
            />
            <div
              v-if="editError"
              data-testid="skill-edit-error"
              class="rounded-lg px-3 py-2 text-xs break-words"
              style="background-color: var(--dt-red-soft); color: var(--dt-red)"
            >
              {{ editError }}
            </div>
            <div class="flex items-center justify-end gap-2">
              <button
                type="button"
                :disabled="isBusy"
                class="inline-flex h-7 cursor-pointer items-center rounded-lg px-3 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
                style="color: var(--dt-ink2)"
                @click="cancelEdit"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                type="button"
                data-testid="skill-save"
                :disabled="isBusy"
                class="inline-flex h-7 cursor-pointer items-center rounded-lg px-3.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
                @click="saveEdit(skill.name)"
              >
                {{ t('common.save') }}
              </button>
            </div>
          </div>

          <div v-else class="flex flex-wrap items-center justify-end gap-1.5">
            <button
              type="button"
              data-testid="skill-edit"
              :disabled="isBusy"
              class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
              style="background-color: var(--dt-canvas); color: var(--dt-ink2); border: 1px solid var(--dt-line)"
              @click="startEdit(skill.name)"
            >
              <Pencil class="size-3" />
              <span>{{ t('common.edit') }}</span>
            </button>
            <button
              v-if="skill.modified"
              type="button"
              data-testid="skill-reset"
              :disabled="isBusy"
              class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
              style="background-color: var(--dt-canvas); color: var(--dt-ink2); border: 1px solid var(--dt-line)"
              @click="confirmReset(skill)"
            >
              <RotateCcw class="size-3" />
              <span>{{ t('preferences.skills.reset') }}</span>
            </button>
            <button
              v-if="skill.source === 'custom'"
              type="button"
              data-testid="skill-delete"
              :disabled="isBusy"
              class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
              style="background-color: var(--dt-canvas); color: var(--dt-red); border: 1px solid var(--dt-line)"
              @click="confirmDelete(skill)"
            >
              <Trash2 class="size-3" />
              <span>{{ t('common.delete') }}</span>
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
