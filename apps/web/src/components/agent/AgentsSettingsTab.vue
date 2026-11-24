<script setup lang="ts">
import type { AcpAgentStatus } from '@md/shared/types'
import { Download, Plus, RefreshCw, Trash2 } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { useAgentStore } from '@/stores/agent'
import AgentAvatar from './AgentAvatar.vue'

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
  if (configuringAgentId.value === agent.id) {
    configuringAgentId.value = null
    return
  }
  configuringAgentId.value = agent.id
  editCommand.value = agent.command
  editArgs.value = agent.args.join(` `)
}

async function saveAgentConfig(agent: AcpAgentStatus) {
  const command = editCommand.value.trim()
  if (!command)
    return
  const args = editArgs.value.trim() ? editArgs.value.trim().split(/\s+/) : []
  await agentStore.updateSettings({
    commandOverrides: {
      [agent.id]: { command, args, env: agent.env },
    },
  })
  await agentStore.detectAgents()
  configuringAgentId.value = null
}

async function setAsDefault(agentId: string) {
  await agentStore.updateSettings({ defaultAgentId: agentId })
  await agentStore.selectAgentAndModel(agentId)
}

async function refreshModels(agentId: string) {
  await agentStore.probeAgent(agentId, true)
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
  const args = customArgs.value.trim() ? customArgs.value.trim().split(/\s+/) : []
  await agentStore.addCustomAgent({ name, command, args })
  customName.value = ``
  customCommand.value = ``
  customArgs.value = ``
  showAddCustomForm.value = false
  toast.success(t(`agent.settings.customAdded`))
}

async function toggleReviewEdits(value: boolean) {
  await agentStore.updateSettings({ reviewEditsBeforeWriting: value })
}

async function toggleAskCommands(value: boolean) {
  await agentStore.updateSettings({ askBeforeRunningCommands: value })
}

onMounted(() => {
  void handleRedetect()
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

          <!-- Installing: Cancel -->
          <button
            v-if="agent.installing"
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

          <!-- Custom uninstalled: Configure -->
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
            {{ t('agent.settings.reviewEditsTitle') }}
          </div>
          <p class="mt-0.5 text-xs" style="color: var(--dt-ink3)">
            {{ t('agent.settings.reviewEditsDesc') }}
          </p>
        </div>
        <Switch
          id="pref-agent-review-edits"
          class="shrink-0"
          :model-value="settings.reviewEditsBeforeWriting"
          @update:model-value="toggleReviewEdits"
        />
      </div>

      <div class="flex items-center justify-between gap-4 py-3">
        <div class="min-w-0">
          <div class="text-[13.5px] font-medium" style="color: var(--dt-ink)">
            {{ t('agent.settings.askCommandsTitle') }}
          </div>
          <p class="mt-0.5 text-xs" style="color: var(--dt-ink3)">
            {{ t('agent.settings.askCommandsDesc') }}
          </p>
        </div>
        <Switch
          id="pref-agent-ask-commands"
          class="shrink-0"
          :model-value="settings.askBeforeRunningCommands"
          @update:model-value="toggleAskCommands"
        />
      </div>
    </div>
  </div>
</template>
