<script setup lang="ts">
import type { AcpAgentStatus, AcpPermissionLevel } from '@md/shared/types'
import { Check, ChevronDown, Download, Plus, RefreshCw, Trash2 } from '@lucide/vue'
import { API_MODEL_AGENT_ID } from '@md/shared/types'
import { formatCliArgs, parseCliArgs } from '@md/shared/utils/cli-args'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAcpPermissionOptions } from '@/lib/agent/permission-options'
import { useAgentStore } from '@/stores/agent'
import AgentAvatar from './AgentAvatar.vue'

const emit = defineEmits<{
  openModelApi: []
}>()

const { t } = useI18n()
const agentStore = useAgentStore()

const { agents, settings, probeByAgent, probingAgents } = storeToRefs(agentStore)

const isDetecting = ref(false)
const configuringAgentId = ref<string | null>(null)
const editCommand = ref(``)
const editArgs = ref(``)

const showAddCustomForm = ref(false)
const customName = ref(``)
const customCommand = ref(``)
const customArgs = ref(``)

function statusSubtitle(agent: AcpAgentStatus): string {
  if (agent.id === API_MODEL_AGENT_ID) {
    if (agent.installed && agent.isDefault)
      return t(`agent.settings.configuredDefault`)
    if (agent.installed)
      return t(`agent.settings.configured`)
    return t(`agent.settings.notConfigured`)
  }
  if (agent.installing)
    return t(`agent.settings.installing`)
  if (agent.installed && agent.isDefault)
    return t(`agent.settings.installedDefault`)
  if (agent.installed)
    return t(`agent.settings.installed`)
  return t(`agent.settings.notInstalled`)
}

async function handleRedetect() {
  if (isDetecting.value)
    return
  isDetecting.value = true
  try {
    await agentStore.detectAgents()
  }
  finally {
    isDetecting.value = false
  }
}

function toggleConfigure(agent: AcpAgentStatus) {
  if (agent.id === API_MODEL_AGENT_ID) {
    emit(`openModelApi`)
    return
  }
  if (configuringAgentId.value === agent.id) {
    configuringAgentId.value = null
    return
  }
  configuringAgentId.value = agent.id
  editCommand.value = agent.command
  editArgs.value = formatCliArgs(agent.args)
}

async function saveAgentConfig(agent: AcpAgentStatus) {
  const command = editCommand.value.trim()
  if (!command)
    return
  const args = parseCliArgs(editArgs.value)
  const plainEnv = agent.env ? { ...agent.env } : undefined
  await agentStore.updateSettings({
    commandOverrides: {
      [agent.id]: { command, args, ...(plainEnv ? { env: plainEnv } : {}) },
    },
  })
  configuringAgentId.value = null
}

async function setAsDefault(agentId: string) {
  await agentStore.updateSettings({ defaultAgentId: agentId })
  await agentStore.selectAgentAndModel(agentId)
}

async function refreshModels(agentId: string) {
  const result = await agentStore.probeAgent(agentId, true)
  if (result?.error)
    toast.error(result.error)
}

async function handleRemoveCustom(agentId: string) {
  await agentStore.removeCustomAgent(agentId)
  if (configuringAgentId.value === agentId)
    configuringAgentId.value = null
}

async function submitCustomAgent() {
  const name = customName.value.trim()
  const command = customCommand.value.trim()
  if (!name || !command)
    return
  const args = parseCliArgs(customArgs.value)
  await agentStore.addCustomAgent({ name, command, args })
  customName.value = ``
  customCommand.value = ``
  customArgs.value = ``
  showAddCustomForm.value = false
  toast.success(t(`agent.settings.customAdded`))
}

const isDefaultPermOpen = ref(false)

const permissionLevelOptions = useAcpPermissionOptions(t)

const selectedDefaultPerm = computed(() =>
  permissionLevelOptions.value.find(o => o.id === settings.value.defaultPermissionLevel)
  ?? permissionLevelOptions.value[0],
)

async function selectDefaultPermission(level: AcpPermissionLevel) {
  isDefaultPermOpen.value = false
  await agentStore.updateSettings({ defaultPermissionLevel: level })
}

onMounted(() => {
  // Use cached agent list on open; only explicit "Re-detect" invalidates probes and spawns a login shell.
  void agentStore.refreshAgentsList()
})
</script>

