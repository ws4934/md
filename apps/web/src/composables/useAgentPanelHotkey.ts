import { useAgentStore } from '@/stores/agent'

/** Register global Agent panel toggle shortcut Mod+J (Cmd+J / Ctrl+J) in desktop shell. */
export function useAgentPanelHotkey() {
  const agentStore = useAgentStore()

  function onKeydown(event: KeyboardEvent) {
    if (!window.mdDesktop?.isDesktop)
      return
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey)
      return
    if (event.key.toLowerCase() !== `j`)
      return
    if (document.querySelector(`[role="dialog"], [role="alertdialog"], [data-testid="desktop-settings-page"]`))
      return

    event.preventDefault()
    if (agentStore.isNewArticleHero) {
      agentStore.isNewArticleHero = false
      agentStore.setPanelOpen(true)
      return
    }
    agentStore.togglePanel()
  }

  onMounted(() => {
    document.addEventListener(`keydown`, onKeydown)
  })

  onBeforeUnmount(() => {
    document.removeEventListener(`keydown`, onKeydown)
  })
}
