import { useAgentStore } from '@/stores/agent'

/** Register global desktop sidebar toggle shortcut Mod+\ (Cmd+\ / Ctrl+\). */
export function useDesktopSidebarHotkey() {
  const agentStore = useAgentStore()

  function onKeydown(event: KeyboardEvent) {
    if (!window.mdDesktop?.isDesktop)
      return
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey)
      return
    if (event.key !== `\\` && event.code !== `Backslash`)
      return
    if (document.querySelector(`[role="dialog"], [role="alertdialog"], [data-testid="desktop-settings-page"]`))
      return

    event.preventDefault()
    agentStore.toggleSidebar()
  }

  onMounted(() => {
    document.addEventListener(`keydown`, onKeydown)
  })

  onBeforeUnmount(() => {
    document.removeEventListener(`keydown`, onKeydown)
  })
}