<template>
  <div class="flex flex-col">
    <!-- Header row -->
    <div class="flex items-start justify-between gap-4">
      <div>
        <h3 class="text-lg font-bold tracking-tight" style="color: var(--dt-ink)">
          {{ t('agent.settings.title') }}
        </h3>
        <p class="mt-1 text-[13px]" style="color: var(--dt-ink3)">
          {{ t('agent.settings.subtitle') }}
        </p>
      </div>
      <button
        type="button"
        :disabled="isDetecting"
        class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
        style="
          background-color: var(--dt-surface);
          color: var(--dt-ink2);
          border: 1px solid var(--dt-line);
        "
        @click="handleRedetect"
      >
        <RefreshCw class="size-3" :class="{ 'animate-spin': isDetecting }" />
        <span>{{ t('agent.settings.redetect') }}</span>
      </button>
    </div>

    <!-- Agent rows -->
    <div class="mt-4 flex flex-col">
      <div
        v-for="(agent, idx) in agents"
        :key="agent.id"
        class="flex flex-col gap-2.5 py-3.5"
        :style="{
          borderBottom: idx === agents.length - 1 ? 'none' : '1px solid var(--dt-line)',
        }"
      >
        <div class="flex items-center gap-3">
          <AgentAvatar :avatar="agent.avatar" :size="32" />

          <div class="min-w-0 flex-1">
            <div class="truncate text-[13.5px] font-semibold" style="color: var(--dt-ink)">
              {{ agent.name }}
            </div>
            <div class="truncate text-xs" style="color: var(--dt-ink3)">
              {{ statusSubtitle(agent) }}
            </div>
          </div>

          <!-- Built-in API Model agent: optional Set Default + jump to Model API settings -->
          <div v-if="agent.id === API_MODEL_AGENT_ID" class="flex items-center gap-2">
            <button
              v-if="agent.installed && !agent.isDefault"
              type="button"
              class="inline-flex h-7 cursor-pointer items-center justify-center rounded-lg px-2.5 text-xs font-medium transition-opacity hover:opacity-85"
              style="
                background-color: var(--dt-surface);
                color: var(--dt-ink2);
                border: 1px solid var(--dt-line);
              "
              @click="setAsDefault(agent.id)"
            >
              {{ t('agent.settings.setDefault') }}
            </button>
            <button
              type="button"
              class="inline-flex h-7 cursor-pointer items-center justify-center rounded-lg px-3 text-xs font-semibold transition-opacity hover:opacity-85"
              style="
                background-color: var(--dt-surface);
                color: var(--dt-ink);
                border: 1px solid var(--dt-line);
              "
              @click="toggleConfigure(agent)"
            >
              {{ t('agent.settings.configure') }}
            </button>
          </div>

          <!-- Installing: Cancel -->
          <button
            v-else-if="agent.installing"
            type="button"
            class="cursor-pointer px-2 text-[12.5px] font-medium transition-opacity hover:opacity-80"
            style="color: var(--dt-ink3)"
            @click="agentStore.cancelInstall(agent.id)"
          >
            {{ t('agent.settings.cancel') }}
          </button>

          <!-- Installed: Configure -->
          <button
            v-else-if="agent.installed"
            type="button"
            class="inline-flex h-7 cursor-pointer items-center justify-center rounded-lg px-3 text-xs font-semibold transition-opacity hover:opacity-85"
            style="
              background-color: var(--dt-surface);
              color: var(--dt-ink);
              border: 1px solid var(--dt-line);
            "
            @click="toggleConfigure(agent)"
          >
            {{ t('agent.settings.configure') }}
          </button>

          <!-- Not installed with npm package: Install -->
          <button
            v-else-if="agent.installPackage"
            type="button"
            class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-opacity hover:opacity-90"
            style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
            @click="agentStore.installAgent(agent.id)"
          >
            <Download class="size-3.5" />
            <span>{{ t('agent.settings.install') }}</span>
          </button>

          <!-- Uninstalled without npm package (custom or native installer): Configure -->
          <button
            v-else
            type="button"
            class="inline-flex h-7 cursor-pointer items-center justify-center rounded-lg px-3 text-xs font-semibold"
            style="
              background-color: var(--dt-surface);
              color: var(--dt-ink);
              border: 1px solid var(--dt-line);
            "
            @click="toggleConfigure(agent)"
          >
            {{ t('agent.settings.configure') }}
          </button>
        </div>

        <!-- Streamed install progress bar -->
        <div v-if="agent.installing && agent.installProgress" class="flex flex-col gap-1.5 pl-11">
          <div class="h-1 w-full overflow-hidden rounded-full" style="background-color: var(--dt-subtle)">
            <div
              class="h-full rounded-full transition-all duration-200"
              :style="{
                width: `${Math.max(4, Math.min(100, agent.installProgress.percent))}%`,
                backgroundColor: 'var(--dt-accent)',
              }"
            />
          </div>
          <div
            class="truncate text-[11.5px]"
            style="font-family: var(--dt-mono); color: var(--dt-ink3)"
            :title="agent.installProgress.line"
          >
            {{ agent.installProgress.command }} · {{ agent.installProgress.percent }}%
          </div>
        </div>

        <!-- Inline configuration panel when "设置" is clicked -->
        <div
          v-if="configuringAgentId === agent.id"
          class="ml-11 flex flex-col gap-2.5 rounded-lg p-3"
          style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
        >
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label class="flex flex-col gap-1">
              <span class="text-[11.5px] font-medium" style="color: var(--dt-ink2)">
                {{ t('agent.settings.commandLabel') }}
              </span>
              <input
                v-model="editCommand"
                type="text"
                class="h-8 rounded-md px-2.5 text-xs outline-none"
                style="
                  background-color: var(--dt-surface);
                  color: var(--dt-ink);
                  border: 1px solid var(--dt-line);
                  font-family: var(--dt-mono);
                "
              >
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11.5px] font-medium" style="color: var(--dt-ink2)">
                {{ t('agent.settings.argsLabel') }}
              </span>
              <input
                v-model="editArgs"
                type="text"
                class="h-8 rounded-md px-2.5 text-xs outline-none"
                style="
                  background-color: var(--dt-surface);
                  color: var(--dt-ink);
                  border: 1px solid var(--dt-line);
                  font-family: var(--dt-mono);
                "
              >
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-2 pt-0.5">
            <button
              v-if="!agent.isDefault && agent.installed"
              type="button"
              class="inline-flex h-7 cursor-pointer items-center rounded-md px-2.5 text-xs font-medium"
              style="
                background-color: var(--dt-surface);
                color: var(--dt-ink);
                border: 1px solid var(--dt-line);
              "
              @click="setAsDefault(agent.id)"
            >
              {{ t('agent.settings.setDefault') }}
            </button>

            <button
              v-if="agent.installed"
              type="button"
              :disabled="probingAgents[agent.id]"
              class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2.5 text-xs font-medium disabled:opacity-50"
              style="
                background-color: var(--dt-surface);
                color: var(--dt-ink2);
                border: 1px solid var(--dt-line);
              "
              @click="refreshModels(agent.id)"
            >
              <RefreshCw class="size-3" :class="{ 'animate-spin': probingAgents[agent.id] }" />
              <span>
                {{ t('agent.settings.reprobe') }}
                <template v-if="probeByAgent[agent.id]?.models.length">
                  ({{ probeByAgent[agent.id].models.length }})
                </template>
              </span>
            </button>

            <button
              v-if="!agent.builtin"
              type="button"
              class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2.5 text-xs font-medium"
              style="color: var(--dt-red)"
              @click="handleRemoveCustom(agent.id)"
            >
              <Trash2 class="size-3" />
              <span>{{ t('agent.settings.deleteCustom') }}</span>
            </button>

            <span class="flex-1" />

            <button
              type="button"
              class="inline-flex h-7 cursor-pointer items-center rounded-md px-3 text-xs font-semibold"
              style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
              @click="saveAgentConfig(agent)"
            >
              {{ t('agent.settings.save') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add custom agent trigger & inline form -->
    <div class="mt-2">
      <button
        v-if="!showAddCustomForm"
        type="button"
        class="inline-flex h-9 cursor-pointer items-center gap-2 text-[13px] font-medium transition-opacity hover:opacity-80"
        style="color: var(--dt-accent)"
        @click="showAddCustomForm = true"
      >
        <Plus class="size-3.5" />
        <span>{{ t('agent.settings.addCustom') }}</span>
      </button>

      <div
        v-else
        class="mt-1 flex flex-col gap-2.5 rounded-xl p-3.5"
        style="background-color: var(--dt-canvas); border: 1px solid var(--dt-line)"
      >
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label class="flex flex-col gap-1">
            <span class="text-[11.5px] font-medium" style="color: var(--dt-ink2)">
              {{ t('agent.settings.customName') }}
            </span>
            <input
              v-model="customName"
              type="text"
              :placeholder="t('agent.settings.customNamePlaceholder')"
              class="h-8 rounded-md px-2.5 text-xs outline-none"
              style="background-color: var(--dt-surface); color: var(--dt-ink); border: 1px solid var(--dt-line)"
            >
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11.5px] font-medium" style="color: var(--dt-ink2)">
              {{ t('agent.settings.commandLabel') }}
            </span>
            <input
              v-model="customCommand"
              type="text"
              :placeholder="t('agent.settings.customCommandPlaceholder')"
              class="h-8 rounded-md px-2.5 text-xs outline-none"
              style="
                background-color: var(--dt-surface);
                color: var(--dt-ink);
                border: 1px solid var(--dt-line);
                font-family: var(--dt-mono);
              "
            >
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11.5px] font-medium" style="color: var(--dt-ink2)">
              {{ t('agent.settings.argsLabel') }}
            </span>
            <input
              v-model="customArgs"
              type="text"
              :placeholder="t('agent.settings.customArgsPlaceholder')"
              class="h-8 rounded-md px-2.5 text-xs outline-none"
              style="
                background-color: var(--dt-surface);
                color: var(--dt-ink);
                border: 1px solid var(--dt-line);
                font-family: var(--dt-mono);
              "
            >
          </label>
        </div>

        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="inline-flex h-7 cursor-pointer items-center rounded-md px-3 text-xs font-medium"
            style="color: var(--dt-ink2)"
            @click="showAddCustomForm = false"
          >
            {{ t('agent.settings.cancel') }}
          </button>
          <button
            type="button"
            :disabled="!customName.trim() || !customCommand.trim()"
            class="inline-flex h-7 cursor-pointer items-center rounded-md px-3 text-xs font-semibold disabled:opacity-40"
            style="background-color: var(--dt-ink); color: var(--dt-on-ink)"
            @click="submitCustomAgent"
          >
            {{ t('agent.settings.save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Permissions section -->
    <div class="mt-6">
      <div class="mb-1 text-xs font-semibold" style="color: var(--dt-ink3)">
        {{ t('agent.settings.permissionsSection') }}
      </div>

      <div class="flex items-center justify-between gap-4 py-3">
        <div class="min-w-0">
          <div class="text-[13.5px] font-medium" style="color: var(--dt-ink)">
            {{ t('agent.settings.defaultPermissionTitle') }}
          </div>
          <p class="mt-0.5 text-xs" style="color: var(--dt-ink3)">
            {{ t('agent.settings.defaultPermissionDesc') }}
          </p>
        </div>

        <Popover v-model:open="isDefaultPermOpen">
          <PopoverTrigger as-child>
            <button
              type="button"
              data-testid="settings-default-permission-select"
              class="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-opacity hover:opacity-85"
              style="
                background-color: var(--dt-surface);
                border: 1px solid var(--dt-line);
                color: var(--dt-ink);
              "
            >
              <component
                :is="selectedDefaultPerm.icon"
                class="size-3.5 shrink-0"
                :style="{ color: selectedDefaultPerm.danger ? 'var(--dt-red)' : 'var(--dt-ink2)' }"
              />
              <span :style="{ color: selectedDefaultPerm.danger ? 'var(--dt-red)' : 'var(--dt-ink)' }">
                {{ selectedDefaultPerm.title }}
              </span>
              <ChevronDown class="size-3.5 shrink-0" style="color: var(--dt-ink3)" />
            </button>
          </PopoverTrigger>

          <PopoverContent
            side="top"
            align="end"
            :side-offset="6"
            class="z-[220] flex w-[300px] flex-col gap-0.5 rounded-xl p-1.5"
            style="
              background-color: var(--dt-surface);
              border: 1px solid var(--dt-line);
              box-shadow: 0 16px 40px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
            "
          >
            <button
              v-for="opt in permissionLevelOptions"
              :key="opt.id"
              type="button"
              :data-testid="`settings-perm-option-${opt.id}`"
              class="flex min-h-[48px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors"
              :style="{
                backgroundColor: settings.defaultPermissionLevel === opt.id ? 'var(--dt-subtle)' : 'transparent',
              }"
              @click="selectDefaultPermission(opt.id)"
            >
              <component
                :is="opt.icon"
                class="size-4 shrink-0"
                :style="{ color: opt.danger ? 'var(--dt-red)' : 'var(--dt-ink2)' }"
              />
              <div class="min-w-0 flex-1">
                <div
                  class="truncate text-[13px] font-medium"
                  :style="{ color: opt.danger ? 'var(--dt-red)' : 'var(--dt-ink)' }"
                >
                  {{ opt.title }}
                </div>
                <div class="truncate text-[11.5px]" style="color: var(--dt-ink3)">
                  {{ opt.desc }}
                </div>
              </div>
              <Check
                v-if="settings.defaultPermissionLevel === opt.id"
                class="size-[15px] shrink-0"
                style="color: var(--dt-ink)"
              />
            </button>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  </div>
</template>
