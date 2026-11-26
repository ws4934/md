import type { DesktopUpdateMode, DesktopUpdateState } from '@md/shared/types'
import type { QuitLocale } from './quit-guard'
import fs from 'node:fs'
import path from 'node:path'
import { isSafeExternalUrl } from './app-protocol'

/**
 * `install`: download in the background and restart into the update.
 * `notify`: only point at the release page, because Squirrel.Mac refuses to install into an unsigned app.
 */
export type UpdateMode = DesktopUpdateMode

export interface UpdateEnvironment {
  isPackaged: boolean
  isSmokeRun: boolean
  platform: NodeJS.Platform
  isAppImage: boolean
  macAutoInstall: boolean
}

/** Returns null where updates must not run: dev, smoke runs, and Linux builds that are not an AppImage. */
export function resolveUpdateMode(env: UpdateEnvironment): UpdateMode | null {
  if (!env.isPackaged || env.isSmokeRun)
    return null
  if (env.platform === `darwin`)
    return env.macAutoInstall ? `install` : `notify`
  if (env.platform === `win32` || (env.platform === `linux` && env.isAppImage))
    return `install`
  return null
}

/** CI sets `extraMetadata.mdAutoInstallUpdates` in the packaged package.json only for signed macOS builds. */
export function readMacAutoInstallFlag(appPath: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(appPath, `package.json`), `utf8`))?.mdAutoInstallUpdates
    return value === true || value === `true`
  }
  catch {
    return false
  }
}

