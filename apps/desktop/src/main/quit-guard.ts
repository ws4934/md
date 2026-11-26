import type { AcpActiveSessionSummary } from './acp/host'

export type QuitLocale = `zh-CN` | `zh-TW` | `en-US` | `ja-JP`

export interface QuitConfirmCopy {
  title: string
  detail: string
  confirmLabel: string
  cancelLabel: string
}

export interface PreventableEvent {
  preventDefault: () => void
}

export interface QuitGuardOptions {
  getActiveSessions: () => AcpActiveSessionSummary[]
  dispose: () => Promise<void>
  confirmQuit: (copy: QuitConfirmCopy) => Promise<boolean>
  quitApp: () => void
  forceExit: (code: number) => void
  getFallbackLocale?: () => string
  isSmokeRun?: () => boolean
  disposeTimeoutMs?: number
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 4_000

export function resolveQuitLocale(
  explicitLocale?: string | null,
  fallbackLocale?: string | null,
): QuitLocale {
  const candidates = [explicitLocale, fallbackLocale]
  for (const raw of candidates) {
    if (!raw || typeof raw !== `string`)
      continue
    const normalized = raw.trim().toLowerCase().replace(/_/g, `-`)
    if (!normalized)
      continue
    if (
      normalized === `zh-tw`
      || normalized === `zh-hk`
      || normalized === `zh-mo`
      || normalized.startsWith(`zh-hant`)
    ) {
      return `zh-TW`
    }
    if (normalized.startsWith(`zh`))
      return `zh-CN`
    if (normalized.startsWith(`ja`))
      return `ja-JP`
    if (normalized.startsWith(`en`))
      return `en-US`
  }
  return `en-US`
}

export function formatQuitConfirmCopy(
  locale: QuitLocale,
  activeSessions: AcpActiveSessionSummary[],
): QuitConfirmCopy {
  const uniqueNames = [...new Set(activeSessions.map(s => s.agentName.trim()).filter(Boolean))]
  const separator = locale === `en-US` ? `, ` : `、`
  const agents = uniqueNames.length > 0 ? uniqueNames.join(separator) : `Agent`
  const waitingPermission = activeSessions.some(s => s.waitingPermission)

  switch (locale) {
    case `zh-CN`:
      return {
        title: `Agent 仍在工作`,
        detail: waitingPermission
          ? `退出会停止 ${agents}，当前有操作正在等待你的确认，未完成的修改不会保存。`
          : `退出会停止 ${agents} 当前的任务，未完成的修改不会保存。`,
        confirmLabel: `退出`,
        cancelLabel: `取消`,
      }
    case `zh-TW`:
      return {
        title: `Agent 仍在工作`,
        detail: waitingPermission
          ? `結束會停止 ${agents}，目前有操作正在等待你的確認，未完成的修改不會儲存。`
          : `結束會停止 ${agents} 目前的任務，未完成的修改不會儲存。`,
        confirmLabel: `結束`,
        cancelLabel: `取消`,
      }
    case `ja-JP`:
      return {
        title: `Agent が作業中です`,
        detail: waitingPermission
          ? `終了すると ${agents} が停止します。確認待ちの操作があり、未完了の変更は保存されません。`
          : `終了すると ${agents} の現在のタスクが停止し、未完了の変更は保存されません。`,
        confirmLabel: `終了`,
        cancelLabel: `キャンセル`,
      }
    case `en-US`:
    default:
      return {
        title: `Agent is still working`,
        detail: waitingPermission
          ? `Quitting will stop ${agents}, which is waiting for your confirmation. Unfinished changes will not be saved.`
          : `Quitting will stop ${agents}'s current task. Unfinished changes will not be saved.`,
        confirmLabel: `Quit`,
        cancelLabel: `Cancel`,
      }
  }
}

/**
 * Coordinates both window `close` and app `before-quit` events with a single
 * state machine so confirmation shows at most once per quit attempt and
 * `acpHost.dispose()` always completes within a bounded timeout.
 */
export class QuitGuard {
  private readonly options: QuitGuardOptions
  private readonly disposeTimeoutMs: number
  private state: `idle` | `confirming` | `disposing` | `ready_to_quit` = `idle`
  private explicitLocale: string | null = null
  private nonInteractive = false
  private pendingQuit: (() => void) | null = null

