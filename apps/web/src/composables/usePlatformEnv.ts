/** Detect uTools / Electron desktop and tag root element (sync during setup for early effect). */
export function usePlatformEnv() {
  if (window.__MD_UTOOLS__)
    document.documentElement.classList.add(`is-utools`)
  if (window.mdDesktop?.isDesktop) {
    document.documentElement.classList.add(`is-desktop`)
    if (window.mdDesktop.platform === `darwin`)
      document.documentElement.classList.add(`is-desktop-mac`)
  }
}