/** `<repo>/releases/download/<tag>/<file>` → `<repo>/releases/tag/<tag>`; null for anything else. */
export function releasePageUrl(fileUrl: string | undefined): string | null {
  const page = fileUrl?.replace(/\/releases\/download\/([^/?#]+)\/[^/?#]+$/, `/releases/tag/$1`)
  return page && page !== fileUrl ? isSafeExternalUrl(page) : null
}

/** Background checks prompt once per version per run; manual checks always prompt. */
export function createUpdatePromptGate(): (version: string, manual: boolean) => boolean {
  const prompted = new Set<string>()
  return (version, manual) => {
    if (!manual && prompted.has(version))
      return false
    prompted.add(version)
    return true
  }
}

export type UpdaterStateEvent
  = | { type: `checking` }
    | { type: `available`, version: string, fileUrl?: string }
    | { type: `not-available` }
    | { type: `download-progress`, percent: number }
    | { type: `downloaded`, version: string }
    | { type: `error`, message: string }

export function createInitialUpdateState(currentVersion: string, mode: UpdateMode | null): DesktopUpdateState {
  return {
    supported: mode !== null,
    mode,
    currentVersion,
    status: `idle`,
  }
}

function normalizePercent(percent: number): number | undefined {
  if (!Number.isFinite(percent))
    return undefined
  return Math.min(100, Math.max(0, Math.round(percent)))
}

export function reduceUpdateState(state: DesktopUpdateState, event: UpdaterStateEvent): DesktopUpdateState {
  if (!state.supported || state.mode === null)
    return state

  const base = {
    supported: true as const,
    mode: state.mode,
    currentVersion: state.currentVersion,
  }

  switch (event.type) {
    case `checking`:
      return {
        ...base,
        status: `checking`,
      }
    case `not-available`:
      return {
        ...base,
        status: `not-available`,
      }
    case `available`: {
      if (state.mode === `notify`) {
        const releaseUrl = releasePageUrl(event.fileUrl) ?? undefined
        return {
          ...base,
          status: `available`,
          version: event.version,
          ...(releaseUrl ? { releaseUrl } : {}),
        }
      }
      // `install` mode enables `autoDownload`, so downloading begins right after `update-available`.
      return {
        ...base,
        status: `downloading`,
        version: event.version,
      }
    }
    case `download-progress`: {
      const percent = normalizePercent(event.percent) ?? state.percent
      return {
        ...base,
        status: `downloading`,
        ...(state.version ? { version: state.version } : {}),
        ...(percent !== undefined ? { percent } : {}),
      }
    }
    case `downloaded`:
      return {
        ...base,
        status: `downloaded`,
        version: event.version,
      }
    case `error`: {
      const error = event.message.trim()
      return {
        ...base,
        status: `error`,
        ...(error ? { error } : {}),
      }
    }
  }
}

export function areUpdateStatesEqual(a: DesktopUpdateState, b: DesktopUpdateState): boolean {
  return (
    a.supported === b.supported
    && a.mode === b.mode
    && a.currentVersion === b.currentVersion
    && a.status === b.status
    && a.version === b.version
    && a.percent === b.percent
    && a.releaseUrl === b.releaseUrl
    && a.error === b.error
  )
}

export interface UpdateCopy {
  menuLabel: string
  ok: string
  later: string
  restartNow: string
  download: string
  upToDate: string
  upToDateDetail: (version: string) => string
  available: (version: string) => string
  availableDetail: string
  downloading: (version: string) => string
  downloadingDetail: string
  downloaded: (version: string) => string
  downloadedDetail: string
  checkFailed: string
}

export const UPDATE_COPY: Record<QuitLocale, UpdateCopy> = {
  'zh-CN': {
    menuLabel: `检查更新…`,
    ok: `确定`,
    later: `稍后`,
    restartNow: `立即重启`,
    download: `下载`,
    upToDate: `已是最新版本`,
    upToDateDetail: v => `md ${v} 是当前最新版本。`,
    available: v => `发现新版本 md ${v}`,
    availableDetail: `前往发布页面下载新版本。`,
    downloading: v => `正在下载 md ${v}`,
    downloadingDetail: `更新正在后台下载，完成后会提示你重启。`,
    downloaded: v => `md ${v} 已下载完成`,
    downloadedDetail: `立即重启以完成安装，或在下次退出 md 时自动安装。`,
    checkFailed: `检查更新失败`,
  },
  'zh-TW': {
    menuLabel: `檢查更新…`,
    ok: `確定`,
    later: `稍後`,
    restartNow: `立即重新啟動`,
    download: `下載`,
    upToDate: `已是最新版本`,
    upToDateDetail: v => `md ${v} 是目前的最新版本。`,
    available: v => `發現新版本 md ${v}`,
    availableDetail: `前往發行頁面下載新版本。`,
    downloading: v => `正在下載 md ${v}`,
    downloadingDetail: `更新正在背景下載，完成後會提示你重新啟動。`,
    downloaded: v => `md ${v} 已下載完成`,
    downloadedDetail: `立即重新啟動以完成安裝，或在下次結束 md 時自動安裝。`,
    checkFailed: `檢查更新失敗`,
  },
  'en-US': {
    menuLabel: `Check for Updates…`,
    ok: `OK`,
    later: `Later`,
    restartNow: `Restart Now`,
    download: `Download`,
    upToDate: `You're up to date`,
    upToDateDetail: v => `md ${v} is the latest version.`,
    available: v => `md ${v} is available`,
    availableDetail: `Open the release page to download the new version.`,
    downloading: v => `Downloading md ${v}`,
    downloadingDetail: `The update is downloading in the background. You'll be asked to restart when it's ready.`,
    downloaded: v => `md ${v} has been downloaded`,
    downloadedDetail: `Restart now to install it, or it will be installed the next time you quit md.`,
    checkFailed: `Couldn't check for updates`,
  },
  'ja-JP': {
    menuLabel: `アップデートを確認…`,
    ok: `OK`,
    later: `後で`,
    restartNow: `今すぐ再起動`,
    download: `ダウンロード`,
    upToDate: `最新バージョンです`,
    upToDateDetail: v => `md ${v} は最新バージョンです。`,
    available: v => `md ${v} が利用可能です`,
    availableDetail: `リリースページから新しいバージョンをダウンロードしてください。`,
    downloading: v => `md ${v} をダウンロード中`,
    downloadingDetail: `アップデートをバックグラウンドでダウンロードしています。完了すると再起動を確認します。`,
    downloaded: v => `md ${v} のダウンロードが完了しました`,
    downloadedDetail: `今すぐ再起動してインストールするか、次回 md を終了したときに自動でインストールされます。`,
    checkFailed: `アップデートを確認できませんでした`,
  },
}