  constructor(options: QuitGuardOptions) {
    this.options = options
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
  }

  get currentState(): `idle` | `confirming` | `disposing` | `ready_to_quit` {
    return this.state
  }

  get locale(): QuitLocale {
    return resolveQuitLocale(this.explicitLocale, this.options.getFallbackLocale?.())
  }

  setLocale(locale: string): void {
    if (typeof locale === `string` && locale.trim() && locale.length <= 32)
      this.explicitLocale = locale.trim()
  }

  handleWindowClose(event: PreventableEvent): void {
    this.handleInteractiveExit(event)
  }

  handleBeforeQuit(event: PreventableEvent): void {
    this.handleInteractiveExit(event)
  }

  /**
   * Runs the same confirm + dispose flow as a user quit, then calls `quit` instead of
   * `quitApp` (e.g. `autoUpdater.quitAndInstall()`). Ignored while a quit is already underway.
   */
  requestQuit(quit: () => void): void {
    if (this.state !== `idle`)
      return
    this.pendingQuit = quit
    this.handleInteractiveExit({ preventDefault: () => {} })
  }

  /**
   * Used for non-interactive shutdowns (SIGINT, SIGTERM, OS shutdown/session-end, smoke exit).
   * Skips any confirmation dialog, disposes active agents within the timeout, and quits.
   */
  requestNonInteractiveQuit(): void {
    this.nonInteractive = true
    this.pendingQuit = null
    if (this.state === `disposing` || this.state === `ready_to_quit`)
      return
    // A native modal sheet may already be blocking normal app.quit() if we were confirming.
    const forceAfterDispose = this.state === `confirming`
    this.beginDisposeAndQuit(forceAfterDispose)
  }

  private shouldSkipConfirmation(): boolean {
    return this.nonInteractive || Boolean(this.options.isSmokeRun?.())
  }

  private handleInteractiveExit(event: PreventableEvent): void {
    if (this.state === `ready_to_quit`)
      return

    event.preventDefault()

    // Already confirming or disposing (e.g. Cmd+Q triggers both before-quit and window close).
    if (this.state === `confirming` || this.state === `disposing`)
      return

    const activeSessions = this.options.getActiveSessions()
    if (activeSessions.length === 0 || this.shouldSkipConfirmation()) {
      this.beginDisposeAndQuit()
      return
    }

    this.state = `confirming`
    const copy = formatQuitConfirmCopy(this.locale, activeSessions)

    void this.options.confirmQuit(copy)
      .then((confirmed) => {
        if (this.state !== `confirming`)
          return
        if (!confirmed) {
          this.state = `idle`
          this.pendingQuit = null
          return
        }
        this.beginDisposeAndQuit()
      })
      .catch(() => {
        if (this.state === `confirming`) {
          this.state = `idle`
          this.pendingQuit = null
        }
      })
  }

  private finishQuit(forceAfterDispose: boolean, timedOut: boolean): void {
    this.state = `ready_to_quit`
    const pendingQuit = this.pendingQuit
    this.pendingQuit = null

    if (forceAfterDispose) {
      this.options.forceExit(0)
      return
    }
    if (pendingQuit) {
      try {
        pendingQuit()
      }
      catch {
        this.options.forceExit(0)
      }
      return
    }
    if (timedOut) {
      this.options.forceExit(0)
      return
    }
    this.options.quitApp()
  }

  private beginDisposeAndQuit(forceAfterDispose = false): void {
    if (this.state === `disposing` || this.state === `ready_to_quit`)
      return
    this.state = `disposing`

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.finishQuit(forceAfterDispose, true)
    }, this.disposeTimeoutMs)
    timer.unref?.()

    void Promise.resolve()
      .then(() => this.options.dispose())
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        if (timedOut)
          return
        this.finishQuit(forceAfterDispose, false)
      })
  }
}
