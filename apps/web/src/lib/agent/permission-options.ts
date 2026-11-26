import type { AcpPermissionLevel } from '@md/shared/types'
import type { ComputedRef } from 'vue'
import { NotebookPen, Shield, ShieldCheck, ShieldOff } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

export interface AcpPermissionOptionItem {
  id: AcpPermissionLevel
  icon: typeof Shield
  shortLabel: string
  title: string
  desc: string
  danger?: boolean
}

export function useAcpPermissionOptions(
  translate?: (key: string) => string,
): ComputedRef<AcpPermissionOptionItem[]> {
  const { t: i18nT, locale } = useI18n()
  const t = translate ?? i18nT
  return computed(() => {
    void locale.value
    return [
      {
        id: `ask`,
        icon: Shield,
        shortLabel: t(`agent.permissionMode.shortAsk`),
        title: t(`agent.permissionMode.askTitle`),
        desc: t(`agent.permissionMode.askDesc`),
      },
      {
        id: `auto_edits`,
        icon: ShieldCheck,
        shortLabel: t(`agent.permissionMode.shortAutoEdits`),
        title: t(`agent.permissionMode.autoEditsTitle`),
        desc: t(`agent.permissionMode.autoEditsDesc`),
      },
      {
        id: `plan`,
        icon: NotebookPen,
        shortLabel: t(`agent.permissionMode.shortPlan`),
        title: t(`agent.permissionMode.planTitle`),
        desc: t(`agent.permissionMode.planDesc`),
      },
      {
        id: `bypass`,
        icon: ShieldOff,
        shortLabel: t(`agent.permissionMode.shortBypass`),
        title: t(`agent.permissionMode.bypassTitle`),
        desc: t(`agent.permissionMode.bypassDesc`),
        danger: true,
      },
    ]
  })
}
